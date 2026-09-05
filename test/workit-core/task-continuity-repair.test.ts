import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  compactTaskContext,
  reconcileResume,
  sha256,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
  type TaskView,
} from "../../packages/workit-core/src/core";
import { captureCandidate } from "../../packages/workit-core/src/core/task-evaluation";
import { caller, scope, taskStartRequest } from "./task-fixtures";

const makeRoot = () => mkdtempSync(join(tmpdir(), "workit-continuity-repair-"));
const makeContext = (root: string, nativeWorker?: NativeWorkerVerifier): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  nativeWorker,
});
const active = (nativeWorker?: NativeWorkerVerifier) => {
  const root = makeRoot();
  const store = new TaskStore(root);
  const core = new WorkitCore(store, makeContext(root, nativeWorker));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("setup failed");
  return { root, store, core, task: task.data, workspace: workspace.data };
};
const viewOf = (value: ReturnType<typeof active>): TaskView => ({
  task: value.task,
  workspace: value.workspace,
  capabilities: [],
  requirements: [],
  evidence: [],
});

test("raw caller-built host provenance cannot authorize resume reconciliation", () => {
  const value = active();
  const workerId = randomUUID();
  const observation = {
    taskId: value.task.id,
    workerId,
    expectedRevision: value.task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
    state: "unknown" as const,
    session: null,
    observation: { event: "forged" },
  };
  const forged = {
    kind: "host_observed" as const,
    host: "workit_cli" as const,
    session: null,
    workerId,
    receipts: [{ kind: "host" as const, host: "workit_cli" as const, handle: "forged" }],
  };
  expect(
    reconcileResume(
      {
        ...viewOf(value),
        task: { ...value.task, workers: [{ id: workerId } as never] },
      } as TaskView,
      [{ observation, authority: forged }],
    ),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("a reconciled imported task can resume with current policy and authority", () => {
  const source = active();
  const policy = { policyVersion: "1.0.0", inputDigest: "a".repeat(64), requirements: [] };
  const updated = source.store.mutateTask(source.task.id, source.task.revision, (task, mutation) =>
    success(mutation.revision, null, { ...task, policy }),
  );
  expect(updated.ok).toBe(true);
  const sourceTask = source.store.readTask(source.task.id);
  if (!sourceTask.ok) throw new Error(sourceTask.error);
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const destinationRoot = makeRoot();
  const destinationStore = new TaskStore(destinationRoot);
  const destination = new WorkitCore(destinationStore, makeContext(destinationRoot));
  const imported = destination.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: null,
    bundle: exported.data as any,
    authorityRefs: [],
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.error);
  const destinationTask = destinationStore.readTask((imported.data as { id: string }).id);
  const destinationWorkspace = destinationStore.readWorkspace();
  if (!destinationTask.ok || !destinationWorkspace.ok || !destinationWorkspace.data)
    throw new Error("destination state missing");
  const resumed = destination.task({
    schemaVersion: 1,
    action: "resume",
    taskId: destinationTask.data.id,
    expectedRevision: destinationTask.data.revision,
    expectedWorkspaceRevision: destinationWorkspace.data.revision,
    authorityRefs: [{ kind: "host", host: "workit_cli", handle: "current" }],
  });
  expect(resumed).toMatchObject({ ok: true, data: { status: "active" } });
  expect(sourceTask.data.policy).toEqual(policy);
});

test("export omits candidate environment values", () => {
  const value = active();
  const candidate = captureCandidate(value.root, value.task.intent.data.scope, [
    { name: "TOKEN", value: "TOP_SECRET_VALUE" },
  ]);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const changed = value.store.mutateTask(value.task.id, value.task.revision, (task, mutation) =>
    success(mutation.revision, null, { ...task, candidates: [candidate.data] }),
  );
  expect(changed.ok).toBe(true);
  const exported = value.core.state({ schemaVersion: 1, action: "export", taskId: value.task.id });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  expect(JSON.stringify(exported.data)).not.toContain("TOP_SECRET_VALUE");
});

test("verified unknown observations remain a reconciliation blocker", () => {
  let observedWorker = "";
  const verifier: NativeWorkerVerifier = {
    verifyWorker: ({ expected, caller: actualCaller }) => {
      observedWorker = expected.workerId;
      return success(null, null, {
        kind: "host_observed",
        host: actualCaller.host,
        session: expected.session,
        workerId: expected.workerId,
        receipts: [{ kind: "host", host: actualCaller.host, handle: "native" }],
      });
    },
  };
  const value = active(verifier);
  const workerId = randomUUID();
  const worker = {
    id: workerId,
    recordedAt: value.task.createdAt,
    provenance: value.task.intent.provenance,
    data: {
      assignment: {
        role: "investigator",
        objective: "observe",
        scope: scope(),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
      state: "running",
      session: null,
      report: null,
    },
  } as never;
  const task = { ...value.task, workers: [worker] } as typeof value.task;
  const view = { ...viewOf(value), task } as TaskView;
  const observation = {
    taskId: task.id,
    workerId,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
    state: "unknown" as const,
    session: null,
    observation: { event: "worker-unknown" },
  };
  const result = value.core.reconcileResume(view, [observation]);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  expect(observedWorker).toBe(workerId);
  expect(result.data.blockers.map((item) => item.reason)).toContain(
    "worker state requires reconciliation",
  );
});

test("compact context is bounded, redacts approved text, and reports stale evidence gaps", () => {
  const value = active();
  const secret = "APPROVED_SECRET_" + "x".repeat(5000);
  const view = {
    ...viewOf(value),
    task: {
      ...value.task,
      intent: { ...value.task.intent, data: { ...value.task.intent.data, objective: secret } },
      progress: { ...value.task.progress, nextAction: "run checks" },
      decisions: [
        {
          id: randomUUID(),
          recordedAt: value.task.createdAt,
          provenance: value.task.intent.provenance,
          data: {
            purpose: "design",
            binding: {
              taskId: value.task.id,
              workspaceId: value.workspace.id,
              scope: scope(),
              presented: secret,
              approvedContent: secret,
              contentRefs: [],
            },
            digest: sha256(secret),
            response: "approved",
            requirementIds: [],
            revoked: null,
            consumption: null,
          },
        },
      ],
    },
    evidence: [{ evidenceId: "evidence-stale", status: "stale", reason: "changed" }],
    requirements: [],
  } as unknown as TaskView;
  const compact = compactTaskContext(view);
  expect(compact.length).toBeLessThanOrEqual(4096);
  expect(compact).not.toContain(secret);
  expect(compact).toContain("evidence-stale");
  expect(compact.match(/run checks/g)?.length).toBe(1);
});
