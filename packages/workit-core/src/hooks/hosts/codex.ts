// Codex CLI and Desktop: command hooks (hooks/hooks.json) mapped onto the protocol.
import type { HostDescriptor } from "../descriptor";
import type { HookDecision, HookEvent, HookEventKind, HostAdapter } from "../protocol";
import { commandText, existingDirectory, isRecord, nonEmpty, optionalText } from "./fields";

export type CodexHost = "codex_cli" | "codex_desktop";
export type CodexHookEvent = "SessionStart" | "PreToolUse" | "SubagentStart" | "SubagentStop";
type SessionSource = "startup" | "resume" | "clear" | "compact";

export type CodexHookInput = {
  hook_event_name: CodexHookEvent;
  session_id: string;
  cwd: string;
  model: string | null;
  permission_mode: string | null;
  transcript_path: string | null;
  source?: SessionSource;
  turn_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** The shell command as one string; argv arrays are joined. */
  command?: string;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string | null;
  last_assistant_message?: string | null;
  stop_hook_active?: boolean;
};

export type CodexParseResult = { ok: true; data: CodexHookInput } | { ok: false; error: string };

export function detectCodexSurface(env: NodeJS.ProcessEnv): CodexHost {
  return env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" ||
    Boolean(env.CODEX_ELECTRON_RESOURCES_PATH)
    ? "codex_desktop"
    : "codex_cli";
}

const undocumented = { support: "undocumented", native: null } as const;

export const CODEX_DESCRIPTOR: HostDescriptor = {
  host: "codex_cli",
  label: "Codex",
  verifiedAgainst: "codex-cli 0.153.4; Codex Desktop 26.901.20858",
  docs: ["https://developers.openai.com/codex/hooks"],
  transport: "hook-process",
  events: {
    "session.start": { support: "native", native: "SessionStart" },
    "context.turn": undocumented,
    "shell.pre": { support: "native", native: "PreToolUse" },
    "tool.pre": { support: "native", native: "PreToolUse" },
    // Codex PreToolUse intercepts shell calls, not apply_patch edits: the
    // before-write gate stays advisory rather than half-enforced.
    "write.pre": { support: "undocumented", native: null },
    "shell.post": undocumented,
    "subagent.start": { support: "native", native: "SubagentStart" },
    "subagent.stop": { support: "native", native: "SubagentStop" },
    "prompt.submit": undocumented,
    "compact.pre": { support: "none", native: null },
    stop: undocumented,
  },
  shellPolicy: { deny: "native", channel: "permissionDecision", failClosed: false },
  context: {
    sessionStart: "native",
    perTurn: "undocumented",
    afterCompact: "native",
    task: "single-active",
  },
  subagents: {
    identity: "native",
    parentBinding: "none",
    blockStart: "none",
    worktreeIsolation: "undocumented",
    maxConcurrency: "undocumented",
  },
  provenance: { sessionId: "native", agentIdOnTool: "partial", postToolObserve: "undocumented" },
  interaction: { questions: "none", writeBoundary: "partial" },
  stopControl: "undocumented",
  shellAvailable: "native",
  perEventCost: "low",
  capabilities: [
    {
      name: "known_product_writes",
      surface: "PreToolUse",
      refs: ["PreToolUse"],
      requires: [],
      assurance: "unavailable",
      reason: "file writes are host-policy; PreToolUse allows write tools",
    },
    {
      name: "fresh-context-review",
      surface: "SubagentStart",
      refs: ["SubagentStart"],
      requires: ["event:subagent.start"],
      observed: ["subagent.start"],
      assurance: "agent_guided",
      reason:
        "independent review runs as a bounded subagent; evidence evaluation enforces reviewer exclusivity, and stops remain untrusted",
      unavailableReason: "Codex subagent lifecycle hooks are unavailable for independent review",
    },
    {
      name: "native_subagents",
      surface: "SubagentStart/SubagentStop",
      refs: ["SubagentStart", "SubagentStop"],
      requires: ["event:subagent.start", "event:subagent.stop"],
      observed: ["subagent.start", "subagent.stop"],
      assurance: "agent_guided",
      reason: "Codex reports stable child identities, but cannot block creation",
      unavailableReason: "Codex subagent lifecycle hooks are untrusted or incomplete",
    },
    {
      name: "native_subagent_start",
      surface: "SubagentStart",
      refs: ["SubagentStart"],
      requires: ["event:subagent.start"],
      observed: ["subagent.start"],
      assurance: "agent_guided",
      reason:
        "SubagentStart supplies identity and bounded read-only guidance; continue:false cannot stop creation",
      unavailableReason: "SubagentStart hook is untrusted or unavailable",
    },
    {
      name: "arbitrary_shell_write",
      surface: "unobservable_shell",
      refs: ["PreToolUse"],
      requires: [],
      assurance: "unavailable",
      reason:
        "Only covered known tool inputs are interceptable; specialized and write_stdin paths are not complete",
    },
    {
      name: "compact_context",
      surface: "SessionStart",
      refs: ["SessionStart"],
      requires: ["context.afterCompact"],
      observed: ["session.start"],
      assurance: "agent_guided",
      reason: "SessionStart source=compact is the single restore path",
    },
  ],
};

export const codexDescriptor = (host: CodexHost): HostDescriptor => ({ ...CODEX_DESCRIPTOR, host });

const EVENTS: Record<CodexHookEvent, HookEventKind> = {
  SessionStart: "session.start",
  PreToolUse: "shell.pre",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
};
const SHELL_TOOLS = new Set(["bash", "unified-exec"]);
const isShellTool = (name: unknown) => SHELL_TOOLS.has(String(name).toLowerCase());
const SOURCES = new Set<string>(["startup", "resume", "clear", "compact"]);

/**
 * Read a Codex payload, checking only what each mapping needs (D17): the
 * event and cwd always, the shell command for shell tools, the tool name for
 * PreToolUse, and the agent id for SubagentStart. Every other field is
 * optional, and unknown keys or values (a new permission mode, say) are
 * ignored, so a Codex release can never turn branch policy off.
 */
export const parseCodexHookInput = (value: unknown): CodexParseResult => {
  if (!isRecord(value) || !Object.hasOwn(EVENTS, String(value.hook_event_name)))
    return { ok: false, error: "hook_event_name is required" };
  const event = value.hook_event_name as CodexHookEvent;
  const cwd = existingDirectory(value.cwd);
  if (!cwd) return { ok: false, error: "cwd must be an existing absolute directory" };
  if (event === "PreToolUse" && !nonEmpty(value.tool_name))
    return { ok: false, error: "tool_name is required" };
  const command = isRecord(value.tool_input) ? commandText(value.tool_input.command) : null;
  if (event === "PreToolUse" && isShellTool(value.tool_name) && !command)
    return { ok: false, error: "tool_input.command is required for shell tools" };
  if (event === "SubagentStart" && !nonEmpty(value.agent_id))
    return { ok: false, error: "agent_id is required" };
  return {
    ok: true,
    data: {
      hook_event_name: event,
      session_id: nonEmpty(value.session_id) ? value.session_id : "",
      model: optionalText(value.model),
      permission_mode: optionalText(value.permission_mode),
      transcript_path: optionalText(value.transcript_path),
      cwd,
      // An unknown start source restores context but never offers history.
      ...(event === "SessionStart"
        ? { source: SOURCES.has(String(value.source)) ? (value.source as SessionSource) : "resume" }
        : {}),
      ...(nonEmpty(value.turn_id) ? { turn_id: value.turn_id } : {}),
      ...(nonEmpty(value.tool_name) ? { tool_name: value.tool_name } : {}),
      ...(event === "PreToolUse" ? { tool_input: value.tool_input } : {}),
      ...(command ? { command } : {}),
      ...(nonEmpty(value.tool_use_id) ? { tool_use_id: value.tool_use_id } : {}),
      ...(nonEmpty(value.agent_id) ? { agent_id: value.agent_id } : {}),
      ...(nonEmpty(value.agent_type) ? { agent_type: value.agent_type } : {}),
      ...(event === "SubagentStop"
        ? {
            agent_transcript_path: optionalText(value.agent_transcript_path),
            last_assistant_message: optionalText(value.last_assistant_message),
            stop_hook_active: value.stop_hook_active === true,
          }
        : {}),
    },
  };
};

const protocolEvent = (input: CodexHookInput): HookEvent => {
  switch (input.hook_event_name) {
    case "SessionStart":
      return { kind: "session.start", source: input.source! };
    case "PreToolUse": {
      const toolUseId = input.tool_use_id ?? null;
      return isShellTool(input.tool_name)
        ? {
            kind: "shell.pre",
            command: input.command ?? "",
            toolUseId,
          }
        : { kind: "tool.pre", tool: input.tool_name!, toolUseId };
    }
    case "SubagentStart":
      return {
        kind: "subagent.start",
        agentId: input.agent_id!,
        agentType: input.agent_type ?? "unknown",
        task: null,
      };
    case "SubagentStop":
      return {
        kind: "subagent.stop",
        agentId: input.agent_id ?? null,
        agentType: input.agent_type ?? null,
        lastMessage: input.last_assistant_message ?? null,
        stopHookActive: input.stop_hook_active ?? false,
      };
  }
};

const output = (event: string, extra: Record<string, unknown> = {}) => ({
  hookSpecificOutput: { hookEventName: event, ...extra },
});

const render = (decision: HookDecision, native: string | null) => {
  if (native === "SubagentStop" || native === null) return { json: {}, exitCode: 0 };
  if (decision.kind === "deny")
    return {
      json: output(native, {
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      }),
      exitCode: 0,
    };
  if (decision.kind === "context")
    return { json: output(native, { additionalContext: decision.text }), exitCode: 0 };
  return { json: output(native), exitCode: 0 };
};

export const codexAdapter: HostAdapter = {
  descriptor: CODEX_DESCRIPTOR,
  parse(raw, env) {
    const host = detectCodexSurface(env);
    const parsed = parseCodexHookInput(raw);
    if (!parsed.ok) {
      const native =
        isRecord(raw) && Object.hasOwn(EVENTS, String(raw.hook_event_name))
          ? (raw.hook_event_name as CodexHookEvent)
          : null;
      return { ok: false, error: parsed.error, native, event: native ? EVENTS[native] : null };
    }
    const input = parsed.data;
    return {
      ok: true,
      native: input.hook_event_name,
      input: {
        host,
        cwd: input.cwd,
        session: {
          id: input.session_id,
          agentId: input.agent_id ?? null,
          agentType: input.agent_type ?? null,
          parentId: null,
        },
        permissionMode: input.permission_mode,
        transcriptPath: input.transcript_path,
        event: protocolEvent(input),
      },
    };
  },
  render,
  addendum: (input) =>
    `<workit-codex-mutations>Codex MCP is read-only: unattested callers cannot mutate. Run workit verbs with the workit CLI on the shell (node_modules/.bin/workit, or npx -y @brainervirus/workit-cli): check, git branch|commit|push, pr, ci, stack, ledger, handoff; task-family mutations take --json${input.session.id ? ` --actor ${input.session.id}` : ""}. A verifier or reviewer records workit ledger verdict under a session the lead assigns (WORKIT_SESSION_ID=<lead>-v<n>), never the author's. Merge and release need a workspace grant (workit grant show); a question answer is not host permission.</workit-codex-mutations>`,
};
