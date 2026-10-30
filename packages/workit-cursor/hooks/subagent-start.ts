// Cursor's subagentStart: an active task assigns a native worker through the
// task engine. Kept out of the per-call hook bundle (workit-hook.ts loads it
// only for subagentStart, from the cursor-session-start bundle) so every other
// event pays nothing for the engine.
import { failure, success } from "@brainervirus/workit-core/src/core/task-contract";
import { WorkitCore, type OperationContext } from "@brainervirus/workit-core/src/core/task-engine";
import { TaskStore } from "@brainervirus/workit-core/src/core/task-store";
import type {
  NativeWorkerObservation,
  NativeWorkerVerifier,
} from "@brainervirus/workit-core/src/core/workers";
import {
  cursorDeny as deny,
  cursorWorkspaceRoot,
  parseCursorHookInput,
  type CursorHookInput,
} from "@brainervirus/workit-core/hooks";
import { cursorCapabilities, type HookAvailability } from "./capabilities";

const hostRef = (handle: string) => ({ kind: "host" as const, host: "cursor" as const, handle });

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
    return deny(
      "Cursor implementer delegation is unavailable: subagent writes are not attributable to the worker",
    );
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

/** Cursor-only branch: subagentStart may assign a native worker, so it keeps
 * its fail-closed parse and runs outside the shared protocol handler. */
export const handleSubagentStartHook = (raw: unknown): Record<string, unknown> => {
  const parsed = parseCursorHookInput(raw);
  if (!parsed.ok) return deny(parsed.error);
  return handleSubagentStart(parsed.data, cursorWorkspaceRoot(parsed.data));
};
