import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  compactTaskContext,
  invariantBootstrap,
  TaskStore,
  WorkitCore,
  type Capability,
  type OperationContext,
} from "@brainervirus/workit-core/src/core";

export type CodexHost = "codex_cli" | "codex_desktop";
export type CodexHookEvent = "SessionStart" | "PreToolUse" | "SubagentStart" | "SubagentStop";
type SessionSource = "startup" | "resume" | "clear" | "compact";

export type CodexHookInput = {
  hook_event_name: CodexHookEvent;
  session_id: string;
  cwd: string;
  source?: SessionSource;
  tool_name?: string;
  tool_input?: unknown;
  agent_id?: string;
  agent_type?: string;
  status?: "completed" | "error" | "aborted";
  last_message?: string;
  needs_user_decision?: boolean;
};

export type HookParseResult = { ok: true; data: CodexHookInput } | { ok: false; error: string };
type Availability = Partial<
  Record<"sessionStart" | "preToolUse" | "subagentStart" | "subagentStop", boolean>
>;

const ref = (host: CodexHost, handle: string) => ({ kind: "host" as const, host, handle });

export function detectCodexSurface(env: NodeJS.ProcessEnv): CodexHost {
  return env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" ||
    Boolean(env.CODEX_ELECTRON_RESOURCES_PATH)
    ? "codex_desktop"
    : "codex_cli";
}

export const codexCapabilities = (availability: Availability = {}): Capability[] => {
  const has = (key: keyof Availability) => availability[key] === true;
  const host = detectCodexSurface(process.env);
  return [
    {
      name: "interactive_decision",
      surface: "Question",
      assurance: "agent_guided",
      reason: "Codex hooks expose no native arbitrary-question answer receipt",
      refs: [ref(host, "Question")],
    },
    {
      name: "known_product_writes",
      surface: "PreToolUse",
      assurance: has("preToolUse") ? "enforced" : "unavailable",
      reason: has("preToolUse")
        ? "PreToolUse can deny covered Bash/apply_patch and local write targets"
        : "PreToolUse hook is untrusted or unavailable",
      refs: [ref(host, "PreToolUse")],
    },
    {
      name: "native_subagents",
      surface: "SubagentStart/SubagentStop",
      assurance: has("subagentStart") && has("subagentStop") ? "agent_guided" : "unavailable",
      reason:
        has("subagentStart") && has("subagentStop")
          ? "Codex reports stable child identities, but cannot block creation or bind a writer"
          : "Codex subagent lifecycle hooks are untrusted or incomplete",
      refs: [ref(host, "SubagentStart"), ref(host, "SubagentStop")],
    },
    {
      name: "native_subagent_start",
      surface: "SubagentStart",
      assurance: has("subagentStart") ? "agent_guided" : "unavailable",
      reason: has("subagentStart")
        ? "SubagentStart supplies identity and bounded read-only guidance; continue:false cannot stop creation"
        : "SubagentStart hook is untrusted or unavailable",
      refs: [ref(host, "SubagentStart")],
    },
    {
      name: "arbitrary_shell_write",
      surface: "unobservable_shell",
      assurance: "unavailable",
      reason:
        "Only covered known tool inputs are interceptable; specialized and write_stdin paths are not complete",
      refs: [ref(host, "PreToolUse")],
    },
    {
      name: "compact_context",
      surface: "SessionStart",
      assurance: has("sessionStart") ? "agent_guided" : "unavailable",
      reason: "SessionStart source=compact is the single restore path",
      refs: [ref(host, "SessionStart")],
    },
  ];
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const events = new Set<CodexHookEvent>([
  "SessionStart",
  "PreToolUse",
  "SubagentStart",
  "SubagentStop",
]);

export const parseCodexHookInput = (value: unknown): HookParseResult => {
  if (!record(value) || !events.has(value.hook_event_name as CodexHookEvent))
    return { ok: false, error: "hook_event_name is required" };
  if (!nonEmpty(value.session_id)) return { ok: false, error: "session_id is required" };
  if (!nonEmpty(value.cwd) || !path.isAbsolute(value.cwd) || !existsSync(value.cwd))
    return { ok: false, error: "cwd must be an existing absolute path" };
  try {
    if (!statSync(value.cwd).isDirectory()) return { ok: false, error: "cwd must be a directory" };
  } catch {
    return { ok: false, error: "cwd must be an existing absolute path" };
  }
  const event = value.hook_event_name as CodexHookEvent;
  if (
    event === "SessionStart" &&
    !["startup", "resume", "clear", "compact"].includes(String(value.source))
  )
    return { ok: false, error: "SessionStart source is required" };
  if (event === "PreToolUse" && (!nonEmpty(value.tool_name) || value.tool_input === undefined))
    return { ok: false, error: "tool_name and tool_input are required" };
  if (
    event === "PreToolUse" &&
    ["bash", "unified-exec"].includes(String(value.tool_name).toLowerCase()) &&
    (!record(value.tool_input) || !nonEmpty(value.tool_input.command))
  )
    return { ok: false, error: "tool_input.command is required for shell tools" };
  if (event === "SubagentStart" && (!nonEmpty(value.agent_id) || !nonEmpty(value.agent_type)))
    return { ok: false, error: "agent_id and agent_type are required" };
  if (event === "SubagentStop" && !nonEmpty(value.agent_id))
    return { ok: false, error: "agent_id is required" };
  return {
    ok: true,
    data: {
      hook_event_name: event,
      session_id: value.session_id,
      cwd: realpathSync(value.cwd),
      ...(event === "SessionStart" ? { source: value.source as SessionSource } : {}),
      ...(nonEmpty(value.tool_name) ? { tool_name: value.tool_name } : {}),
      ...(event === "PreToolUse" ? { tool_input: value.tool_input } : {}),
      ...(nonEmpty(value.agent_id) ? { agent_id: value.agent_id } : {}),
      ...(nonEmpty(value.agent_type) ? { agent_type: value.agent_type } : {}),
      ...(value.status === "completed" || value.status === "error" || value.status === "aborted"
        ? { status: value.status }
        : {}),
      ...(nonEmpty(value.last_message) ? { last_message: value.last_message } : {}),
      ...(value.needs_user_decision === true ? { needs_user_decision: true } : {}),
    },
  };
};

const normalizePath = (root: string, value: string, cwd: string): string | null => {
  const target = path.resolve(cwd, value);
  const relative = path.relative(root, target);
  return relative === ""
    ? "."
    : relative.startsWith("..") || path.isAbsolute(relative)
      ? null
      : relative;
};

const writeTargets = (
  input: CodexHookInput,
): { paths: string[]; invalid: boolean; intent: boolean } => {
  const root = input.cwd;
  const tool = input.tool_name?.toLowerCase() ?? "";
  const args = record(input.tool_input) ? input.tool_input : {};
  const writeTools = new Set([
    "write",
    "edit",
    "delete",
    "remove",
    "rename",
    "mkdir",
    "mv",
    "cp",
    "touch",
    "apply_patch",
    "bash",
    "unified-exec",
  ]);
  if (!writeTools.has(tool)) return { paths: [], invalid: false, intent: false };
  const values: string[] = [];
  if (["write", "edit", "delete", "remove", "rename", "mkdir", "mv", "cp", "touch"].includes(tool))
    for (const key of ["file_path", "path", "target", "filename"])
      if (nonEmpty(args[key])) values.push(args[key]);
  if (tool === "apply_patch") {
    const patch =
      typeof args.command === "string"
        ? args.command
        : typeof args.patch === "string"
          ? args.patch
          : "";
    for (const line of patch.split(/\r?\n/)) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
      if (match) values.push(match[1].trim());
    }
  }
  if (tool === "bash" || tool === "unified-exec") {
    const command = typeof args.command === "string" ? args.command : "";
    const intent = /(?:\d*>>?|&>|\b(?:rm|mv|cp|mkdir|touch|install)\b)/.test(command);
    if (!intent) return { paths: [], invalid: false, intent: false };
    // ponytail: simple token scan; shell expansion stays unavailable until a
    // native structured command target exists.
    if (/[;'"`$*?()\\\n|]/.test(command)) return { paths: [], invalid: true, intent: true };
    for (const match of command.matchAll(/(?:\d*>>?|&>)\s*([^\s]+)/g)) values.push(match[1]);
    const parts = command.trim().split(/\s+/);
    const commandIndex = parts.findIndex((part) => /^(rm|mv|cp|mkdir|touch|install)$/.test(part));
    if (commandIndex >= 0)
      values.push(...parts.slice(commandIndex + 1).filter((part) => !part.startsWith("-")));
  }
  if (!values.length)
    return {
      paths: [],
      invalid: input.tool_name !== undefined && tool !== "bash" && tool !== "unified-exec",
      intent: tool !== "",
    };
  const paths = values.map((value) => normalizePath(root, value, root));
  return {
    paths: paths.filter((value): value is string => value !== null),
    invalid: paths.some((value) => value === null),
    intent: true,
  };
};

const output = (event: CodexHookEvent, extra: Record<string, unknown> = {}) => ({
  hookSpecificOutput: { hookEventName: event, ...extra },
});
const denied = (event: CodexHookEvent, reason: string) =>
  output(event, { permissionDecision: "deny", permissionDecisionReason: reason });

const sessionContext = (input: CodexHookInput): string => {
  let compact = "";
  try {
    const store = new TaskStore(input.cwd);
    const tasks = store.listTasks();
    const active = tasks.ok ? tasks.data.find((task) => task.status !== "closed") : undefined;
    if (active) {
      const view = new WorkitCore(store, {
        root: input.cwd,
        caller: { host: detectCodexSurface(process.env), actor: "" },
        callerAttested: false,
        capabilities: codexCapabilities({ sessionStart: true }),
        constraints: [],
        now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      } as OperationContext).task({
        schemaVersion: 1,
        action: "inspect",
        taskId: active.id,
        view: "full",
      });
      if (view.ok)
        compact = `\n<workit-task-context>${compactTaskContext(view.data as any)}</workit-task-context>`;
    }
  } catch {
    compact = "\n[workit diagnostic: task state unavailable]";
  }
  return `<workit-contract>\n${invariantBootstrap()}${compact}\n</workit-contract>`;
};

export const handleCodexHook = (raw: unknown): Record<string, unknown> => {
  const parsed = parseCodexHookInput(raw);
  if (!parsed.ok) {
    const event =
      record(raw) && events.has(raw.hook_event_name as CodexHookEvent)
        ? (raw.hook_event_name as CodexHookEvent)
        : "PreToolUse";
    return event === "PreToolUse"
      ? denied(event, parsed.error)
      : output(event, { additionalContext: `[workit diagnostic: ${parsed.error}]` });
  }
  const input = parsed.data;
  if (input.hook_event_name === "SessionStart") {
    const context = input.needs_user_decision
      ? `${sessionContext(input)}\n[workit needs_input: required user decision]`
      : sessionContext(input);
    return output("SessionStart", { additionalContext: context });
  }
  if (input.hook_event_name === "PreToolUse") {
    const targets = writeTargets(input);
    if (targets.invalid || (targets.intent && targets.paths.length === 0))
      return denied(
        "PreToolUse",
        "covered product write target is outside, unavailable, or ambiguous",
      );
    if (!targets.intent) return output("PreToolUse", { permissionDecision: "allow" });
    return output("PreToolUse", { permissionDecision: "allow" });
  }
  if (input.hook_event_name === "SubagentStart")
    return output("SubagentStart", {
      additionalContext: `Workit observed Codex subagent ${input.agent_id} (${input.agent_type}) as read-only/agent-guided; writer delegation is unavailable.`,
    });
  return output("SubagentStop", {
    additionalContext: `Workit observed Codex subagent ${input.agent_id} ${input.status ?? "without a terminal status"}; cancellation/error remains observational.`,
  });
};

export const runCodexHook = async (): Promise<void> => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    process.stdout.write(`${JSON.stringify(denied("PreToolUse", "invalid JSON hook input"))}\n`);
    process.exitCode = 2;
    return;
  }
  const result = handleCodexHook(raw);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const event = record(raw) ? raw.hook_event_name : undefined;
  if (
    event === "PreToolUse" &&
    (result.hookSpecificOutput as Record<string, unknown>)?.permissionDecision === "deny"
  )
    process.exitCode = 2;
};

if (import.meta.main) await runCodexHook();
