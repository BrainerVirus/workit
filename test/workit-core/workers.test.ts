import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
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
} from "../../packages/workit-core/src/core";
import * as coreApi from "../../packages/workit-core/src/core";
import { caller, scope, taskStartRequest } from "./task-fixtures";

const now = "2026-01-01T00:00:00Z";

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now,
  ...options,
});

const active = (options: Partial<OperationContext> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "workit-workers-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root, options));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active state missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

const assign = (
  core: WorkitCore,
  task: TaskRecord,
  workspace: WorkspaceRecord,
  role: "investigator" | "reviewer" | "implementer" = "implementer",
  paths = ["src"],
) =>
  core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    assignment: {
      role,
      objective: "inspect the assigned area",
      scope: scope({ paths }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report the result",
    },
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

const observeRunning = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
  session = "worker-session",
) =>
  core.observeWorkerLifecycle({
    taskId,
    workerId,
    expectedRevision,
    expectedWorkspaceRevision,
    state: "running",
    session: { kind: "host", host: "workit_cli", handle: session },
    observation: { event: "worker-started" },
  });

test("assignment is not launch and worker lifecycle requires native observation", () => {
  const lead = active();
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned).toMatchObject({
    ok: true,
    data: { data: { state: "assigned", session: null } },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const workerId = assigned.data.data.assignment ? assigned.data.id : "";
  const denied = lead.core.observeWorkerLifecycle({
    taskId: lead.task.id,
    workerId,
    expectedRevision: assigned.revision!,
    expectedWorkspaceRevision: assigned.workspaceRevision!,
    state: "running",
    session: { kind: "host", host: "workit_cli", handle: "worker-session" },
    observation: { event: "worker-started" },
  });
  expect(denied).toMatchObject({ ok: false, code: "permission_denied" });
});

test("only an observed implementer with the exact session can acquire the writer", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const taskAfterAssign = lead.store.readTask(lead.task.id);
  const workspaceAfterAssign = lead.store.readWorkspace();
  if (!taskAfterAssign.ok || !workspaceAfterAssign.ok || !workspaceAfterAssign.data)
    throw new Error("assigned state missing");
  const observed = observeRunning(
    lead.core,
    lead.task.id,
    assigned.data.id,
    taskAfterAssign.data.revision,
    workspaceAfterAssign.data.revision,
  );
  expect(observed).toMatchObject({ ok: true, data: { data: { state: "running" } } });
  const helper = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "worker-session" }),
      workerId: assigned.data.id,
    }),
  );
  const currentTask = lead.store.readTask(lead.task.id);
  const currentWorkspace = lead.store.readWorkspace();
  if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("observed state missing");
  const wrongSession = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "other-session" }),
      workerId: assigned.data.id,
    }),
  );
  expect(
    wrongSession.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: lead.task.id,
      expectedRevision: currentTask.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      workerId: assigned.data.id,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    helper.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: lead.task.id,
      expectedRevision: currentTask.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      workerId: assigned.data.id,
    }),
  ).toMatchObject({ ok: true, data: { writer: { state: "held" } } });
});

test("investigators and reviewers remain read-only", () => {
  const lead = active();
  for (const role of ["investigator", "reviewer"] as const) {
    const currentTask = lead.store.readTask(lead.task.id);
    const currentWorkspace = lead.store.readWorkspace();
    if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("state missing");
    const assigned = assign(lead.core, currentTask.data, currentWorkspace.data, role);
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) throw new Error(assigned.error);
    const task = lead.store.readTask(lead.task.id);
    const workspace = lead.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const helper = new WorkitCore(
      lead.store,
      context(lead.root, {
        caller: caller({ actor: "worker-session" }),
        workerId: assigned.data.id,
      }),
    );
    expect(
      helper.writer({
        schemaVersion: 1,
        action: "acquire",
        taskId: lead.task.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: assigned.data.id,
      }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
  }
});

test("a cancelling worker keeps ownership until an observed stop", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  let task = lead.store.readTask(lead.task.id);
  let workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    observeRunning(
      lead.core,
      lead.task.id,
      assigned.data.id,
      task.data.revision,
      workspace.data.revision,
    ).ok,
  ).toBe(true);
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const helper = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "worker-session" }),
      workerId: assigned.data.id,
    }),
  );
  expect(
    helper.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: lead.task.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: assigned.data.id,
    }).ok,
  ).toBe(true);
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const cancelled = lead.core.worker({
    schemaVersion: 1,
    action: "cancel",
    taskId: lead.task.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workerId: assigned.data.id,
    reason: "timeout",
  });
  expect(cancelled).toMatchObject({ ok: true, data: { data: { state: "cancelling" } } });
  const replacement = new WorkitCore(lead.store, context(lead.root));
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    replacement.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: lead.task.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    }),
  ).toMatchObject({ ok: false, code: "recovery_required" });
});

test("helpers cannot change lifecycle, scope, decisions, assign helpers, or resolve findings", () => {
  const lead = active();
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const helper = new WorkitCore(lead.store, context(lead.root, { workerId: assigned.data.id }));
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    helper.task({
      schemaVersion: 1,
      action: "pause",
      taskId: lead.task.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "pause",
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    helper.decision({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      expectedRevision: task.data.revision,
      purpose: "design",
      binding: {
        taskId: lead.task.id,
        workspaceId: lead.task.workspaceId,
        scope: scope(),
        presented: "x",
        approvedContent: "x",
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("product writes require the current writer and assigned paths", () => {
  const lead = active();
  const assigned = assign(lead.core, lead.task, lead.workspace, "implementer", ["src"]);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const helper = new WorkitCore(lead.store, context(lead.root, { workerId: assigned.data.id }));
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    helper.assertProductWriteAllowed({
      task: task.data,
      workspace: workspace.data,
      paths: ["src/a.ts"],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    helper.assertProductWriteAllowed({
      task: task.data,
      workspace: workspace.data,
      paths: ["../secret"],
    }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("write authorization ignores forged snapshots and rejects symlink escapes", () => {
  const lead = active();
  const assigned = assign(lead.core, lead.task, lead.workspace, "implementer", ["src"]);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const helper = new WorkitCore(lead.store, context(lead.root, { workerId: assigned.data.id }));
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const outside = mkdtempSync(join(tmpdir(), "workit-outside-"));
  mkdirSync(join(lead.root, "links"));
  symlinkSync(outside, join(lead.root, "links", "outside"), "dir");
  try {
    const forgedTask = {
      ...task.data,
      workers: task.data.workers.map((entry) => ({
        ...entry,
        data: {
          ...entry.data,
          state: "running" as const,
          session: { kind: "host" as const, host: "workit_cli" as const, handle: "worker-session" },
          assignment: { ...entry.data.assignment, scope: scope() },
        },
      })),
    };
    const forgedWorkspace = {
      ...workspace.data,
      writer: {
        state: "held" as const,
        owner: {
          taskId: task.data.id,
          workerId: assigned.data.id,
          session: { kind: "host" as const, host: "workit_cli" as const, handle: "worker-session" },
        },
        acquiredAt: now,
      },
    };
    expect(
      helper.assertProductWriteAllowed({
        task: forgedTask,
        workspace: forgedWorkspace,
        paths: ["src/new.ts"],
      }),
    ).toMatchObject({ ok: false, code: "permission_denied" });
    expect(
      helper.assertProductWriteAllowed({
        task: task.data,
        workspace: workspace.data,
        paths: ["links/outside/new.ts"],
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    // The fixture directory is process-scoped and cleaned by the test runner.
  }
});

test("raw worker authority is not part of the public core API", () => {
  expect((coreApi as Record<string, unknown>).verifyNativeWorker).toBeUndefined();
  expect((coreApi as Record<string, unknown>).observeWorkerLifecycle).toBeUndefined();
});

test("unobserved helpers cannot report metadata or escape assignment file scope", () => {
  const lead = active();
  const assigned = assign(lead.core, lead.task, lead.workspace, "investigator", ["src"]);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  const helper = new WorkitCore(lead.store, context(lead.root, { workerId: assigned.data.id }));
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const evidence = helper.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "investigation",
      claim: "x",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "passed",
      summary: "x",
      refs: [{ kind: "file", path: "outside.txt", digest: null }],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(evidence).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    helper.worker({
      schemaVersion: 1,
      action: "report",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: assigned.data.id,
      report: { outcome: "completed", summary: "x", evidenceIds: [], findingIds: [] },
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("a helper cannot submit a native lifecycle observation for another worker", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const first = assign(lead.core, lead.task, lead.workspace);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const second = assign(lead.core, task.data, workspace.data);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.error);
  const currentTask = lead.store.readTask(lead.task.id);
  const currentWorkspace = lead.store.readWorkspace();
  if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const helper = new WorkitCore(lead.store, context(lead.root, { workerId: first.data.id }));
  expect(
    observeRunning(
      helper,
      lead.task.id,
      second.data.id,
      currentTask.data.revision,
      currentWorkspace.data.revision,
    ),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("scope revision is denied while worker ownership or execution could be active", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  let task = lead.store.readTask(lead.task.id);
  let workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    observeRunning(
      lead.core,
      lead.task.id,
      assigned.data.id,
      task.data.revision,
      workspace.data.revision,
    ).ok,
  ).toBe(true);
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const helper = new WorkitCore(
    lead.store,
    context(lead.root, { workerId: assigned.data.id, caller: caller({ actor: "worker-session" }) }),
  );
  expect(
    helper.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: assigned.data.id,
    }).ok,
  ).toBe(true);
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    lead.core.task({
      schemaVersion: 1,
      action: "revise",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      intent: { ...task.data.intent.data, scope: scope({ paths: ["other"] }) },
      reason: "scope changed",
    }),
  ).toMatchObject({ ok: false, code: "recovery_required" });
});
