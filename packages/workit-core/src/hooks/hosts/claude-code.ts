// Claude Code: command hooks mapped onto the protocol. The plugin that
// registers them ships separately; this is the field mapping only.
import type { HostDescriptor } from "../descriptor";
import type {
  HookDecision,
  HookEvent,
  HookEventKind,
  HostAdapter,
  SessionSource,
} from "../protocol";
import { existingDirectory, isRecord, nonEmpty, optionalText } from "./fields";

type ClaudeHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "Stop";

export const CLAUDE_CODE_DESCRIPTOR: HostDescriptor = {
  host: "claude_code",
  label: "Claude Code",
  verifiedAgainst: "claude 2.1.288 (hook zod schemas in the binary)",
  docs: ["https://code.claude.com/docs/en/hooks"],
  transport: "hook-process",
  events: {
    "session.start": { support: "native", native: "SessionStart" },
    "context.turn": { support: "native", native: "UserPromptSubmit" },
    "shell.pre": { support: "native", native: "PreToolUse" },
    "tool.pre": { support: "native", native: "PreToolUse" },
    "shell.post": { support: "native", native: "PostToolUse" },
    // SubagentStart output is additionalContext only: it cannot block or bind.
    "subagent.start": { support: "native", native: "SubagentStart" },
    "subagent.stop": { support: "native", native: "SubagentStop" },
    "prompt.submit": { support: "native", native: "UserPromptSubmit" },
    // PreCompact has no hookSpecificOutput; restore runs on SessionStart source=compact.
    "compact.pre": { support: "partial", native: "PreCompact" },
    stop: { support: "native", native: "Stop" },
  },
  shellPolicy: { deny: "native", channel: "permissionDecision", failClosed: false },
  context: {
    sessionStart: "native",
    perTurn: "native",
    afterCompact: "native",
    task: "session-bound",
  },
  subagents: {
    identity: "native",
    parentBinding: "partial",
    blockStart: "none",
    worktreeIsolation: "native",
    maxConcurrency: "undocumented",
  },
  provenance: { sessionId: "native", agentIdOnTool: "native", postToolObserve: "native" },
  interaction: { questions: "undocumented", writeBoundary: "partial" },
  stopControl: "native",
  shellAvailable: "native",
  perEventCost: "low",
  capabilities: [
    {
      name: "interactive_decision",
      surface: "AskUserQuestion",
      refs: ["AskUserQuestion"],
      requires: [],
      assurance: "agent_guided",
      reason: "Claude Code hooks expose no native question answer receipt",
    },
    {
      name: "known_product_writes",
      surface: "PreToolUse",
      refs: ["PreToolUse"],
      requires: [],
      assurance: "unavailable",
      reason: "file writes are host-policy; Claude Code permissions govern them",
    },
    {
      name: "native_subagents",
      surface: "SubagentStart/SubagentStop",
      refs: ["SubagentStart", "SubagentStop"],
      requires: ["event:subagent.start", "event:subagent.stop"],
      observed: ["subagent.start", "subagent.stop"],
      assurance: "agent_guided",
      reason: "Claude Code reports stable agent identities, but SubagentStart cannot block or bind",
      unavailableReason: "Claude Code subagent lifecycle hooks are unavailable",
    },
    {
      name: "fresh-context-review",
      surface: "SubagentStart",
      refs: ["SubagentStart"],
      requires: ["event:subagent.start"],
      observed: ["subagent.start"],
      assurance: "agent_guided",
      reason:
        "independent review runs as a fresh subagent; evidence evaluation enforces reviewer exclusivity",
      unavailableReason: "Claude Code SubagentStart is unavailable for independent review",
    },
    {
      name: "arbitrary_shell_write",
      surface: "unobservable_shell",
      refs: ["PreToolUse"],
      requires: [],
      assurance: "unavailable",
      reason:
        "Only literal Bash commands are interceptable; arbitrary shell writes are not provable",
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

const EVENTS: Record<ClaudeHookEvent, HookEventKind> = {
  SessionStart: "session.start",
  UserPromptSubmit: "context.turn",
  PreToolUse: "shell.pre",
  PostToolUse: "shell.post",
  SubagentStart: "subagent.start",
  SubagentStop: "subagent.stop",
  PreCompact: "compact.pre",
  Stop: "stop",
};
const SOURCES = new Set<SessionSource>(["startup", "resume", "clear", "compact", "fork"]);

type Parsed = { ok: true; event: HookEvent } | { ok: false; error: string };

const toolCommand = (value: Record<string, unknown>): string | null =>
  isRecord(value.tool_input) && nonEmpty(value.tool_input.command)
    ? value.tool_input.command
    : null;

const eventOf = (name: ClaudeHookEvent, value: Record<string, unknown>): Parsed => {
  const toolUseId = optionalText(value.tool_use_id);
  switch (name) {
    case "SessionStart":
      return SOURCES.has(value.source as SessionSource)
        ? { ok: true, event: { kind: "session.start", source: value.source as SessionSource } }
        : { ok: false, error: "SessionStart source is required" };
    case "UserPromptSubmit":
      return { ok: true, event: { kind: "context.turn" } };
    case "PreToolUse": {
      if (!nonEmpty(value.tool_name)) return { ok: false, error: "tool_name is required" };
      if (value.tool_name !== "Bash")
        return { ok: true, event: { kind: "tool.pre", tool: value.tool_name, toolUseId } };
      const command = toolCommand(value);
      return command
        ? { ok: true, event: { kind: "shell.pre", command, toolUseId } }
        : { ok: false, error: "tool_input.command is required for Bash" };
    }
    case "PostToolUse": {
      const command = toolCommand(value);
      if (value.tool_name !== "Bash" || !command)
        return { ok: false, error: "only Bash PostToolUse is mapped" };
      const response = isRecord(value.tool_response) ? value.tool_response : {};
      return {
        ok: true,
        event: {
          kind: "shell.post",
          command,
          stdout: optionalText(response.stdout) ?? "",
          exitCode: typeof response.exit_code === "number" ? response.exit_code : null,
          toolUseId,
        },
      };
    }
    case "SubagentStart":
      return nonEmpty(value.agent_id) && nonEmpty(value.agent_type)
        ? {
            ok: true,
            event: {
              kind: "subagent.start",
              agentId: value.agent_id,
              agentType: value.agent_type,
              task: null,
            },
          }
        : { ok: false, error: "agent_id and agent_type are required" };
    case "SubagentStop":
      return {
        ok: true,
        event: {
          kind: "subagent.stop",
          agentId: optionalText(value.agent_id),
          agentType: optionalText(value.agent_type),
          lastMessage: optionalText(value.last_assistant_message),
          stopHookActive: value.stop_hook_active === true,
        },
      };
    case "PreCompact":
      return {
        ok: true,
        event: { kind: "compact.pre", trigger: value.trigger === "manual" ? "manual" : "auto" },
      };
    case "Stop":
      return {
        ok: true,
        event: {
          kind: "stop",
          lastMessage: optionalText(value.last_assistant_message),
          stopHookActive: value.stop_hook_active === true,
        },
      };
  }
};

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);

/** Never emits `allow`: that would bypass the user's own permission prompt. */
const render = (decision: HookDecision, native: string | null) => {
  if (decision.kind === "deny" && native === "PreToolUse")
    return {
      json: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      },
      exitCode: 0,
    };
  if (decision.kind === "context" && native !== null && CONTEXT_EVENTS.has(native))
    return {
      json: { hookSpecificOutput: { hookEventName: native, additionalContext: decision.text } },
      exitCode: 0,
    };
  if (decision.kind === "continue" && (native === "Stop" || native === "SubagentStop"))
    return { json: { decision: "block", reason: decision.reason }, exitCode: 0 };
  return { json: {}, exitCode: 0 };
};

export const claudeCodeAdapter: HostAdapter = {
  descriptor: CLAUDE_CODE_DESCRIPTOR,
  parse(raw) {
    const native =
      isRecord(raw) && Object.hasOwn(EVENTS, String(raw.hook_event_name))
        ? (raw.hook_event_name as ClaudeHookEvent)
        : null;
    const fail = (error: string) => ({
      ok: false as const,
      error,
      native,
      event: native ? EVENTS[native] : null,
    });
    if (!isRecord(raw) || !native) return fail("hook_event_name is required");
    if (!nonEmpty(raw.session_id)) return fail("session_id is required");
    const cwd = existingDirectory(raw.cwd);
    if (!cwd) return fail("cwd must be an existing absolute directory");
    const event = eventOf(native, raw);
    if (!event.ok) return fail(event.error);
    return {
      ok: true,
      native,
      input: {
        host: "claude_code",
        cwd,
        session: {
          id: raw.session_id,
          agentId: optionalText(raw.agent_id),
          agentType: optionalText(raw.agent_type),
          parentId: nonEmpty(raw.agent_id) ? raw.session_id : null,
        },
        permissionMode: optionalText(raw.permission_mode),
        transcriptPath: optionalText(raw.transcript_path),
        event: event.event,
      },
    };
  },
  render,
};
