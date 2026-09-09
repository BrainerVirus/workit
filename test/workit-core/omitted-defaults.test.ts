import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  canonicalJson,
  sha256,
  success,
  type OperationContext,
} from "../../packages/workit-core/src/core";
import { assessment, caller, scope, taskStartRequest } from "./task-fixtures";

const root = () => mkdtempSync(join(tmpdir(), "workit-defaults-"));
const context = (checkout: string): OperationContext => ({
  root: checkout,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  nativeRecovery: ({ writer }) =>
    success(null, null, {
      state: "accounted_for" as const,
      pid: 0,
      processStart: null,
      ownerDigest: writer ? sha256(canonicalJson(writer)) : null,
    }),
});

const start = (checkout: string, request: unknown = taskStartRequest()) => {
  const core = new WorkitCore(new TaskStore(checkout), context(checkout));
  const result = core.task(request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return { core, task: result.data as { id: string; revision: string } };
};

test("start omits the workspace revision on fresh and existing checkouts", () => {
  const checkout = root();
  const { intent } = taskStartRequest();
  const first = start(checkout, { schemaVersion: 1, action: "start", intent });
  const workspace = new TaskStore(checkout).readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace setup failed");
  const second = start(checkout, { schemaVersion: 1, action: "start", intent });
  expect(second.task.id).not.toBe(first.task.id);
});

test("mutating calls default omitted revisions to the current records", () => {
  const checkout = root();
  const { core, task } = start(checkout);
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: task.id,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  const progressed = core.task({
    schemaVersion: 1,
    action: "progress",
    taskId: task.id,
    progress: { summary: "defaults applied", nextAction: null, blockers: [] },
  });
  expect(progressed.ok).toBe(true);
});

test("explicit stale revisions still conflict", () => {
  const checkout = root();
  const { core, task } = start(checkout);
  const stale = core.task({
    schemaVersion: 1,
    action: "progress",
    taskId: task.id,
    expectedRevision: "00000000-0000-4000-8000-000000000000",
    progress: { summary: "stale", nextAction: null, blockers: [] },
  });
  expect(stale.ok).toBe(false);
  if (stale.ok) throw new Error("stale revision was accepted");
  expect(stale.code).toBe("revision_conflict");
});

test("check evidence auto-binds the captured candidate", () => {
  const checkout = root();
  const { core, task } = start(checkout);
  const recorded = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    evidence: {
      kind: "check",
      claim: "auto-bound check",
      requirementIds: [],
      result: "passed",
      summary: "no hand-computed digests",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error(recorded.error);
  const entry = recorded.data as unknown as {
    data: { beforeCandidateId: string | null; candidateId: string | null };
  };
  expect(entry.data.beforeCandidateId).not.toBeNull();
  expect(entry.data.candidateId).toBe(entry.data.beforeCandidateId);
});

test("writer acquire omits the worker identity for the lead caller", () => {
  const checkout = root();
  const store = new TaskStore(checkout);
  const core = new WorkitCore(store, context(checkout));
  const { task } = start(checkout);
  const acquired = core.writer({ schemaVersion: 1, action: "acquire", taskId: task.id });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error(acquired.error);
  const workspace = (
    acquired.data as unknown as { writer: { owner: { workerId: string | null } } | null }
  ).writer;
  expect(workspace?.owner.workerId).toBeNull();
  const released = core.writer({
    schemaVersion: 1,
    action: "release",
    taskId: task.id,
    reason: "defaults test done",
  });
  expect(released.ok).toBe(true);
});

test("worker assignment omits the candidate binding", () => {
  const checkout = root();
  const { core, task } = start(checkout);
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.id,
    assignment: {
      role: "investigator",
      objective: "defaults probe",
      scope: scope(),
      decisionIds: [],
      requirementIds: [],
      stoppingCondition: "report back",
    },
  });
  expect(assigned.ok).toBe(true);
});
