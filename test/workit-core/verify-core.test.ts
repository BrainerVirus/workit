import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  captureCandidate,
  findingVerificationPasses,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
  type TaskRecord,
  type WorkspaceRecord,
} from "@/packages/workit-core/src/core";
import { scope, caller, taskStartRequest } from "./task-fixtures";

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: caller(),
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
  const root = mkdtempSync(join(tmpdir(), "workit-verify-core-"));
  writeFileSync(join(root, "a.ts"), "before");
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root, options));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active state missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

const assignPinned = (
  core: WorkitCore,
  task: TaskRecord,
  workspace: WorkspaceRecord,
  candidateId: string | null,
) =>
  core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.revision,
    assignment: {
      role: "investigator",
      objective: "inspect the pinned candidate",
      scope: scope({ paths: ["src"] }),
      decisionIds: [],
      requirementIds: [],
      candidateId,
      stoppingCondition: "report",
    },
  });

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

const current = (lead: ReturnType<typeof active>) => {
  const task = lead.store.readTask(lead.task.id);
  const workspace = lead.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  return { task: task.data, workspace: workspace.data };
};

const helperCore = (lead: ReturnType<typeof active>, workerId: string) =>
  new WorkitCore(
    lead.store,
    context(lead.root, { workerId, caller: caller({ actor: "worker-session" }) }),
  );

test("a pinned helper defaults its evidence binding to the pin", () => {
  const lead = active({ nativeWorker: observationVerifier() });
  try {
    const seed = lead.core.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      evidence: {
        kind: "check",
        claim: "seed check",
        requirementIds: [],
        result: "passed",
        summary: "seed",
        refs: [],
        exitCode: 0,
        reviewContext: null,
      },
    });
    if (!seed.ok) throw new Error(seed.error);
    const pin = (seed.data as { data: { candidateId: string } }).data.candidateId;
    const assigned = assignPinned(lead.core, current(lead).task, current(lead).workspace, pin);
    if (!assigned.ok) throw new Error(assigned.error);
    const state = current(lead);
    expect(
      observeRunning(lead.core, lead.task.id, assigned.data.id, state.task, state.workspace).ok,
    ).toBe(true);
    writeFileSync(join(lead.root, "a.ts"), "after");
    const helper = helperCore(lead, assigned.data.id);
    const recorded = helper.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      evidence: {
        kind: "check",
        claim: "pinned check",
        requirementIds: [],
        result: "passed",
        summary: "checked the pinned candidate",
        refs: [],
        exitCode: 0,
        reviewContext: null,
      },
    });
    expect(recorded).toMatchObject({ ok: true });
    if (!recorded.ok) throw new Error(recorded.error);
    expect(recorded.data.data.beforeCandidateId).toBe(pin);
    expect(recorded.data.data.candidateId).toBe(pin);
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});

test("findingVerificationPasses unifies the fixed-finding predicate", () => {
  expect(
    findingVerificationPasses(null, { kind: "check", candidateId: "c1", status: "passed" }),
  ).toBe(true);
  expect(
    findingVerificationPasses("c1", { kind: "review", candidateId: "c1", status: "passed" }),
  ).toBe(true);
  expect(
    findingVerificationPasses("c1", { kind: "check", candidateId: "c2", status: "passed" }),
  ).toBe(false);
  expect(
    findingVerificationPasses(null, { kind: "artifact", candidateId: null, status: "passed" }),
  ).toBe(false);
  expect(
    findingVerificationPasses(null, { kind: "check", candidateId: null, status: "failed" }),
  ).toBe(false);
});

test("dismissal relevance ignores reference key order", () => {
  const lead = active();
  try {
    const captured = captureCandidate(lead.root, scope(), []);
    if (!captured.ok) throw new Error(captured.error);
    const setup = lead.core.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      evidence: {
        kind: "check",
        claim: "setup check",
        requirementIds: [],
        result: "passed",
        summary: "setup",
        refs: [],
        exitCode: 0,
        reviewContext: null,
      },
    });
    expect(setup.ok).toBe(true);
    const recorded = lead.core.finding({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      claim: "stale import",
      consequence: "breaks the build",
      scope: scope({ paths: ["src"] }),
      candidateId: captured.data.id,
      refs: [{ kind: "file", path: "src/a.ts", digest: null }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error(recorded.error);
    const findingId = (recorded.data as { id: string }).id;
    const evidence = lead.core.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: lead.task.id,
      evidence: {
        kind: "check",
        claim: "removed import",
        requirementIds: [],
        result: "passed",
        summary: "import removed",
        refs: [{ digest: null, path: "src/a.ts", kind: "file" } as never],
        exitCode: 0,
        reviewContext: null,
      },
    });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) throw new Error(evidence.error);
    const evidenceId = (evidence.data as { id: string }).id;
    const resolved = lead.core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: lead.task.id,
      findingId,
      disposition: "dismissed",
      reason: "gone",
      evidenceIds: [evidenceId],
      decisionIds: [],
    });
    expect(resolved).toMatchObject({ ok: true });
  } finally {
    rmSync(lead.root, { recursive: true, force: true });
  }
});
