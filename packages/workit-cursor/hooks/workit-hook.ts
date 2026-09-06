import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  compactTaskContext,
  invariantBootstrap,
  TaskStore,
  WorkitCore,
  failure,
  success,
  type Capability,
  type OperationContext,
  type NativeWorkerObservation,
  type NativeWorkerVerifier,
} from "@brainervirus/workit-core/src/core";

type HookEvent =
  | "sessionStart"
  | "preToolUse"
  | "beforeShellExecution"
  | "subagentStart"
  | "subagentStop"
  | "preCompact";

export type CursorHookInput = {
  hook_event_name: HookEvent;
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

export type HookParseResult = { ok: true; data: CursorHookInput } | { ok: false; error: string };

type HookAvailability = Partial<
  Record<
    "sessionStart" | "preToolUse" | "beforeShellExecution" | "subagentStart" | "subagentStop",
    boolean
  >
>;

const hostRef = (handle: string) => ({ kind: "host" as const, host: "cursor" as const, handle });

/** Capability mapping is deliberately conservative: AskQuestion answers are not
 * observable by this command hook, and arbitrary shell writes are not parseable. */
export const cursorCapabilities = (availability: HookAvailability = {}): Capability[] => {
  // The MCP/session process cannot attest that Cursor loaded its hook manifest.
  // Only the dispatcher handling the corresponding event may claim enforcement.
  const has = (name: keyof HookAvailability) => availability[name] === true;
  return [
    {
      name: "interactive_decision",
      surface: "AskQuestion",
      assurance: "agent_guided",
      reason: "Cursor does not expose AskQuestion answers to Workit hooks or MCP",
      refs: [hostRef("AskQuestion")],
    },
    {
      name: "known_product_writes",
      surface: "preToolUse",
      assurance: has("preToolUse") ? "enforced" : "unavailable",
      reason: has("preToolUse")
        ? "Cursor preToolUse can synchronously deny recognized Write/Edit/Delete targets"
        : "Cursor preToolUse is absent",
      refs: [hostRef("preToolUse")],
    },
    {
      name: "native_subagents",
      surface: "subagentStart/subagentStop",
      assurance: has("subagentStart") && has("subagentStop") ? "agent_guided" : "unavailable",
      reason:
        has("subagentStart") && has("subagentStop")
          ? "reviewer/investigator starts are bounded; Cursor implementer delegation is unavailable and subagentStop lacks a stable child identity"
          : "Cursor native subagent lifecycle hooks are incomplete",
      refs: [hostRef("subagentStart"), hostRef("subagentStop")],
    },
    {
      name: "native_subagent_start",
      surface: "subagentStart",
      assurance: has("subagentStart") ? "enforced" : "unavailable",
      reason: has("subagentStart")
        ? "Cursor subagentStart enforces explicit reviewer/investigator markers; implementer delegation is unavailable"
        : "Cursor subagentStart is absent",
      refs: [hostRef("subagentStart")],
    },
    {
      name: "arbitrary_shell_write",
      surface: "unobservable_shell",
      assurance: "unavailable",
      reason:
        "Only explicitly parsed shell targets are interceptable; arbitrary shell writes are not provable",
      refs: [hostRef("beforeShellExecution")],
    },
    {
      name: "compact_context",
      surface: "sessionStart/preCompact",
      assurance: has("sessionStart") ? "agent_guided" : "unavailable",
      reason: "sessionStart injects context; preCompact can only show a bounded user reminder",
      refs: [hostRef("sessionStart"), hostRef("preCompact")],
    },
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const eventNames = new Set<HookEvent>([
  "sessionStart",
  "preToolUse",
  "beforeShellExecution",
  "subagentStart",
  "subagentStop",
  "preCompact",
]);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

export const parseCursorHookInput = (value: unknown): HookParseResult => {
  if (!isRecord(value) || !eventNames.has(value.hook_event_name as HookEvent))
    return { ok: false, error: "hook_event_name is required" };
  const roots = value.workspace_roots;
  if (!Array.isArray(roots) || roots.length !== 1 || !roots.every(nonEmpty))
    return { ok: false, error: "exactly one workspace root is required" };
  const root = roots[0] as string;
  if (!path.isAbsolute(root) || !existsSync(root))
    return { ok: false, error: "workspace root must be an existing absolute path" };
  const event = value.hook_event_name as HookEvent;
  const conversationId = nonEmpty(value.conversation_id) ? value.conversation_id : undefined;
  const sessionId = nonEmpty(value.session_id) ? value.session_id : undefined;
  if (conversationId && sessionId && conversationId !== sessionId)
    return { ok: false, error: "conversation_id and session_id must match" };
  const session = conversationId ?? sessionId;
  if (event !== "preCompact" && !nonEmpty(session))
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
      workspace_roots: [root],
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

const contextFor = (
  root: string,
  actor: string,
  workerId?: string | null,
  availability: HookAvailability = {},
): OperationContext => ({
  root,
  caller: { host: "cursor", actor },
  capabilities: cursorCapabilities(availability),
  constraints: [],
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  workerId,
});

const activeTask = (store: TaskStore) => {
  const workspace = store.readWorkspace();
  const listed = store.listTasks();
  if (!workspace.ok || !listed.ok) return { ok: false as const, reason: "state unavailable" };
  if (!workspace.data || listed.data.length === 0)
    return { ok: false as const, reason: "no active task" };
  const tasks = listed.data.filter((task) => task.status === "active");
  if (tasks.length !== 1)
    return {
      ok: false as const,
      reason: tasks.length ? "task state is ambiguous" : "no active task",
    };
  return { ok: true as const, workspace: workspace.data, task: tasks[0] };
};

const normalizePath = (root: string, value: string, cwd = root): string | null => {
  const candidate = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relative = path.relative(root, candidate);
  if (!relative) return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
};

const resolveCwd = (root: string, value: string): string | null => {
  try {
    const candidate = path.resolve(root, value);
    if (!statSync(candidate).isDirectory()) return null;
    const canonical = realpathSync(candidate);
    const relative = path.relative(root, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return canonical;
  } catch {
    return null;
  }
};

const shellWritePaths = (root: string, command: string, cwd = root) => {
  const writeIntent =
    /(?:\d*>>?|&>)/.test(command) ||
    /(?:^|[\s;&|])(?:rm|mv|cp|mkdir|touch|install)(?:\s|$)/.test(command);
  if (!writeIntent) return { paths: [], writeIntent: false, invalid: false };
  // Quoted, chained, or multiline commands are deliberately not interpreted:
  // the documented hook cannot prove which file an arbitrary shell expands.
  if (/['"\n;|`$*?()\\]/.test(command) || /&(?!>)/.test(command))
    return { paths: [], writeIntent: true, invalid: true };
  const tokens = command.trim().split(/\s+/);
  const values: string[] = [];
  let invalid = false;
  let commandSeen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const attached = token.match(/^(?:\d*>>?|&>)(.*)$/);
    if (attached) {
      const value = attached[1] || tokens[++index];
      if (!value || value.startsWith("-") || value.startsWith("&")) invalid = true;
      else values.push(value);
      continue;
    }
    if (/^(?:rm|mv|cp|mkdir|touch|install)$/.test(token)) {
      commandSeen = true;
      continue;
    }
    if (commandSeen && !token.startsWith("-")) values.push(token);
  }
  const paths = values
    .map((value) => normalizePath(root, value, cwd))
    .filter((value): value is string => value !== null);
  return {
    paths,
    writeIntent: true,
    invalid: invalid || values.length === 0 || paths.length !== values.length,
  };
};

const writeTargets = (root: string, input: CursorHookInput) => {
  const cwd = input.cwd ? resolveCwd(root, input.cwd) : root;
  if (!cwd) return { paths: [], writeIntent: true, invalid: true };
  if (input.hook_event_name === "preToolUse") {
    const args = isRecord(input.tool_input) ? input.tool_input : {};
    const values = [args.file_path, args.path, args.target, args.filename].filter(nonEmpty);
    if (values.length) {
      const paths = values
        .map((value) => normalizePath(root, value, cwd))
        .filter((value): value is string => value !== null);
      return { paths, writeIntent: true, invalid: paths.length !== values.length };
    }
    return shellWritePaths(root, nonEmpty(args.command) ? args.command : "", cwd);
  }
  return shellWritePaths(root, input.command ?? "", cwd);
};

const isWriteTool = (name: string): boolean =>
  /^(write|edit|delete|remove|apply_patch|patch|rename|mkdir|mv|cp|touch)$/i.test(name);

const deny = (reason: string) => ({
  permission: "deny" as const,
  user_message: "Workit blocked this action",
  agent_message: reason,
});

const allow = { permission: "allow" as const };

const workerVerifier = (input: CursorHookInput): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller }: any) => {
    const subagentId = input.subagent_id;
    const parentId = input.parent_conversation_id;
    const observation =
      expected && input.subagent_id
        ? { subagent_id: subagentId, parent_conversation_id: parentId }
        : null;
    if (
      !observation ||
      !subagentId ||
      !parentId ||
      caller.host !== "cursor" ||
      caller.actor !== parentId
    )
      return failure("permission_denied", "native subagent observation is unavailable");
    if (
      expected.session?.kind !== "host" ||
      expected.session.host !== "cursor" ||
      expected.session.handle !== subagentId
    )
      return failure("permission_denied", "native subagent identity does not match");
    return success(null, null, {
      kind: "host_observed" as const,
      host: "cursor" as const,
      session: hostRef(subagentId),
      workerId: expected.workerId,
      receipts: [hostRef(parentId)],
    });
  },
});

const explicitRole = (task: string | undefined) => {
  const value = task?.trim() ?? "";
  if ((value.match(/\[workit-role:/g) ?? []).length !== 1) return null;
  const match = /^(?:\[workit-role: (implementer|reviewer|investigator)\])(?:\s+(.*))?$/.exec(
    value,
  );
  return match
    ? { role: match[1] as "implementer" | "reviewer" | "investigator", objective: match[2] ?? "" }
    : null;
};

const handleSubagentStart = (input: CursorHookInput, root: string) => {
  const state = activeTask(new TaskStore(root));
  if (!state.ok) return state.reason === "no active task" ? allow : deny(state.reason);
  if (!input.subagent_id || !input.parent_conversation_id)
    return deny("subagent identity and parent session are required");
  if (
    state.task.workers.some(
      (entry) =>
        entry.data.session?.kind === "host" && entry.data.session.handle === input.subagent_id,
    )
  )
    return deny("subagent assignment replayed");
  const assignmentRole = explicitRole(input.task);
  if (!assignmentRole) return deny("active Workit subagents require an explicit role marker");
  if (assignmentRole.role === "implementer")
    return deny("Cursor implementer delegation is unavailable without attested writer identity");
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    ...contextFor(root, input.parent_conversation_id, null, { subagentStart: true }),
    nativeWorker: workerVerifier(input),
  });
  const assigned = core.worker({
    action: "assign",
    schemaVersion: 1,
    taskId: state.task.id,
    expectedRevision: state.task.revision,
    expectedWorkspaceRevision: state.workspace.revision,
    assignment: {
      role: assignmentRole.role,
      objective: assignmentRole.objective || "Native Cursor subagent assignment",
      scope: state.task.intent.data.scope,
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "Report the assigned outcome and evidence before stopping.",
    },
  });
  if (!assigned.ok) return deny(assigned.error);
  const observation: NativeWorkerObservation = {
    taskId: state.task.id,
    workerId: assigned.data.id,
    expectedRevision: assigned.revision!,
    expectedWorkspaceRevision: assigned.workspaceRevision!,
    state: "running",
    session: hostRef(input.subagent_id),
    observation: {
      subagent_id: input.subagent_id,
      parent_conversation_id: input.parent_conversation_id,
    },
  };
  const started = core.observeWorkerLifecycle(observation);
  return started.ok ? allow : deny(started.error);
};

// Cursor's documented stop payload has no stable subagent identity. It is
// observational only; fabricated fields must never mutate worker state.
const handleSubagentStop = () => ({});

export const handleCursorHook = (raw: unknown): Record<string, unknown> => {
  const parsed = parseCursorHookInput(raw);
  if (!parsed.ok) {
    return isRecord(raw) && raw.hook_event_name === "sessionStart" ? {} : deny(parsed.error);
  }
  const input = parsed.data;
  const root = realpathSync(input.workspace_roots[0]);
  if (input.hook_event_name === "sessionStart") {
    const actor = input.session_id ?? input.conversation_id!;
    let compact = "";
    const store = new TaskStore(root);
    const state = activeTask(store);
    if (state.ok) {
      const view = new WorkitCore(
        store,
        contextFor(root, actor, null, { sessionStart: true }),
      ).task({
        schemaVersion: 1,
        action: "inspect",
        taskId: state.task.id,
        view: "full",
      });
      if (view.ok)
        compact = `\n<workit-task-context>${compactTaskContext(view.data as any)}</workit-task-context>`;
    }
    return {
      additional_context: `<workit-contract>\n${invariantBootstrap()}${compact}\n</workit-contract>`,
    };
  }
  if (input.hook_event_name === "preCompact")
    return {
      user_message:
        "Workit context may be stale after compaction; re-run inspection or resume before acting.",
    };
  if (input.hook_event_name === "subagentStart") return handleSubagentStart(input, root);
  if (input.hook_event_name === "subagentStop") return handleSubagentStop();
  if (input.hook_event_name === "beforeShellExecution") {
    const targets = writeTargets(root, input);
    if (targets.invalid) return deny("shell write target is outside or unavailable");
    if (!targets.paths.length && targets.writeIntent)
      return deny("shell write target is ambiguous or unavailable");
    if (!targets.paths.length) return allow;
  } else if (/^shell$/i.test(input.tool_name ?? "")) {
    const parsed = writeTargets(root, input);
    if (parsed.invalid) return deny("shell write target is outside or unavailable");
    if (!parsed.paths.length && parsed.writeIntent)
      return deny("shell write target is ambiguous or unavailable");
    if (!parsed.paths.length) return allow;
  } else if (!isWriteTool(input.tool_name ?? "")) return allow;
  const state = activeTask(new TaskStore(root));
  if (!state.ok) return state.reason === "no active task" ? allow : deny(state.reason);
  const actor = input.conversation_id ?? input.session_id!;
  const worker = state.task.workers.find(
    (entry) => entry.data.session?.kind === "host" && entry.data.session.handle === actor,
  );
  const core = new WorkitCore(
    new TaskStore(root),
    contextFor(root, actor, worker?.id ?? null, {
      preToolUse: input.hook_event_name === "preToolUse",
      beforeShellExecution: input.hook_event_name === "beforeShellExecution",
    }),
  );
  const targets = writeTargets(root, input);
  if (targets.invalid) return deny("recognized product write target is outside or unavailable");
  if (!targets.paths.length) return deny("recognized product write has no parseable target");
  const checked = core.assertProductWriteAllowed({
    task: state.task,
    workspace: state.workspace,
    paths: targets.paths,
  });
  return checked.ok ? allow : deny(checked.error);
};

export const runCursorHook = async (): Promise<void> => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  try {
    const input: unknown = JSON.parse(text || "{}");
    const output = handleCursorHook(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    const event = isRecord(input) ? input.hook_event_name : undefined;
    if (
      output.permission === "deny" &&
      ["preToolUse", "beforeShellExecution", "subagentStart"].includes(String(event))
    )
      process.exitCode = 2;
  } catch {
    // sessionStart is fire-and-forget; malformed startup input must not block
    // a conversation. Blocking hooks fail closed with Cursor's exit code 2.
    const event = (() => {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : "";
      } catch {
        return "";
      }
    })();
    const failClosed = ["preToolUse", "beforeShellExecution", "subagentStart"].includes(event);
    process.stdout.write(`${JSON.stringify(failClosed ? deny("hook failure") : {})}\n`);
    process.exitCode = failClosed ? 2 : 0;
  }
};

if (import.meta.main) await runCursorHook();
