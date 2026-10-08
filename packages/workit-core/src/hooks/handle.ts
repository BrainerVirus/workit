// The one host-hook implementation: every host maps its native events here.
import {
  changedTurnContext,
  seedTurnContext,
  sessionContextText,
  turnContextText,
} from "./context";
import type { HostDescriptor, Support } from "./descriptor";
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
import { shellWrites, writeGate } from "./write-gate";
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

/** `<lead session>:<agent id>`, safe for the ledger's session grammar. */
const subagentSession = (session: string | null, agentId: string): string =>
  [session, agentId]
    .filter((part): part is string => Boolean(part))
    .join(":")
    .replace(/[^A-Za-z0-9_.:@/+-]/g, "-")
    .slice(0, 128);

const subagentStartText = (
  session: string | null,
  descriptor: HostDescriptor,
  event: Extract<HookInput["event"], { kind: "subagent.start" }>,
): string => {
  const role = workitRole(descriptor, event.agentType);
  const who = `${descriptor.label} subagent ${event.agentId} (${event.agentType})`;
  if (role === "implementer") {
    // Only a host that isolates subagents in worktrees has already put it in one.
    const where =
      descriptor.subagents.worktreeIsolation === "native"
        ? "working in its own git worktree: it may edit and commit there"
        : "as an implementer: it edits and commits only in its own git worktree (the lead makes one with `workit fanout worktree create <slice>`), never in the lead's checkout";
    return `Workit observed ${who} ${where}, within its brief's scope. Before the first commit, switch to a policy-compliant branch with \`workit git branch <branch> --base <base>\` (e.g. feature/<slug>); branch policy hooks still deny protected or non-compliant branches. Never record a verdict on your own work. Never push, open a PR, or merge unless the brief asks for it.`;
  }
  const readOnly = `Workit observed ${who} as read-only/agent-guided.`;
  if (role !== "judge" || !event.agentId) return readOnly;
  const own = subagentSession(session, event.agentId);
  return `${readOnly} Its own Workit session is ${own}: record verdicts with \`workit ledger verdict <result> --session ${own} ...\` so the ledger tells it apart from the author.`;
};

export function handleHook(input: HookInput, deps: HookDeps): HookDecision {
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
      const policy = canDeny ? shellPolicy(input.cwd, event.command) : NONE;
      if (policy.kind !== "none") return policy;
      // Without a post-tool event, the previous raw commit is recorded now.
      const postTool = usable(descriptor.events["shell.post"].support);
      if (!postTool) settlePendingCommit(input);
      const raw = canDeny ? rawGitPre(input, event.command) : NONE;
      if (raw.kind === "deny") return raw;
      const writes = usable(descriptor.events["write.pre"].support)
        ? shellWrites(event.command)
        : { writes: false, targets: null };
      const gate = writes.writes ? writeGate(input.cwd, writes.targets) : NONE;
      if (gate.kind === "deny") return gate;
      // The command will run: note HEAD so the post-tool hook (or the next
      // command, without one) can tell whether a raw commit moved it.
      noteRawCommit(
        input,
        event.command,
        postTool ? callKey(event.toolUseId, event.command) : NEXT_COMMAND,
      );
      return withContextLine(raw, shipNudge(input, event.command));
    }
    case "shell.post":
      if (usable(descriptor.events["shell.post"].support))
        rawGitPost(input, event.command, callKey(event.toolUseId, event.command));
      return NONE;
    case "write.pre":
      return usable(descriptor.events["write.pre"].support)
        ? writeGate(input.cwd, event.paths)
        : NONE;
    case "subagent.start":
      return {
        kind: "context",
        text: subagentStartText(input.session.id ?? null, descriptor, event),
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
    // Attestation, prompt and stop control arrive with the CLI-observed
    // evidence model.
    case "subagent.stop":
    case "prompt.submit":
    case "stop":
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
