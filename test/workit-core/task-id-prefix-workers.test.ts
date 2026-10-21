import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import { caller, ref, scope, taskStartRequest } from "./task-fixtures";

const verifier: NativeWorkerVerifier = {
  verifyWorker: ({ expected, caller: actualCaller }) =>
    success(null, null, {
      kind: "host_observed",
      host: actualCaller.host,
      session: expected.session,
      workerId: expected.workerId,
    }),
};

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  nativeWorker: verifier,
  ...options,
});

const state = (store: TaskStore, taskId: string) => {
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  return { task: task.data, workspace: workspace.data };
};

const startTask = (core: WorkitCore, store: TaskStore) => {
  const workspace = store.readWorkspace();
  if (!workspace.ok) throw new Error(workspace.error);
  const started = core.task(
    taskStartRequest({ expectedWorkspaceRevision: workspace.data?.revision ?? null }),
  );
  if (!started.ok) throw new Error(started.error);
  return (started.data as { id: string }).id;
};

const assignWorker = (core: WorkitCore, store: TaskStore, taskId: string) => {
  const { task, workspace } = state(store, taskId);
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    assignment: {
      role: "implementer",
      objective: "inspect the assigned area",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report the result",
    },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  return assigned.data.id;
};

const setWorkerId = (store: TaskStore, taskId: string, from: string, to: string) => {
  const { task } = state(store, taskId);
  const changed = store.mutateTask(taskId, task.revision, (current, mutation) =>
    success(mutation.revision, null, {
      ...current,
      workers: current.workers.map((entry) => (entry.id === from ? { ...entry, id: to } : entry)),
    }),
  );
  if (!changed.ok) throw new Error(changed.error);
};

test("taskForWorker finds the task by prefix and refuses a prefix shared across tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-worker-prefix-store-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const firstTask = startTask(core, store);
  const first = assignWorker(core, store, firstTask);
  const secondTask = startTask(core, store);
  const second = assignWorker(core, store, secondTask);

  expect(store.taskForWorker(first.slice(0, 8))).toMatchObject({ ok: true, data: firstTask });
  expect(store.taskForWorker(second)).toMatchObject({ ok: true, data: secondTask });
  expect(store.taskForWorker("00000000")).toMatchObject({ ok: true, data: null });
  expect(store.taskForWorker("short")).toMatchObject({ ok: false, code: "invalid_input" });

  const shared = `${first.slice(0, 8)}${second.slice(8)}`;
  setWorkerId(store, secondTask, second, shared);
  const ambiguous = store.taskForWorker(first.slice(0, 8));
  expect(ambiguous).toMatchObject({ ok: false, code: "invalid_input" });
  if (ambiguous.ok) throw new Error("expected failure");
  expect(ambiguous.error).toContain(first);
  expect(ambiguous.error).toContain(shared);
  expect(store.taskForWorker(first)).toMatchObject({ ok: true, data: firstTask });
});

test("worker cancel and a helper's report resolve prefixes, including its finding ids", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-worker-prefix-ops-"));
  const store = new TaskStore(root);
  const lead = new WorkitCore(store, context(root));
  const taskId = startTask(lead, store);
  const workerId = assignWorker(lead, store, taskId);
  const other = assignWorker(lead, store, taskId);

  let now = state(store, taskId);
  const running = lead.observeWorkerLifecycle({
    taskId,
    workerId,
    expectedRevision: now.task.revision,
    expectedWorkspaceRevision: now.workspace.revision,
    state: "running",
    session: { kind: "host", host: "workit_cli", handle: "worker-session" },
    observation: { event: "worker-started" },
  });
  expect(running.ok).toBe(true);

  const helper = new WorkitCore(
    store,
    context(root, { caller: caller({ actor: "worker-session" }), workerId }),
  );
  now = state(store, taskId);
  const recorded = helper.finding({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: now.task.revision,
    claim: "c",
    consequence: "d",
    scope: scope({ paths: ["src"] }),
    candidateId: null,
    refs: [ref()],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const findingId = (recorded.data as { id: string }).id;

  now = state(store, taskId);
  const report = (id: string, findingIds: string[]) =>
    helper.worker({
      schemaVersion: 1,
      action: "report",
      taskId,
      expectedRevision: now.task.revision,
      expectedWorkspaceRevision: now.workspace.revision,
      workerId: id,
      report: { outcome: "completed", summary: "done", evidenceIds: [], findingIds },
    });

  expect(report(other.slice(0, 8), [])).toMatchObject({
    ok: false,
    code: "permission_denied",
    error: "workers can submit only their own report",
  });
  expect(report(workerId, ["00000000"])).toMatchObject({ ok: false, code: "invalid_input" });
  expect(report(workerId.slice(0, 8), [findingId.slice(0, 8)])).toMatchObject({
    ok: true,
    data: { id: workerId, data: { report: { findingIds: [findingId] } } },
  });

  now = state(store, taskId);
  expect(
    lead.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId,
      expectedRevision: now.task.revision,
      expectedWorkspaceRevision: now.workspace.revision,
      workerId: other.slice(0, 8),
      reason: "no longer needed",
    }),
  ).toMatchObject({ ok: true, data: { id: other } });
});
