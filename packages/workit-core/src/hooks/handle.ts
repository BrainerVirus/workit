// The one host-hook implementation: every host maps its native events here.
import { sessionContextText, turnContextText } from "./context";
import type { HostDescriptor, Support } from "./descriptor";
import { shellPolicy } from "./policy";
import type { HookDecision, HookEventKind, HookInput, HostAdapter, RenderedHook } from "./protocol";

export type HookDeps = { descriptor: HostDescriptor; addendum: string | null };

const usable = (value: Support) => value === "native" || value === "partial";
const NONE: HookDecision = { kind: "none" };

/** Sessions already offered unfinished tasks in this process. */
const offered = new Set<string>();

/** The Workit plugin's worktree-isolated implementer is the one Claude Code
 * subagent that writes. Claude namespaces plugin agents, so only the exact
 * `workit:implementer` is ours: a bare or other-plugin `implementer` is not. */
const CLAUDE_WORKTREE_IMPLEMENTER = "workit:implementer";

/** The plugin's read-only judges: each records verdicts as its own session. */
const CLAUDE_JUDGES: ReadonlySet<string> = new Set(["workit:verifier", "workit:reviewer"]);

/** `<lead session>:<agent id>`, safe for the ledger's session grammar. */
const subagentSession = (session: string | null, agentId: string): string =>
  [session, agentId]
    .filter((part): part is string => Boolean(part))
    .join(":")
    .replace(/[^A-Za-z0-9_.:@/+-]/g, "-")
    .slice(0, 128);

const subagentStartText = (
  host: HookInput["host"],
  session: string | null,
  descriptor: HostDescriptor,
  event: Extract<HookInput["event"], { kind: "subagent.start" }>,
): string => {
  if (host === "claude_code" && event.agentType === CLAUDE_WORKTREE_IMPLEMENTER)
    return `Workit observed ${descriptor.label} subagent ${event.agentId} (${event.agentType}) working in its own git worktree: it may edit and commit there, within its brief's scope. Before the first commit, switch to a policy-compliant branch with \`workit git branch <branch> --base <base>\` (e.g. feature/<slug>); branch policy hooks still deny protected or non-compliant branches. Never record a verdict on your own work. Never push, open a PR, or merge unless the brief asks for it.`;
  const readOnly = `Workit observed ${descriptor.label} subagent ${event.agentId} (${event.agentType}) as read-only/agent-guided; writer delegation is unavailable.`;
  if (
    host === "claude_code" &&
    event.agentType &&
    CLAUDE_JUDGES.has(event.agentType) &&
    event.agentId
  )
    return `${readOnly} Its own Workit session is ${subagentSession(session, event.agentId)}: record verdicts with \`workit ledger verdict <result> --session ${subagentSession(session, event.agentId)} ...\` so the ledger tells it apart from the author.`;
  return readOnly;
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
      return {
        kind: "context",
        text: sessionContextText(input, descriptor, { offer, addendum: deps.addendum }),
      };
    }
    case "context.turn": {
      if (!usable(descriptor.context.perTurn)) return NONE;
      const text = turnContextText(input, descriptor);
      return text ? { kind: "context", text } : NONE;
    }
    case "shell.pre":
      return usable(descriptor.shellPolicy.deny) ? shellPolicy(input.cwd, event.command) : NONE;
    case "subagent.start":
      return {
        kind: "context",
        text: subagentStartText(input.host, input.session.id ?? null, descriptor, event),
      };
    case "compact.pre":
      return {
        kind: "notice",
        userMessage:
          "Workit context may be stale after compaction; re-run inspection or resume before acting.",
      };
    // Host permission policy owns other tools; attestation, prompt and stop
    // control arrive with the CLI-observed evidence model.
    case "tool.pre":
    case "shell.post":
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
  if (event === "shell.pre" || event === "tool.pre")
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
