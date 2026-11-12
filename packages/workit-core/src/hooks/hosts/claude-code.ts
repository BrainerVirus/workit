// Claude Code: command hooks mapped onto the protocol. The plugin that
// registers them ships separately; this is the field mapping only.
import { approveCallDeny, approveCallIn } from "../../approvals/call";
import {
  liveApprovalRequest,
  recordApprovalAsked,
  recordApprovalGrant,
  renderApprovalRequest,
} from "../../approvals/store";
import type { HostDescriptor } from "../descriptor";
import type {
  HookDecision,
  HookEvent,
  HookEventKind,
  HostAdapter,
  SessionSource,
} from "../protocol";
import {
  commandText,
  existingDirectory,
  isRecord,
  isWriteTool,
  nonEmpty,
  optionalText,
  writeTargets,
} from "./fields";

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
    "write.pre": { support: "native", native: "PreToolUse" },
    "shell.post": { support: "native", native: "PostToolUse" },
    // SubagentStart output is additionalContext only: it cannot block or bind.
    "subagent.start": { support: "native", native: "SubagentStart" },
    "prompt.submit": { support: "native", native: "UserPromptSubmit" },
    // SubagentStop is never blocked: the launcher answers it itself, dropping
    // the stopped agent's tool-call budget files (hooks/budget-signal.ts).
    // Claude Code has PreCompact, but the plugin does not register it: events
    // list what workit registers (docs/agents/hosts.md, Host parity);
    // compaction restore runs on SessionStart source=compact.
    "subagent.stop": { support: "native", native: "SubagentStop" },
    "compact.pre": { support: "none", native: null },
    // `{"decision":"block","reason"}` continues the turn; the input carries
    // `stop_hook_active` and `last_assistant_message` (claude 2.1.295).
    stop: { support: "native", native: "Stop" },
  },
  shellPolicy: {
    deny: "native",
    channel: "permissionDecision",
    failClosed: false,
    rewrite: "native",
  },
  context: {
    sessionStart: "native",
    perTurn: "native",
    afterCompact: "native",
    task: "session-bound",
    // Each additionalContext stays in the transcript: resend only on change.
    turnResend: "on-change",
  },
  subagents: {
    identity: "native",
    parentBinding: "partial",
    blockStart: "none",
    worktreeIsolation: "native",
    maxConcurrency: "undocumented",
    // Plugin agents are namespaced: `workit:implementer`, never a bare `workit-implementer`.
    agentPrefix: "workit:",
  },
  provenance: {
    sessionId: "native",
    agentIdOnTool: "native",
    postToolObserve: "native",
  },
  interaction: { questions: "undocumented", writeBoundary: "partial" },
  stopControl: "native",
  shellAvailable: "native",
  perEventCost: "low",
  capabilities: [
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
      // SubagentStop is not registered: identity and guidance come from SubagentStart.
      surface: "SubagentStart",
      refs: ["SubagentStart"],
      requires: ["event:subagent.start"],
      observed: ["subagent.start"],
      assurance: "agent_guided",
      reason: "Claude Code reports stable agent identities, but SubagentStart cannot block or bind",
      unavailableReason: "Claude Code SubagentStart is unavailable",
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

/** Claude's shell tools: Bash everywhere, PowerShell on Windows. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const dialectOf = (value: Record<string, unknown>) =>
  value.tool_name === "PowerShell" ? ("powershell" as const) : ("posix" as const);
const toolCommand = (value: Record<string, unknown>): string | null =>
  isRecord(value.tool_input) ? commandText(value.tool_input.command) : null;

const eventOf = (name: ClaudeHookEvent, value: Record<string, unknown>): Parsed => {
  const toolUseId = optionalText(value.tool_use_id);
  switch (name) {
    case "SessionStart":
      return SOURCES.has(value.source as SessionSource)
        ? {
            ok: true,
            event: {
              kind: "session.start",
              source: value.source as SessionSource,
            },
          }
        : { ok: false, error: "SessionStart source is required" };
    case "UserPromptSubmit":
      return {
        ok: true,
        event: { kind: "context.turn", prompt: optionalText(value.prompt) },
      };
    case "PreToolUse": {
      if (!nonEmpty(value.tool_name)) return { ok: false, error: "tool_name is required" };
      if (isWriteTool(value.tool_name))
        return {
          ok: true,
          event: {
            kind: "write.pre",
            tool: value.tool_name,
            paths: writeTargets(value.tool_input),
            toolUseId,
          },
        };
      if (value.tool_name === "Skill")
        return {
          ok: true,
          event: {
            kind: "tool.pre",
            tool: value.tool_name,
            toolUseId,
            skill: isRecord(value.tool_input) ? optionalText(value.tool_input.skill) : null,
          },
        };
      // `Task` is the Agent tool's legacy name.
      if (value.tool_name === "Agent" || value.tool_name === "Task")
        return {
          ok: true,
          event: {
            kind: "tool.pre",
            tool: value.tool_name,
            toolUseId,
            ...(isRecord(value.tool_input) ? { agentInput: value.tool_input } : {}),
          },
        };
      if (!SHELL_TOOLS.has(value.tool_name))
        return {
          ok: true,
          event: { kind: "tool.pre", tool: value.tool_name, toolUseId },
        };
      const command = toolCommand(value);
      return command
        ? {
            ok: true,
            event: {
              kind: "shell.pre",
              command,
              toolUseId,
              dialect: dialectOf(value),
              toolInput: value.tool_input as Record<string, unknown>,
            },
          }
        : {
            ok: false,
            error: `tool_input.command is required for ${value.tool_name}`,
          };
    }
    case "PostToolUse": {
      const command = toolCommand(value);
      if (!SHELL_TOOLS.has(String(value.tool_name)) || !command)
        return { ok: false, error: "only shell PostToolUse is mapped" };
      const response = isRecord(value.tool_response) ? value.tool_response : {};
      return {
        ok: true,
        event: {
          kind: "shell.post",
          command,
          stdout: optionalText(response.stdout) ?? "",
          exitCode: typeof response.exit_code === "number" ? response.exit_code : null,
          toolUseId,
          dialect: dialectOf(value),
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
        event: {
          kind: "compact.pre",
          trigger: value.trigger === "manual" ? "manual" : "auto",
        },
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

/** Events whose hookSpecificOutput takes additionalContext (PreToolUse: a raw-git nudge). */
const CONTEXT_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "PreToolUse",
  "PostToolUse",
]);

/**
 * Never emits `allow`: that would bypass the user's own permission prompt. A
 * rewrite is `updatedInput` with no permissionDecision: Claude Code applies it
 * and runs its normal permission flow on the rewritten command (claude
 * 2.1.306: a hook result with updatedInput and no permissionBehavior is
 * yielded as the input to run).
 */
const renderDecision = (decision: HookDecision, native: string | null) => {
  if (
    (decision.kind === "rewrite" || decision.kind === "update-input") &&
    native === "PreToolUse" &&
    decision.input
  )
    return {
      json: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: decision.input,
          ...(decision.text ? { additionalContext: decision.text } : {}),
        },
      },
      exitCode: 0,
    };
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
  if (decision.kind === "ask" && native === "PreToolUse")
    return {
      json: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: decision.reason,
        },
      },
      exitCode: 0,
    };
  if (decision.kind === "context" && native !== null && CONTEXT_EVENTS.has(native))
    return {
      json: {
        hookSpecificOutput: {
          hookEventName: native,
          additionalContext: decision.text,
        },
      },
      exitCode: 0,
    };
  // PreCompact has no hookSpecificOutput; the common systemMessage field
  // shows the notice to the user.
  if (decision.kind === "notice")
    return { json: { systemMessage: decision.userMessage }, exitCode: 0 };
  if (decision.kind === "continue" && (native === "Stop" || native === "SubagentStop"))
    return {
      json: { decision: "block", reason: decision.reason },
      exitCode: 0,
    };
  return { json: {}, exitCode: 0 };
};

// --- the host-approval channel (docs/workit-next/host-approval.md) ---------

/**
 * Permission modes where an ask reaches a person. Auto mode, bypassPermissions
 * and the SDK's prompt tools may answer an ask without one; until probed, no
 * grant is recorded there (spec: Recording the answer, Claude Code U).
 */
const ASKING_MODES = new Set(["default", "acceptEdits", "plan"]);
/** `claude -p`, the SDKs and `--permission-prompt-tool` run under an `sdk-*` entrypoint. */
const personAsked = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean =>
  ASKING_MODES.has(String(raw.permission_mode)) &&
  !String(env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");

/**
 * The ask for a plain `workit approve <id>…`: every request rendered from the
 * store. null when no id is a live request: there is nothing to ask about, and
 * the CLI answers not_found.
 */
const approveAsk = (ids: readonly string[]): string | null => {
  const found = ids.map((id) => liveApprovalRequest(id));
  if (!found.some((one) => one.ok)) return null;
  return [
    "Workit asks you to approve:",
    ...found.map((one) => (one.ok ? renderApprovalRequest(one.request) : one.reason)),
    "Yes records your approval of exactly this (one use, 15 minutes); No records nothing.",
  ].join("\n");
};

/**
 * What a `workit approve` call does to this dispatch: PreToolUse answers the
 * ask (or denies a call wrapped in anything) and notes the ask in the store;
 * PostToolUse of the same tool call records one grant per id read from argv.
 */
type ApproveStep = (decision: HookDecision) => HookDecision;

const approveStepOf = (
  native: ClaudeHookEvent,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ApproveStep | null => {
  if (native !== "PreToolUse" && native !== "PostToolUse") return null;
  if (!SHELL_TOOLS.has(String(raw.tool_name))) return null;
  const command = toolCommand(raw);
  const call = command ? approveCallIn(command, dialectOf(raw)) : null;
  if (!call) return null;
  const session = optionalText(raw.session_id);
  const toolUseId = optionalText(raw.tool_use_id);
  const asked = personAsked(raw, env);
  if (native === "PreToolUse")
    return (decision) => {
      // Another gate's deny wins; nothing is asked or noted.
      if (decision.kind === "deny") return decision;
      if (!call.plain)
        return {
          kind: "deny",
          reason: approveCallDeny(call.fix),
          unblock: call.fix,
        };
      const reason = approveAsk(call.ids);
      // No live request: drop the shared user-only ask; the CLI answers not_found.
      if (reason === null) return decision.kind === "ask" ? { kind: "none" } : decision;
      if (asked && session && toolUseId)
        recordApprovalAsked({
          toolUseId,
          session,
          host: "claude_code",
          ids: call.ids,
        });
      return { kind: "ask", reason };
    };
  // Claude Code fires PostToolUse only for a call that succeeded (a failed
  // one is PostToolUseFailure, not registered); an exit code it does send must be 0.
  const response = isRecord(raw.tool_response) ? raw.tool_response : {};
  const exitCode = typeof response.exit_code === "number" ? response.exit_code : 0;
  const ran = exitCode === 0 && response.interrupted !== true;
  return (decision) => {
    if (call.plain && asked && session && toolUseId && ran)
      for (const id of call.ids)
        recordApprovalGrant({
          id,
          host: "claude_code",
          session,
          toolUseId,
          via: "host",
        });
    return decision;
  };
};

/**
 * The approve step of the payload being dispatched. dispatchHook runs parse,
 * the shared handler and render in one synchronous call, so parse sets it and
 * render takes it; any parse resets it.
 */
let approveStep: ApproveStep | null = null;

const render = (decision: HookDecision, native: string | null) => {
  const step = approveStep;
  approveStep = null;
  let final = decision;
  try {
    if (step) final = step(decision);
  } catch {
    // The store failing never blocks a call: the request stays unapproved.
  }
  return renderDecision(final, native);
};

export const claudeCodeAdapter: HostAdapter = {
  descriptor: CLAUDE_CODE_DESCRIPTOR,
  parse(raw, env = process.env) {
    approveStep = null;
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
    approveStep = approveStepOf(native, raw, env);
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
