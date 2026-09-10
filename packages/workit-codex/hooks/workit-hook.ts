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
import { shellWriteIntent } from "@brainervirus/workit-core/src/core/shell-intent.ts";

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

// An override value that is neither Desktop-shaped nor absent is almost
// certainly a spoofed or stale environment: warn loudly on stderr and fall
// back to CLI provenance instead of misclassifying silently.
export function warnOnSurfaceFallback(env: NodeJS.ProcessEnv = process.env): void {
  const override = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (override !== undefined && override !== "Codex Desktop" && !env.CODEX_ELECTRON_RESOURCES_PATH)
    process.stderr.write(
      `[workit] unrecognized CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${JSON.stringify(override)} — treating surface as codex_cli\n`,
    );
}

export const codexCapabilities = (
  host: CodexHost,
  availability: Availability = {},
): Capability[] => {
  const has = (key: keyof Availability) => availability[key] === true;
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
        ? "PreToolUse can deny covered Bash/apply_patch and local write targets (requires the installed hook bundle)"
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
const allowedKeys: Record<CodexHookEvent, Set<string>> = {
  SessionStart: new Set([
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "permission_mode",
    "transcript_path",
    "source",
  ]),
  PreToolUse: new Set([
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "permission_mode",
    "transcript_path",
    "turn_id",
    "tool_name",
    "tool_input",
    "tool_use_id",
    "agent_id",
    "agent_type",
  ]),
  SubagentStart: new Set([
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "permission_mode",
    "transcript_path",
    "turn_id",
    "agent_id",
    "agent_type",
  ]),
  SubagentStop: new Set([
    "hook_event_name",
    "session_id",
    "cwd",
    "model",
    "permission_mode",
    "transcript_path",
    "turn_id",
    "agent_id",
    "agent_type",
    "agent_transcript_path",
    "last_assistant_message",
    "stop_hook_active",
  ]),
};

export const parseCodexHookInput = (value: unknown): HookParseResult => {
  if (!record(value) || !events.has(value.hook_event_name as CodexHookEvent))
    return { ok: false, error: "hook_event_name is required" };
  const event = value.hook_event_name as CodexHookEvent;
  const unknown = Object.keys(value).find((key) => !allowedKeys[event].has(key));
  if (unknown) return { ok: false, error: `${unknown} is not allowed for ${event}` };
  if (!nonEmpty(value.session_id)) return { ok: false, error: "session_id is required" };
  if (!nonEmpty(value.model)) return { ok: false, error: "model is required" };
  if (
    !["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"].includes(
      String(value.permission_mode),
    )
  )
    return { ok: false, error: "permission_mode is invalid" };
  if (!(value.transcript_path === null || nonEmpty(value.transcript_path)))
    return { ok: false, error: "transcript_path must be a string or null" };
  if (!nonEmpty(value.cwd) || !path.isAbsolute(value.cwd) || !existsSync(value.cwd))
    return { ok: false, error: "cwd must be an existing absolute path" };
  try {
    if (!statSync(value.cwd).isDirectory()) return { ok: false, error: "cwd must be a directory" };
  } catch {
    return { ok: false, error: "cwd must be an existing absolute path" };
  }
  if (
    event === "SessionStart" &&
    !["startup", "resume", "clear", "compact"].includes(String(value.source))
  )
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
    ["bash", "unified-exec"].includes(String(value.tool_name).toLowerCase()) &&
    (!record(value.tool_input) || !nonEmpty(value.tool_input.command))
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
      cwd: realpathSync(value.cwd),
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

const normalizePath = (root: string, value: string, cwd: string): string | null => {
  const target = path.resolve(cwd, value);
  // Resolve symlinks when the operand exists so a link inside the root that
  // points outside cannot pass on its lexical form.
  let resolved = target;
  try {
    resolved = realpathSync(target);
  } catch {
    /* missing path: lexical check only */
  }
  const relative = path.relative(root, resolved);
  if (relative === "") return ".";
  const escaped = process.platform === "win32" ? relative.toLowerCase() : relative;
  return escaped.startsWith("..") || path.isAbsolute(relative) ? null : relative;
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
    // Same shared parser as the Cursor hook (core/shell-intent): intent,
    // invalid, and raw operands — containment stays hook-local below.
    const parsed = shellWriteIntent(typeof args.command === "string" ? args.command : "");
    if (!parsed.intent) return { paths: [], invalid: false, intent: false };
    if (parsed.invalid) return { paths: [], invalid: true, intent: true };
    values.push(...parsed.values);
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

const activeTask = (store: TaskStore) => {
  const workspace = store.readWorkspace();
  if (!workspace.ok)
    return { ok: false as const, kind: "invalid" as const, reason: workspace.error };
  if (!workspace.data)
    return { ok: false as const, kind: "absent" as const, reason: "workspace is unavailable" };
  const tasks = store.listTasks();
  if (!tasks.ok) return { ok: false as const, kind: "invalid" as const, reason: tasks.error };
  const active = tasks.data.filter((task) => task.status === "active");
  if (active.length !== 1)
    return {
      ok: false as const,
      kind: active.length === 0 ? ("absent" as const) : ("ambiguous" as const),
      reason: active.length === 0 ? "no active task" : "active task is ambiguous",
    };
  return { ok: true as const, task: active[0], workspace: workspace.data };
};

const persistedCodexHost = (session: unknown): CodexHost | undefined => {
  if (!record(session) || session.kind !== "host" || !nonEmpty(session.host)) return undefined;
  return session.host as CodexHost;
};

const sessionContext = (input: CodexHookInput): string => {
  let compact = "";
  try {
    const store = new TaskStore(input.cwd);
    const state = activeTask(store);
    if (state.ok) {
      const view = new WorkitCore(store, {
        root: input.cwd,
        caller: { host: detectCodexSurface(process.env), actor: input.session_id },
        // Unsigned stdin (see PreToolUse below): read-only context minting
        // stays unattested as well.
        callerAttested: false,
        capabilities: codexCapabilities(detectCodexSurface(process.env), { sessionStart: true }),
        constraints: [],
        now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      } as OperationContext).task({
        schemaVersion: 1,
        action: "inspect",
        taskId: state.task.id,
        view: "full",
      });
      if (view.ok)
        compact = `\n<workit-task-context>${compactTaskContext(view.data as any)}</workit-task-context>`;
    }
  } catch {
    compact = "\n[workit diagnostic: task state unavailable]";
  }
  return `<workit-contract>\n${invariantBootstrap()}${compact}\n<workit-codex-mutations>Codex MCP is read-only: unattested callers cannot mutate. Run the workit CLI for task mutations (start, policy, evidence, close, writer) with --confirm non-interactively; binding decisions and external actions need a human.</workit-codex-mutations>\n</workit-contract>`;
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
      : event === "SubagentStart"
        ? output(event, { additionalContext: `[workit diagnostic: ${parsed.error}]` })
        : event === "SubagentStop"
          ? {}
          : output(event, { additionalContext: `[workit diagnostic: ${parsed.error}]` });
  }
  const input = parsed.data;
  if (input.hook_event_name === "SessionStart") {
    return output("SessionStart", { additionalContext: sessionContext(input) });
  }
  if (input.hook_event_name === "PreToolUse") {
    const targets = writeTargets(input);
    if (targets.invalid || (targets.intent && targets.paths.length === 0))
      return denied(
        "PreToolUse",
        "covered product write target is outside, unavailable, or ambiguous",
      );
    if (!targets.intent) return output("PreToolUse", { permissionDecision: "allow" });
    try {
      const store = new TaskStore(input.cwd);
      const state = activeTask(store);
      if (!state.ok)
        return state.kind === "absent"
          ? output("PreToolUse", { permissionDecision: "allow" })
          : denied("PreToolUse", state.reason);
      // The persisted writer/worker session is the authority. Surface detection
      // is diagnostic only and must not grant a caller a host identity.
      const worker = state.task.workers.find(
        (entry) =>
          entry.data.session?.kind === "host" && entry.data.session.handle === input.session_id,
      );
      const ownerSession = state.workspace.writer?.owner.session;
      const host = persistedCodexHost(worker?.data.session) ?? persistedCodexHost(ownerSession);
      if (host !== "codex_cli" && host !== "codex_desktop")
        return denied("PreToolUse", "Codex writer identity is unavailable or unmatched");
      const core = new WorkitCore(store, {
        root: input.cwd,
        caller: { host, actor: input.session_id },
        // Stdin hook input is unsigned: any local process can emit it, so a
        // hook-minted context is never attested. Ownership still enforces
        // through the persisted host session match, not this flag.
        callerAttested: false,
        workerId: worker?.id ?? null,
        capabilities: codexCapabilities(host, { preToolUse: true }),
        constraints: [],
        now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      const checked = core.assertProductWriteAllowed({
        task: state.task,
        workspace: state.workspace,
        paths: targets.paths,
      });
      return checked.ok
        ? output("PreToolUse", { permissionDecision: "allow" })
        : denied("PreToolUse", checked.error);
    } catch {
      return denied("PreToolUse", "product write authorization is unavailable");
    }
  }
  if (input.hook_event_name === "SubagentStart")
    return output("SubagentStart", {
      additionalContext: `Workit observed Codex subagent ${input.agent_id} (${input.agent_type}) as read-only/agent-guided; writer delegation is unavailable.`,
    });
  return {};
};

export const runCodexHook = async (): Promise<void> => {
  warnOnSurfaceFallback();
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  let raw: unknown;
  try {
    raw = JSON.parse(text || "{}");
  } catch {
    process.stdout.write(`${JSON.stringify(denied("PreToolUse", "invalid JSON hook input"))}\n`);
    return;
  }
  const result = handleCodexHook(raw);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (import.meta.main) await runCodexHook();
