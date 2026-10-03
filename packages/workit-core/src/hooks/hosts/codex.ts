// Codex CLI and Desktop: command hooks (hooks/hooks.json) mapped onto the protocol.
import type { HostDescriptor } from "../descriptor";
import type { HookDecision, HookEvent, HookEventKind, HostAdapter } from "../protocol";
import { existingDirectory, isRecord, nonEmpty } from "./fields";

export type CodexHost = "codex_cli" | "codex_desktop";
export type CodexHookEvent = "SessionStart" | "PreToolUse" | "SubagentStart" | "SubagentStop";
type SessionSource = "startup" | "resume" | "clear" | "compact";
type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

export type CodexHookInput = {
  hook_event_name: CodexHookEvent;
  session_id: string;
  cwd: string;
  model: string;
  permission_mode: PermissionMode;
  transcript_path: string | null;
  source?: SessionSource;
  turn_id?: string;
  tool_name?: string;
  tool_input?: unknown;
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
      name: "interactive_decision",
      surface: "Question",
      refs: ["Question"],
      requires: [],
      assurance: "agent_guided",
      reason: "Codex hooks expose no native arbitrary-question answer receipt",
    },
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
      reason: "Codex reports stable child identities, but cannot block creation or bind a writer",
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
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const SOURCES = ["startup", "resume", "clear", "compact"];

/**
 * Validate the keys each Codex event needs. Unknown keys are ignored: a Codex
 * release that adds a field must never turn into a denial of every tool call.
 */
export const parseCodexHookInput = (value: unknown): CodexParseResult => {
  if (!isRecord(value) || !Object.hasOwn(EVENTS, String(value.hook_event_name)))
    return { ok: false, error: "hook_event_name is required" };
  const event = value.hook_event_name as CodexHookEvent;
  if (!nonEmpty(value.session_id)) return { ok: false, error: "session_id is required" };
  if (!nonEmpty(value.model)) return { ok: false, error: "model is required" };
  if (!PERMISSION_MODES.includes(String(value.permission_mode)))
    return { ok: false, error: "permission_mode is invalid" };
  if (!(value.transcript_path === null || nonEmpty(value.transcript_path)))
    return { ok: false, error: "transcript_path must be a string or null" };
  const cwd = existingDirectory(value.cwd);
  if (!cwd) return { ok: false, error: "cwd must be an existing absolute directory" };
  if (event === "SessionStart" && !SOURCES.includes(String(value.source)))
    return { ok: false, error: "SessionStart source is required" };
  if (
    event === "PreToolUse" &&
    (!nonEmpty(value.turn_id) ||
      !nonEmpty(value.tool_name) ||
      value.tool_input === undefined ||
      !nonEmpty(value.tool_use_id))
  )
    return { ok: false, error: "turn_id, tool_name, tool_input, and tool_use_id are required" };
  if (
    event === "PreToolUse" &&
    isShellTool(value.tool_name) &&
    (!isRecord(value.tool_input) || !nonEmpty(value.tool_input.command))
  )
    return { ok: false, error: "tool_input.command is required for shell tools" };
  if (
    event === "SubagentStart" &&
    (!nonEmpty(value.turn_id) || !nonEmpty(value.agent_id) || !nonEmpty(value.agent_type))
  )
    return { ok: false, error: "turn_id, agent_id, and agent_type are required" };
  if (
    event === "SubagentStop" &&
    (!nonEmpty(value.turn_id) ||
      !nonEmpty(value.agent_id) ||
      !nonEmpty(value.agent_type) ||
      !(value.agent_transcript_path === null || nonEmpty(value.agent_transcript_path)) ||
      !(
        value.last_assistant_message === null || typeof value.last_assistant_message === "string"
      ) ||
      typeof value.stop_hook_active !== "boolean")
  )
    return { ok: false, error: "SubagentStop fields are required" };
  return {
    ok: true,
    data: {
      hook_event_name: event,
      session_id: value.session_id,
      model: value.model,
      permission_mode: value.permission_mode as PermissionMode,
      transcript_path: value.transcript_path as string | null,
      cwd,
      ...(event === "SessionStart" ? { source: value.source as SessionSource } : {}),
      ...(nonEmpty(value.turn_id) ? { turn_id: value.turn_id } : {}),
      ...(nonEmpty(value.tool_name) ? { tool_name: value.tool_name } : {}),
      ...(event === "PreToolUse" ? { tool_input: value.tool_input } : {}),
      ...(nonEmpty(value.tool_use_id) ? { tool_use_id: value.tool_use_id } : {}),
      ...(nonEmpty(value.agent_id) ? { agent_id: value.agent_id } : {}),
      ...(nonEmpty(value.agent_type) ? { agent_type: value.agent_type } : {}),
      ...(event === "SubagentStop"
        ? {
            agent_transcript_path: value.agent_transcript_path as string | null,
            last_assistant_message: value.last_assistant_message as string | null,
            stop_hook_active: value.stop_hook_active as boolean,
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
            command: String((input.tool_input as { command: string }).command),
            toolUseId,
          }
        : { kind: "tool.pre", tool: input.tool_name!, toolUseId };
    }
    case "SubagentStart":
      return {
        kind: "subagent.start",
        agentId: input.agent_id!,
        agentType: input.agent_type!,
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
    `<workit-codex-mutations>Codex MCP is read-only: unattested callers cannot mutate. Run the workit CLI for task mutations: node_modules/.bin/workit <family> <action> --json --confirm; bind the writer to this session with node_modules/.bin/workit writer acquire --task <id> --revision <rev> --actor ${input.session.id} --confirm. Binding decisions and external actions need a human.</workit-codex-mutations>`,
};
