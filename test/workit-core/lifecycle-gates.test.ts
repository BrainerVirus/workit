import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
  type TaskRecord,
  type WorkspaceRecord,
} from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "./task-fixtures";

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: { host: "workit_cli", actor: "test" },
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  ...options,
});

const observationVerifier = (): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller: actualCaller }) =>
    success(null, null, {
      kind: "host_observed",
      host: actualCaller.host,
      session: expected.session,
      workerId: expected.workerId,
      receipts: [{ kind: "host", host: actualCaller.host, handle: "native-event" }],
    }),
});

const active = (options: Partial<OperationContext> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "workit-lifecycle-"));
  writeFileSync(join(root, "a.ts"), "before");
  const store = new TaskStore(root);
  const core = new WorkitCore(
    store,
    context(root, { nativeWorker: observationVerifier(), ...options }),
  );
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active state missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

const assign = (core: WorkitCore, task: TaskRecord, workspace: WorkspaceRecord) =>
  core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    assignment: {
      role: "investigator",
      objective: "inspect",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });

const current = (lead: ReturnType<typeof active>) => {
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  return { task: task.data, workspace: workspace.data };
};

const observeRunning = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  task: TaskRecord,
  workspace: WorkspaceRecord,
  session = "worker-session",
) =>
  core.observeWorkerLifecycle({
    taskId,
    workerId,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    state: "running",
    session: { kind: "host", host: "workit_cli", handle: session },
    observation: { event: "worker-started" },
  });

const pause = (core: WorkitCore, taskId: string) => {
  const task = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
  if (!task.ok) throw new Error(task.error);
  return core.task({
    schemaVersion: 1,
    action: "pause",
    taskId,
    reason: "freeze",
  });
};

test("pause proceeds with live workers and still requires writer release", () => {
  const lead = active();
  try {
    const assigned = assign(lead.core, lead.task, lead.workspace);
    if (!assigned.ok) throw new Error(assigned.error);
    const state = current(lead);
    expect(
      observeRunning(lead.core, lead.task.id, assigned.data.id, state.task, state.workspace).ok,
    ).toBe(true);
    const paused = pause(lead.core, lead.task.id);
    expect(paused).toMatchObject({ ok: true, data: { status: "paused" } });
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});

test("single cancel stops a live unreported worker", () => {
  const lead = active();
  try {
    const assigned = assign(lead.core, lead.task, lead.workspace);
    if (!assigned.ok) throw new Error(assigned.error);
    const state = current(lead);
    const cancelled = lead.core.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      workerId: assigned.data.id,
      reason: "no longer needed",
    });
    expect(cancelled).toMatchObject({ ok: true, data: { data: { state: "stopped" } } });
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});

test("repeat cancel on a stopped worker is idempotent", () => {
  const lead = active();
  try {
    const assigned = assign(lead.core, lead.task, lead.workspace);
    if (!assigned.ok) throw new Error(assigned.error);
    const cancel = () => {
      const state = current(lead);
      return lead.core.worker({
        schemaVersion: 1,
        action: "cancel",
        taskId: lead.task.id,
        expectedRevision: state.task.revision,
        expectedWorkspaceRevision: state.workspace.revision,
        workerId: assigned.data.id,
        reason: "done",
      });
    };
    expect(cancel()).toMatchObject({ ok: true, data: { data: { state: "stopped" } } });
    expect(cancel()).toMatchObject({ ok: true, data: { data: { state: "stopped" } } });
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});

test("close and revise stay blocked by live workers", () => {
  const lead = active();
  try {
    const assigned = assign(lead.core, lead.task, lead.workspace);
    if (!assigned.ok) throw new Error(assigned.error);
    const state = current(lead);
    expect(
      observeRunning(lead.core, lead.task.id, assigned.data.id, state.task, state.workspace).ok,
    ).toBe(true);
    expect(
      lead.core.task({
        schemaVersion: 1,
        action: "close",
        taskId: lead.task.id,
        outcome: "stopped",
        summary: "stop",
        decisionIds: [],
      }),
    ).toMatchObject({ ok: false, code: "recovery_required" });
    const fresh = current(lead);
    expect(
      lead.core.task({
        schemaVersion: 1,
        action: "revise",
        taskId: lead.task.id,
        expectedRevision: fresh.task.revision,
        expectedWorkspaceRevision: fresh.workspace.revision,
        intent: {
          objective: "changed",
          scope: scope({ paths: ["."] }),
          authorityRefs: [],
        },
        reason: "scope changed",
      }),
    ).toMatchObject({ ok: false, code: "recovery_required" });
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});
