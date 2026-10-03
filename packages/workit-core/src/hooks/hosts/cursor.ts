// Cursor: command hooks (hooks/hooks-cursor.json) mapped onto the protocol.
import path from "node:path";
import type { HostDescriptor } from "../descriptor";
import type { HookDecision, HookEvent, HookEventKind, HostAdapter } from "../protocol";
import { existingDirectory, isRecord, nonEmpty } from "./fields";

export type CursorHookEvent =
  | "sessionStart"
  | "preToolUse"
  | "beforeShellExecution"
  | "subagentStart"
  | "subagentStop"
  | "preCompact";

export type CursorHookInput = {
  hook_event_name: CursorHookEvent;
  conversation_id?: string;
  session_id?: string;
  workspace_roots: string[];
  tool_name?: string;
  tool_input?: unknown;
  command?: string;
  cwd?: string;
  subagent_id?: string;
  subagent_type?: string;
  parent_conversation_id?: string;
  task?: string;
  status?: "completed" | "error" | "aborted";
};

export type CursorParseResult = { ok: true; data: CursorHookInput } | { ok: false; error: string };

const undocumented = { support: "undocumented", native: null } as const;
const none = { support: "none", native: null } as const;

export const CURSOR_DESCRIPTOR: HostDescriptor = {
  host: "cursor",
  label: "Cursor",
  verifiedAgainst: "Cursor hooks docs; payloads in test/fixtures/hooks/cursor",
  docs: ["https://cursor.com/docs/agent/hooks"],
  transport: "hook-process",
  events: {
    "session.start": { support: "native", native: "sessionStart" },
    "context.turn": none,
    "shell.pre": { support: "native", native: "beforeShellExecution" },
    "tool.pre": { support: "native", native: "preToolUse" },
    "shell.post": undocumented,
    "subagent.start": { support: "native", native: "subagentStart" },
    // subagentStop carries no stable child identity.
    "subagent.stop": { support: "partial", native: "subagentStop" },
    "prompt.submit": undocumented,
    // preCompact can only show a user message.
    "compact.pre": { support: "partial", native: "preCompact" },
    stop: undocumented,
  },
  shellPolicy: { deny: "native", channel: "exit2+json", failClosed: true },
  context: {
    sessionStart: "native",
    perTurn: "none",
    afterCompact: "partial",
    task: "single-active",
  },
  subagents: {
    identity: "native",
    parentBinding: "native",
    blockStart: "native",
    worktreeIsolation: "undocumented",
    maxConcurrency: "undocumented",
  },
  provenance: {
    sessionId: "native",
    agentIdOnTool: "undocumented",
    postToolObserve: "undocumented",
  },
  interaction: { questions: "none", writeBoundary: "partial" },
  stopControl: "undocumented",
  shellAvailable: "native",
  // Every hook spawns `npx -y --prefer-online …@latest`: a registry round-trip per event.
  perEventCost: "npx-network",
  capabilities: [
    {
      name: "interactive_decision",
      surface: "AskQuestion",
      refs: ["AskQuestion"],
      requires: [],
      assurance: "agent_guided",
      reason: "Cursor does not expose AskQuestion answers to Workit hooks or MCP",
    },
    {
      name: "known_product_writes",
      surface: "preToolUse",
      refs: ["preToolUse"],
      requires: [],
      assurance: "unavailable",
      reason:
        "file writes are host-policy; the Cursor hook no longer gates write tools or shell commands",
    },
    {
      name: "native_subagents",
      surface: "subagentStart/subagentStop",
      refs: ["subagentStart", "subagentStop"],
      requires: ["event:subagent.start", "event:subagent.stop"],
      observed: ["subagent.start", "subagent.stop"],
      assurance: "agent_guided",
      reason:
        "reviewer/investigator starts are bounded; Cursor implementer delegation is unavailable and subagentStop lacks a stable child identity",
      unavailableReason: "Cursor native subagent lifecycle hooks are incomplete",
    },
    {
      name: "native_subagent_start",
      surface: "subagentStart",
      refs: ["subagentStart"],
      requires: ["event:subagent.start", "subagents.blockStart"],
      observed: ["subagent.start"],
      assurance: "enforced",
      reason:
        "Cursor subagentStart enforces explicit reviewer/investigator markers; implementer delegation is unavailable",
      unavailableReason: "Cursor subagentStart is absent",
    },
    {
      name: "fresh-context-review",
      surface: "subagentStart",
      refs: ["subagentStart"],
      requires: ["event:subagent.start"],
      observed: ["subagent.start"],
      assurance: "agent_guided",
      reason:
        "independent review runs as a bounded reviewer subagent; stops lack stable identity, so reviewer exclusivity is evaluated from recorded evidence",
      unavailableReason: "Cursor subagentStart is unavailable for independent review",
    },
    {
      name: "arbitrary_shell_write",
      surface: "unobservable_shell",
      refs: ["beforeShellExecution"],
      requires: [],
      assurance: "unavailable",
      reason:
        "Only explicitly parsed shell targets are interceptable; arbitrary shell writes are not provable",
    },
    {
      name: "compact_context",
      surface: "sessionStart/preCompact",
      refs: ["sessionStart", "preCompact"],
      requires: ["context.sessionStart"],
      observed: ["session.start"],
      assurance: "agent_guided",
      reason: "sessionStart injects context; preCompact can only show a bounded user reminder",
    },
  ],
};

const EVENTS: Record<CursorHookEvent, HookEventKind> = {
  sessionStart: "session.start",
  preToolUse: "tool.pre",
  beforeShellExecution: "shell.pre",
  subagentStart: "subagent.start",
  subagentStop: "subagent.stop",
  preCompact: "compact.pre",
};

/** Validate the keys each Cursor event needs; unknown keys are ignored. */
export const parseCursorHookInput = (value: unknown): CursorParseResult => {
  if (!isRecord(value) || !Object.hasOwn(EVENTS, String(value.hook_event_name)))
    return { ok: false, error: "hook_event_name is required" };
  const roots = value.workspace_roots;
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every(nonEmpty))
    return { ok: false, error: "a workspace root is required" };
  const canonical = roots.map(existingDirectory);
  if (!canonical.every((root): root is string => root !== null))
    return { ok: false, error: "workspace roots must be existing absolute paths" };
  const event = value.hook_event_name as CursorHookEvent;
  const conversationId = nonEmpty(value.conversation_id) ? value.conversation_id : undefined;
  const sessionId = nonEmpty(value.session_id) ? value.session_id : undefined;
  if (conversationId && sessionId && conversationId !== sessionId)
    return { ok: false, error: "conversation_id and session_id must match" };
  if (event !== "preCompact" && !nonEmpty(conversationId ?? sessionId))
    return { ok: false, error: "conversation/session identity is required" };
  if (
    (event === "preToolUse" || event === "beforeShellExecution") &&
    !nonEmpty(value.tool_name ?? value.command)
  )
    return { ok: false, error: "tool or command is required" };
  if (
    event === "subagentStart" &&
    (!nonEmpty(value.subagent_id) || !nonEmpty(value.parent_conversation_id))
  )
    return { ok: false, error: "subagent identity and parent session are required" };
  return {
    ok: true,
    data: {
      hook_event_name: event,
      workspace_roots: canonical,
      ...(nonEmpty(value.conversation_id) ? { conversation_id: value.conversation_id } : {}),
      ...(nonEmpty(value.session_id) ? { session_id: value.session_id } : {}),
      ...(nonEmpty(value.tool_name) ? { tool_name: value.tool_name } : {}),
      ...(value.tool_input !== undefined ? { tool_input: value.tool_input } : {}),
      ...(nonEmpty(value.command) ? { command: value.command } : {}),
      ...(nonEmpty(value.cwd) ? { cwd: value.cwd } : {}),
      ...(event === "subagentStart" && nonEmpty(value.subagent_id)
        ? { subagent_id: value.subagent_id }
        : {}),
      ...(event === "subagentStart" && nonEmpty(value.subagent_type)
        ? { subagent_type: value.subagent_type }
        : {}),
      ...(event === "subagentStart" && nonEmpty(value.parent_conversation_id)
        ? { parent_conversation_id: value.parent_conversation_id }
        : {}),
      ...(event === "subagentStart" && nonEmpty(value.task) ? { task: value.task } : {}),
    },
  };
};

const protocolEvent = (input: CursorHookInput): HookEvent => {
  switch (input.hook_event_name) {
    case "sessionStart":
      // Cursor reports no start source; every sessionStart is a fresh conversation.
      return { kind: "session.start", source: "startup" };
    case "beforeShellExecution":
      // Branch policy reads the command alone; the shell's cwd does not change
      // which branch name it targets.
      return { kind: "shell.pre", command: input.command ?? "", toolUseId: null };
    case "preToolUse":
      return { kind: "tool.pre", tool: input.tool_name ?? "", toolUseId: null };
    case "subagentStart":
      return {
        kind: "subagent.start",
        agentId: input.subagent_id!,
        agentType: input.subagent_type ?? "",
        task: input.task ?? null,
      };
    case "subagentStop":
      return {
        kind: "subagent.stop",
        agentId: null,
        agentType: null,
        lastMessage: null,
        stopHookActive: false,
      };
    case "preCompact":
      return { kind: "compact.pre", trigger: "auto" };
  }
};

const within = (root: string, dir: string) =>
  dir === root || dir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/**
 * Where a hook acts. Shell policy follows the command's own `cwd` (in a
 * multi-root workspace each root is its own repository); everything else
 * uses the workspace root that contains `cwd`, else the first root.
 */
const hookCwd = (input: CursorHookInput): string => {
  const cwd = existingDirectory(input.cwd);
  if (cwd && input.hook_event_name === "beforeShellExecution") return cwd;
  return cursorWorkspaceRoot(input);
};

/** The workspace root that contains the payload `cwd`, else the first root. */
export const cursorWorkspaceRoot = (input: CursorHookInput): string => {
  const cwd = existingDirectory(input.cwd);
  return (
    (cwd && input.workspace_roots.find((root) => within(root, cwd))) || input.workspace_roots[0]
  );
};

/** Cursor's documented deny payload; blocking events also exit 2. */
export const cursorDeny = (reason: string) => ({
  permission: "deny" as const,
  user_message: "Workit blocked this action",
  agent_message: reason,
});
const BLOCKING = new Set(["preToolUse", "beforeShellExecution", "subagentStart"]);

const render = (decision: HookDecision, native: string | null) => {
  if (decision.kind === "deny")
    return {
      json: cursorDeny(decision.reason),
      exitCode: native !== null && BLOCKING.has(native) ? 2 : 0,
    };
  if (decision.kind === "context")
    return { json: { additional_context: decision.text }, exitCode: 0 };
  if (decision.kind === "notice")
    return { json: { user_message: decision.userMessage }, exitCode: 0 };
  return {
    json: native !== null && BLOCKING.has(native) ? { permission: "allow" } : {},
    exitCode: 0,
  };
};

export const cursorAdapter: HostAdapter = {
  descriptor: CURSOR_DESCRIPTOR,
  parse(raw) {
    const parsed = parseCursorHookInput(raw);
    if (!parsed.ok) {
      const native =
        isRecord(raw) && Object.hasOwn(EVENTS, String(raw.hook_event_name))
          ? (raw.hook_event_name as CursorHookEvent)
          : null;
      return { ok: false, error: parsed.error, native, event: native ? EVENTS[native] : null };
    }
    const input = parsed.data;
    return {
      ok: true,
      native: input.hook_event_name,
      input: {
        host: "cursor",
        cwd: hookCwd(input),
        session: {
          id: input.session_id ?? input.conversation_id ?? "",
          agentId: input.subagent_id ?? null,
          agentType: input.subagent_type ?? null,
          parentId: input.parent_conversation_id ?? null,
        },
        permissionMode: null,
        transcriptPath: null,
        event: protocolEvent(input),
      },
    };
  },
  render,
};
