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
  type TaskRecord,
  type WorkspaceRecord,
} from "@/packages/workit-core/src/core";
import * as coreApi from "@/packages/workit-core/src/core";
import { assessment, caller, scope, taskStartRequest } from "./task-fixtures";

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
    }),
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

test("a late running observation after a terminal stop fails closed", () => {
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
  expect(
    lead.core.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId: lead.task.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: assigned.data.id,
      reason: "timeout",
    }),
  ).toMatchObject({ ok: true, data: { data: { state: "stopped" } } });
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const late = observeRunning(
    lead.core,
    lead.task.id,
    assigned.data.id,
    task.data.revision,
    workspace.data.revision,
  );
  expect(late).toMatchObject({ ok: false, code: "invalid_transition" });
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
        contentRefs: [],
      },
      response: "approved",
      requirementIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("raw worker authority is not part of the public core API", () => {
  expect((coreApi as Record<string, unknown>).verifyNativeWorker).toBeUndefined();
  expect((coreApi as Record<string, unknown>).observeWorkerLifecycle).toBeUndefined();
  expect((coreApi as Record<string, unknown>).prepareWorkerDispatch).toBeUndefined();
  expect((coreApi as Record<string, unknown>).commitWorkerDispatch).toBeUndefined();
});

test("an assigned worker that never launched is never marked stopped", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  if (!assigned.ok) throw new Error(assigned.error);
  const state = current(lead);
  expect(
    lead.core.observeWorkerLifecycle({
      taskId: lead.task.id,
      workerId: assigned.data.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      state: "stopped",
      session: null,
      observation: { event: "worker-stopped" },
    }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
  expect(
    current(lead).task.workers.find((entry) => entry.id === assigned.data.id)?.data,
  ).toMatchObject({ state: "assigned", session: null });
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
      report: {
        outcome: "completed",
        summary: "x",
        evidenceIds: [],
        findingIds: [],
      },
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

test("scope revision is denied while worker execution could be active", () => {
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

test("stopped helpers cannot mutate metadata after a task scope revision", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace, "investigator", ["src"]);
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
  expect(
    lead.core.observeWorkerLifecycle({
      taskId: lead.task.id,
      workerId: assigned.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      state: "stopped",
      session: { kind: "host", host: "workit_cli", handle: "worker-session" },
      observation: { event: "worker-stopped" },
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
      intent: { ...task.data.intent.data, scope: scope({ paths: ["docs"] }) },
      reason: "scope changed",
    }).ok,
  ).toBe(true);
  task = lead.store.readTask(lead.task.id);
  workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const staleHelper = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "worker-session" }),
      workerId: assigned.data.id,
    }),
  );
  expect(
    staleHelper.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      evidence: {
        kind: "investigation",
        claim: "stale",
        requirementIds: [],
        beforeCandidateId: null,
        candidateId: null,
        result: "passed",
        summary: "stale",
        refs: [{ kind: "file", path: "src/old.ts", digest: null }],
        exitCode: null,
        reviewContext: null,
      },
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    staleHelper.finding({
      schemaVersion: 1,
      action: "record",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      claim: "stale",
      consequence: "stale",
      scope: scope({ paths: ["src"] }),
      candidateId: null,
      refs: [{ kind: "file", path: "src/old.ts", digest: null }],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    staleHelper.worker({
      schemaVersion: 1,
      action: "report",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: assigned.data.id,
      report: {
        outcome: "completed",
        summary: "stale",
        evidenceIds: [],
        findingIds: [],
      },
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("a reviewer assignment without requirement ids fails on an assessed task", () => {
  const lead = active();
  const assessed = lead.core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: lead.task.id,
    expectedRevision: lead.task.revision,
    assessment: assessment({
      signals: {
        approachUnknown: {
          value: false,
          basis: "inferred",
          reason: "known",
          refs: [],
        },
        productChoiceOpen: {
          value: false,
          basis: "inferred",
          reason: "known",
          refs: [],
        },
        behaviorChange: {
          value: true,
          basis: "inferred",
          reason: "review required",
          refs: [],
        },
        mechanicalLowRisk: {
          value: false,
          basis: "inferred",
          reason: "not mechanical",
          refs: [],
        },
        durableAgreementNeeded: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
        coordinationPlanNeeded: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
        helperUseful: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
        testFirstPractical: {
          value: true,
          basis: "inferred",
          reason: "yes",
          refs: [],
        },
      },
    }),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const reviewId = (
    assessed.data as { requirements: Array<{ id: string; dimension: string }> }
  ).requirements.find((requirement) => requirement.dimension === "review")?.id;
  expect(reviewId).toBeDefined();
  const state = current(lead);
  const denied = lead.core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: lead.task.id,
    expectedRevision: state.task.revision,
    expectedWorkspaceRevision: state.workspace.revision,
    assignment: {
      role: "reviewer",
      objective: "verify the change",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report the result",
    },
  });
  expect(denied).toMatchObject({
    ok: false,
    code: "invalid_input",
    details: { requirementIds: [reviewId] },
  });
  const fresh = current(lead);
  const allowed = lead.core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: lead.task.id,
    expectedRevision: fresh.task.revision,
    expectedWorkspaceRevision: fresh.workspace.revision,
    assignment: {
      role: "reviewer",
      objective: "verify the change",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [reviewId!],
      candidateId: null,
      stoppingCondition: "report the result",
    },
  });
  expect(allowed.ok).toBe(true);
});

test("a completed worker report satisfies its delegation requirement", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assessed = lead.core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: lead.task.id,
    expectedRevision: lead.task.revision,
    assessment: assessment({
      signals: {
        approachUnknown: {
          value: false,
          basis: "inferred",
          reason: "known",
          refs: [],
        },
        productChoiceOpen: {
          value: false,
          basis: "inferred",
          reason: "known",
          refs: [],
        },
        behaviorChange: {
          value: false,
          basis: "inferred",
          reason: "mechanical",
          refs: [],
        },
        mechanicalLowRisk: {
          value: true,
          basis: "inferred",
          reason: "fixture",
          refs: [],
        },
        durableAgreementNeeded: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
        coordinationPlanNeeded: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
        helperUseful: {
          value: true,
          basis: "inferred",
          reason: "probe",
          refs: [],
        },
        testFirstPractical: {
          value: false,
          basis: "inferred",
          reason: "none",
          refs: [],
        },
      },
    }),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const delegationId = (
    assessed.data as { requirements: Array<{ id: string; ruleId: string }> }
  ).requirements.find((requirement) => requirement.ruleId === "helper-usefulness")?.id;
  expect(delegationId).toBeDefined();
  const statusOf = (): string | undefined => {
    const view = lead.core.task({
      schemaVersion: 1,
      action: "inspect",
      taskId: lead.task.id,
      view: "full",
    });
    if (!view.ok) throw new Error(view.error);
    return (
      view.data as {
        requirements: Array<{ requirementId: string; status: string }>;
      }
    ).requirements.find((entry) => entry.requirementId === delegationId)?.status;
  };
  expect(statusOf()).toBe("unsatisfied");
  const fresh = current(lead);
  const assigned = lead.core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: lead.task.id,
    expectedRevision: fresh.task.revision,
    expectedWorkspaceRevision: fresh.workspace.revision,
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
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  let state = current(lead);
  expect(
    observeRunning(
      lead.core,
      lead.task.id,
      assigned.data.id,
      state.task.revision,
      state.workspace.revision,
    ),
  ).toMatchObject({ ok: true });
  state = current(lead);
  const helper = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "worker-session" }),
      workerId: assigned.data.id,
    }),
  );
  expect(
    helper.worker({
      schemaVersion: 1,
      action: "report",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      workerId: assigned.data.id,
      report: {
        outcome: "completed",
        summary: "probe done",
        evidenceIds: [],
        findingIds: [],
      },
    }),
  ).toMatchObject({ ok: true });
  expect(statusOf()).toBe("satisfied");
});

test("a repeat cancel confirms an ended worker when no observation arrives", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  let state = current(lead);
  expect(
    observeRunning(
      lead.core,
      lead.task.id,
      assigned.data.id,
      state.task.revision,
      state.workspace.revision,
    ),
  ).toMatchObject({ ok: true });
  // The session end is never observed (missed host event). The lead-attested
  // cancel is terminal: the first cancel stops the worker, and the repeat is
  // an idempotent confirmation.
  state = current(lead);
  const cancel = (reason: string) => {
    const fresh = current(lead);
    return lead.core.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId: lead.task.id,
      expectedRevision: fresh.task.revision,
      expectedWorkspaceRevision: fresh.workspace.revision,
      workerId: assigned.data.id,
      reason,
    });
  };
  expect(cancel("session silent, asking it to stop")).toMatchObject({
    ok: true,
    data: { data: { state: "stopped" } },
  });
  expect(cancel("session ended without an observed stop, confirmed")).toMatchObject({
    ok: true,
    data: { data: { state: "stopped" } },
  });
  state = current(lead);
  expect(
    lead.core.task({
      schemaVersion: 1,
      action: "pause",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      reason: "lifecycle gates see no reconciliation",
    }),
  ).toMatchObject({ ok: true });
});

test("cancel on a worker that already reported stops it instead of stranding it", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  expect(assigned.ok).toBe(true);
  if (!assigned.ok) throw new Error(assigned.error);
  let state = current(lead);
  expect(
    observeRunning(
      lead.core,
      lead.task.id,
      assigned.data.id,
      state.task.revision,
      state.workspace.revision,
    ),
  ).toMatchObject({ ok: true });
  state = current(lead);
  const helper = new WorkitCore(
    lead.store,
    context(lead.root, {
      caller: caller({ actor: "worker-session" }),
      workerId: assigned.data.id,
    }),
  );
  expect(
    helper.worker({
      schemaVersion: 1,
      action: "report",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      workerId: assigned.data.id,
      report: {
        outcome: "completed",
        summary: "file written",
        evidenceIds: [],
        findingIds: [],
      },
    }),
  ).toMatchObject({ ok: true });
  // The child session end is never observed (missed host event). The lead
  // cancel that a reasonable agent tries must settle the reported worker.
  state = current(lead);
  const cancelled = lead.core.worker({
    schemaVersion: 1,
    action: "cancel",
    taskId: lead.task.id,
    expectedRevision: state.task.revision,
    expectedWorkspaceRevision: state.workspace.revision,
    workerId: assigned.data.id,
    reason: "session ended without an observed stop",
  });
  expect(cancelled).toMatchObject({
    ok: true,
    data: { data: { state: "stopped" } },
  });
  state = current(lead);
  expect(
    lead.core.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      workerId: assigned.data.id,
      reason: "already stopped",
    }),
  ).toMatchObject({ ok: true, data: { data: { state: "stopped" } } });
  expect(
    lead.core.task({
      schemaVersion: 1,
      action: "pause",
      taskId: lead.task.id,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      reason: "lifecycle gates see no reconciliation",
    }),
  ).toMatchObject({ ok: true });
});

test("a lifecycle transition bumps the revision but a repeated identical observation does not", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  const assigned = assign(lead.core, lead.task, lead.workspace);
  if (!assigned.ok) throw new Error(assigned.error);
  const workerId = assigned.data.id;
  const session = {
    kind: "host",
    host: "workit_cli",
    handle: "worker-session",
  } as const;
  const observe = () => {
    const state = current(lead);
    return lead.core.observeWorkerLifecycle({
      taskId: lead.task.id,
      workerId,
      expectedRevision: state.task.revision,
      expectedWorkspaceRevision: state.workspace.revision,
      state: "running",
      session: { ...session },
      observation: { event: "worker-started" },
    });
  };
  const preRevision = current(lead).task.revision;
  const first = observe();
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  // Genuine transition (assigned -> running) still mutates.
  expect(first.revision).not.toBe(preRevision);
  // A no-op observation (same state, same session) must not bump revisions,
  // or worker sessions can never chain two calls: every observation would
  // invalidate the revision the previous call returned.
  const second = observe();
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.error);
  expect(second.revision).toBe(first.revision);
  expect(second.workspaceRevision).toBe(first.workspaceRevision);
});
