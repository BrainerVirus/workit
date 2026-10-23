// The one host-hook implementation: every host maps its native events here.
import {
  changedTurnContext,
  seedTurnContext,
  sessionContextText,
  turnContextText,
} from "./context";
import type { HostDescriptor, Support } from "./descriptor";
import { branchGuidance } from "../core/branch";
import { workspaceTrailers } from "../core/workspaces";
import { judgeBranch, recordIssuedSession, verdictCommand } from "../host-session";
import { cwdRewrite } from "./cwd-normalize";
import { heavyDenial, heavyGate, rewriteNote, splitDenial } from "./heavy-gate";
import { shellPolicy } from "./policy";
import {
  callKey,
  NEXT_COMMAND,
  noteRawCommit,
  rawGitPost,
  rawGitPre,
  settlePendingCommit,
} from "./raw-git";
import {
  promptNudge,
  recordSkillLoad,
  shipNudge,
  skillReadIn,
  withContextLine,
} from "./skill-nudge";
import { seedStanding, standingDelta } from "./standing";
import { trackJudge } from "./session-marker";
import { stopDecision } from "./stop";
import { liveOwner } from "../core/live-session";
import { liveTargets, shellGate, writeGate } from "./write-gate";
import { confineImplementer, confineImplementerShell, hostIsolated } from "./worktree-confine";
import type { HookDecision, HookEventKind, HookInput, HostAdapter, RenderedHook } from "./protocol";

export type HookDeps = { descriptor: HostDescriptor; addendum: string | null };

const usable = (value: Support) => value === "native" || value === "partial";
const NONE: HookDecision = { kind: "none" };

const resendsOnChange = (descriptor: HostDescriptor): boolean =>
  descriptor.context.turnResend === "on-change" && usable(descriptor.context.perTurn);

/** Sessions already offered unfinished tasks in this process. */
const offered = new Set<string>();

const ROLES: Readonly<Record<string, "implementer" | "judge">> = {
  implementer: "implementer",
  verifier: "judge",
  reviewer: "judge",
};

/**
 * The Workit agent role an agent type names, spelled the host's way
 * (`descriptor.subagents.agentPrefix`): Claude Code namespaces plugin agents
 * (`workit:implementer`, so a bare `workit-implementer` is someone else's);
 * other hosts name custom agents freely (`workit-implementer`). The
 * implementer is the one subagent that writes; verifier and reviewer are
 * read-only judges that record verdicts as their own session.
 */
const workitRole = (
  descriptor: HostDescriptor,
  agentType: string,
): "implementer" | "judge" | null => {
  const prefix = descriptor.subagents.agentPrefix;
  const name = agentType.startsWith(prefix) ? agentType.slice(prefix.length) : "";
  return Object.hasOwn(ROLES, name) ? ROLES[name] : null;
};

/** A tool call made by a Workit implementer subagent (the host names its agent type). */
const implementerAgent = (input: HookInput, descriptor: HostDescriptor): boolean =>
  Boolean(input.session.agentId) &&
  input.session.agentType !== null &&
  workitRole(descriptor, input.session.agentType) === "implementer";

/** `<lead session>:<agent id>`, safe for the ledger's session grammar. */
const subagentSession = (session: string | null, agentId: string): string =>
  [session, agentId]
    .filter((part): part is string => Boolean(part))
    .join(":")
    .replace(/[^A-Za-z0-9_.:@/+-]/g, "-")
    .slice(0, 128);

/** A Claude Code worktree path: `<repo>/.claude/worktrees/<name>`. */
const CLAUDE_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/;

/**
 * Claude Code's worktree isolation refuses any command that wraps git
 * (`workit git …` included) and cannot be turned off, so an isolated agent
 * runs git itself and workit for everything else.
 */
const isolatedGit = (cwd: string): string =>
  `Run git as plain, separate commands inside your worktree (\`git switch -c <branch> <base>\`, ${
    workspaceTrailers(cwd).enabled
      ? '`git commit --trailer "Workit-Session=<your session>"`, `git push`; `workit doctor --fix` can install a prepare-commit-msg hook that adds the trailer'
      : "`git commit` (this workspace sets trailers: false: add no Workit-Session trailer), `git push`"
  }; add Co-Authored-By with \`git commit --trailer\` in the same commit, never by amending), never \`workit git …\`: Claude Code's worktree isolation refuses a command that wraps git and cannot be turned off (https://code.claude.com/docs/en/worktrees#how-claude-code-enforces-isolation). Never dodge that check by renaming or re-wrapping git. Use workit for the non-git verbs (\`workit check\`, \`workit ledger\`, \`workit pr\`).`;

const subagentStartText = (
  input: HookInput,
  descriptor: HostDescriptor,
  event: Extract<HookInput["event"], { kind: "subagent.start" }>,
): string => {
  const session = input.session.id ?? null;
  const role = workitRole(descriptor, event.agentType);
  const who = `${descriptor.label} subagent ${event.agentId} (${event.agentType})`;
  // An implementer is host-isolated only when the host put it in its own
  // worktree (`.claude/worktrees/agent-<id>`); by default the lead makes one.
  const isolated =
    descriptor.subagents.worktreeIsolation === "native" &&
    (role === "implementer"
      ? hostIsolated(input.cwd, event.agentId)
      : CLAUDE_WORKTREE.test(input.cwd));
  const guide = role === "implementer" ? branchGuidance(input.cwd) : null;
  if (role === "implementer" && isolated)
    return `Workit observed ${who} working in its own git worktree: it may edit and commit there, within its brief's scope. ${isolatedGit(input.cwd)} Plain git is expected here, and the branch name is still policy-checked: a raw \`git switch -c\`, \`git checkout -b\`, \`git branch\` or \`git worktree add -b\` onto a protected or non-compliant name is denied, so use a policy-compliant branch.${guide ? ` ${guide}` : " (e.g. feature/<slug>)"} Never record a verdict on your own work. Never push, open a PR, or merge unless the brief asks for it.`;
  if (isolated)
    return `${isolatedGit(input.cwd)}\n${subagentStartText({ ...input, cwd: "" }, descriptor, event)}`;
  if (role === "implementer")
    // No host isolation: the lead makes the worktree, Workit's hooks confine
    // the implementer to it (worktree-confine.ts), and workit git works there.
    return `Workit observed ${who} as an implementer: it edits and commits only in its own git worktree, the one its brief names (the lead makes it with \`workit fanout worktree create <slice>\` before spawning), never in the lead's checkout, within its brief's scope. Workit binds it to the first Workit worktree it changes: from then on an edit or a mutating git command outside that worktree is denied, and before then so is one outside every Workit worktree. Run Workit against the worktree one verb per call, never \`cd … &&\` chains or \`$VAR\` paths: \`workit --cwd <worktree> git commit -m "<message>" -- <paths>\`, \`workit --cwd <worktree> check <name>\`. The worktree is on the brief's branch once the lead made it; otherwise switch with \`workit --cwd <worktree> git branch <branch> --base <base>\` (or \`--kind <kind> --slug <slug>\`, which picks the base); branch policy hooks still deny protected or non-compliant branches, raw git included.${guide ? ` ${guide}` : " (e.g. feature/<slug>)"} Never record a verdict on your own work. Never push, open a PR, or merge unless the brief asks for it.`;
  const readOnly = `Workit observed ${who} as read-only/agent-guided.`;
  if (role !== "judge" || !event.agentId) return readOnly;
  const own = subagentSession(session, event.agentId);
  // `ledger verdict` accepts `<lead>:<agent id>` only when this hook issued it,
  // and only with the token it hands to this subagent alone.
  // (An isolated judge's text is rebuilt with cwd "": the hook's own cwd then.)
  // Issued once: a replayed SubagentStart for the same id gets no token.
  const cwd = input.cwd || process.cwd();
  const token = session ? recordIssuedSession(cwd, session, own) : null;
  // Already issued: without its token the id is refused (unbound_session).
  if (session && !token)
    return `${readOnly} ${own} was already issued to an earlier subagent, so no token is handed out again and a verdict under it would be refused (unbound_session). Record no verdict as ${own}: spawn a fresh verifier or reviewer, which gets its own session and token.`;
  const judge = event.agentType.endsWith("reviewer") ? "reviewer" : "verifier";
  const line = verdictCommand({ branch: judgeBranch(cwd), judge, session: own, token });
  const pick = judge === "verifier" ? ", --kind live when you drove the real surface" : "";
  return `${readOnly} Its own Workit session is ${own}, so the ledger tells its verdicts apart from the author's. Record the verdict with exactly this command (pick the result${pick}, name the candidate branch if it differs, say what you ran): \`${line}\`.${token ? " The token is this subagent's alone: never write it into a report, a file or a commit. --token needs a workit CLI at least as new as this plugin; if the CLI answers that --token is an unknown option, update the workit CLI (workit upgrade --cli) and record again." : ""}`;
};

const PRE_TOOL = new Set<HookEventKind>(["shell.pre", "write.pre", "tool.pre"]);

/**
 * A running worker's standing-order delta rides any pre-tool answer that lets
 * the call run. In-process hosts deliver it on their own channel (OpenCode's
 * system context, Pi's tool result), so it is never spent here for them.
 */
export function handleHook(input: HookInput, deps: HookDeps): HookDecision {
  const decision = decide(input, deps);
  if (
    deps.descriptor.transport !== "hook-process" ||
    !PRE_TOOL.has(input.event.kind) ||
    decision.kind === "deny"
  )
    return decision;
  const delta = standingDelta(input);
  if (!delta) return decision;
  return decision.kind === "rewrite"
    ? { ...decision, text: [decision.text, delta].filter(Boolean).join("\n") }
    : withContextLine(decision, delta);
}

function decide(input: HookInput, deps: HookDeps): HookDecision {
  const { descriptor } = deps;
  const event = input.event;
  switch (event.kind) {
    case "session.start": {
      if (!usable(descriptor.context.sessionStart)) return NONE;
      // A session without an id cannot be told apart from another one, so it
      // is offered on every startup and never recorded.
      const key = input.session.id ? `${input.host}\0${input.session.id}` : null;
      const offer = event.source === "startup" && (key === null || !offered.has(key));
      if (offer && key !== null) offered.add(key);
      const advisory = usable(descriptor.events["write.pre"].support)
        ? null
        : `Workit cannot gate file writes on ${descriptor.label} (no pre-write hook): before-write requirements (an open product choice, a missing plan) are advisory here, so settle them before editing.`;
      const addendum = [deps.addendum, advisory].filter(Boolean).join("\n") || null;
      const text = sessionContextText(input, descriptor, { offer, addendum });
      if (resendsOnChange(descriptor)) seedTurnContext(input, descriptor);
      return { kind: "context", text };
    }
    case "context.turn": {
      if (!usable(descriptor.context.perTurn)) return NONE;
      const current = turnContextText(input, descriptor);
      const text = resendsOnChange(descriptor) ? changedTurnContext(input, current) : current;
      return withContextLine(
        text ? { kind: "context", text } : NONE,
        promptNudge(input, event.prompt),
      );
    }
    case "shell.pre": {
      const skillRead = skillReadIn(event.command, event.dialect);
      if (skillRead) recordSkillLoad(input, skillRead, "read");
      const canDeny = usable(descriptor.shellPolicy.deny);
      const policy = canDeny ? shellPolicy(input.cwd, event.command, event.dialect) : NONE;
      if (policy.kind !== "none") return policy;
      // Without a post-tool event, the previous raw commit is recorded now.
      const postTool = usable(descriptor.events["shell.post"].support);
      if (!postTool) settlePendingCommit(input);
      const raw = canDeny ? rawGitPre(input, event.command, { nudge: false }) : NONE;
      if (raw.kind === "deny") return raw;
      // An implementer subagent stays in its Workit worktree (#310).
      if (canDeny && implementerAgent(input, descriptor)) {
        const confined = confineImplementerShell(input, event.command, event.dialect);
        if (confined.kind === "deny") return confined;
      }
      // The before-write gate and the live-session guard (#274).
      const gate = usable(descriptor.events["write.pre"].support)
        ? shellGate(input.cwd, event.command, liveOwner(input, descriptor.transport), event.dialect)
        : NONE;
      if (gate.kind === "deny") return gate;
      // A heavy command runs under the machine lease: rewritten where the
      // host can replace the command, else denied with the exact rewrite.
      // Every gate above passed on the original command (ruling mvid5onk).
      const plan = heavyGate(input.cwd, event.command, {
        host: input.host,
        dialect: event.dialect,
        permissionMode: input.permissionMode,
      });
      if (plan.kind === "split" && canDeny) return splitDenial(plan);
      const rewrites = usable(descriptor.shellPolicy.rewrite);
      if (plan.kind === "rewrite" && !rewrites && canDeny) return heavyDenial(event.command, plan);
      const lease = plan.kind === "rewrite" && rewrites ? plan : null;
      // `cd <dir> && workit …` becomes `workit --cwd <dir> …` (issue #388). A
      // workit command is never heavy itself, so the lease plan wins when set.
      const cwdCommand =
        !lease && rewrites && input.host === "claude_code" ? cwdRewrite(event.command) : null;
      const aside = plan.kind === "passthrough" ? plan.note : null;
      // The command will run: note HEAD so the post-tool hook (or the next
      // command, without one) can tell whether a raw commit moved it.
      noteRawCommit(
        input,
        event.command,
        postTool ? callKey(event.toolUseId, event.command) : NEXT_COMMAND,
      );
      const rewrittenTo = lease?.command ?? cwdCommand;
      const rewritten = (text: string | null): HookDecision =>
        rewrittenTo
          ? {
              kind: "rewrite",
              command: rewrittenTo,
              input: event.toolInput ? { ...event.toolInput, command: rewrittenTo } : null,
              text,
            }
          : NONE;
      // An in-process plugin shows nudges on the tool result (shellNudge):
      // spending the once-per-session nudge here would lose it.
      if (descriptor.transport !== "hook-process") return rewritten(null);
      const nudged = withContextLine(
        withContextLine(canDeny ? rawGitPre(input, event.command) : NONE, aside),
        shipNudge(input, event.command),
      );
      // A deny always wins over the cwd rewrite.
      if (!lease)
        return cwdCommand && nudged.kind !== "deny"
          ? rewritten(nudged.kind === "context" ? nudged.text : null)
          : nudged;
      return rewritten(
        [rewriteNote(lease), nudged.kind === "context" ? nudged.text : null]
          .filter(Boolean)
          .join("\n"),
      );
    }
    case "shell.post":
      if (usable(descriptor.events["shell.post"].support))
        rawGitPost(input, event.command, callKey(event.toolUseId, event.command));
      return NONE;
    case "write.pre": {
      if (!usable(descriptor.events["write.pre"].support)) return NONE;
      if (implementerAgent(input, descriptor)) {
        const confined = confineImplementer(input, liveTargets(input.cwd, event.paths));
        if (confined.kind === "deny") return confined;
      }
      return writeGate(input.cwd, event.paths, liveOwner(input, descriptor.transport));
    }
    case "subagent.start":
      if (workitRole(descriptor, event.agentType) === "judge")
        trackJudge(input, event.agentId, true);
      seedStanding({ ...input, session: { ...input.session, agentId: event.agentId } });
      return {
        kind: "context",
        text: subagentStartText(input, descriptor, event),
      };
    case "compact.pre":
      return {
        kind: "notice",
        userMessage:
          "Workit context may be stale after compaction; re-run inspection or resume before acting.",
      };
    case "tool.pre":
      // Host permission policy owns other tools; a skill load is recorded.
      if (event.skill) recordSkillLoad(input, event.skill, "tool");
      return NONE;
    case "stop":
      return usable(descriptor.events.stop.support) ? stopDecision(input, descriptor) : NONE;
    // A subagent's stop is never blocked; attestation and prompt control
    // arrive with the CLI-observed evidence model.
    case "subagent.stop":
      trackJudge(input, event.agentId, false);
      return NONE;
    case "prompt.submit":
      return NONE;
  }
}

/**
 * Fail policy for a hook that cannot be parsed or handled: a pre-tool gate
 * denies only on hosts whose descriptor declares it fail-closed; start events
 * keep a visible diagnostic; everything else fails open.
 */
export const failureDecision = (
  descriptor: HostDescriptor,
  event: HookEventKind | null,
  error: string,
): HookDecision => {
  if (event === "shell.pre" || event === "tool.pre" || event === "write.pre")
    return descriptor.shellPolicy.failClosed
      ? { kind: "deny", reason: error, unblock: null }
      : NONE;
  if (event === "session.start" || event === "subagent.start")
    return { kind: "context", text: `[workit diagnostic: ${error}]` };
  return NONE;
};

/** Parse, handle, and render one native payload. `error` is set on any failure. */
export const dispatchHook = (
  adapter: HostAdapter,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): RenderedHook & { error: string | null } => {
  const parsed = adapter.parse(raw, env);
  if (!parsed.ok)
    return {
      ...adapter.render(
        failureDecision(adapter.descriptor, parsed.event, parsed.error),
        parsed.native,
      ),
      error: parsed.error,
    };
  const descriptor = { ...adapter.descriptor, host: parsed.input.host };
  try {
    const decision = handleHook(parsed.input, {
      descriptor,
      addendum: adapter.addendum?.(parsed.input) ?? null,
    });
    return { ...adapter.render(decision, parsed.native), error: null };
  } catch (error) {
    const message = `hook failure: ${String(error)}`;
    return {
      ...adapter.render(
        failureDecision(descriptor, parsed.input.event.kind, message),
        parsed.native,
      ),
      error: message,
    };
  }
};
