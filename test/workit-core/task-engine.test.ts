import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  captureCandidate,
  decisionDigest,
  evaluateClosure,
  newId,
  success,
  type OperationContext,
} from "../../packages/workit-core/src/core";
import { assessment, caller, ref, scope, taskStartRequest } from "./task-fixtures";

const context = (root: string): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

test("a task starts active and inspection is read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(
    taskStartRequest({ intent: { objective: "x", scope: scope(), authorityRefs: [ref()] } }),
  );
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const taskId = (started.data as any).id as string;
  const before = store.readTask(taskId);
  const inspected = core.task({
    schemaVersion: 1,
    action: "inspect",
    taskId,
    view: "full",
  });
  expect(inspected.ok).toBe(true);
  expect(store.readTask(taskId)).toEqual(before);
});

test("lifecycle pauses, resumes, and stops without reopening", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const task = store.listTasks();
  if (!task.ok || !task.data[0]) return;
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) return;
  const paused = core.task({
    schemaVersion: 1,
    action: "pause",
    taskId: task.data[0].id,
    expectedRevision: task.data[0].revision,
    expectedWorkspaceRevision: workspace.data.revision,
    reason: "wait",
  });
  expect(paused.ok).toBe(true);
  const pausedTask = store.readTask(task.data[0].id);
  const pausedWorkspace = store.readWorkspace();
  if (!pausedTask.ok || !pausedWorkspace.ok || !pausedWorkspace.data) return;
  const resumed = core.task({
    schemaVersion: 1,
    action: "resume",
    taskId: task.data[0].id,
    expectedRevision: pausedTask.data.revision,
    expectedWorkspaceRevision: pausedWorkspace.data.revision,
    authorityRefs: [],
  });
  expect(resumed.ok).toBe(true);
  const activeTask = store.readTask(task.data[0].id);
  const activeWorkspace = store.readWorkspace();
  if (!activeTask.ok || !activeWorkspace.ok || !activeWorkspace.data) return;
  const stopped = core.task({
    schemaVersion: 1,
    action: "close",
    taskId: activeTask.data.id,
    expectedRevision: activeTask.data.revision,
    expectedWorkspaceRevision: activeWorkspace.data.revision,
    outcome: "stopped",
    summary: "stopped",
    decisionIds: [],
  });
  expect(stopped).toMatchObject({
    ok: true,
    data: { status: "closed", closure: { outcome: "stopped" } },
  });
  const closed = store.readTask(task.data[0].id);
  if (!closed.ok) return;
  expect(
    core.task({
      schemaVersion: 1,
      action: "resume",
      taskId: closed.data.id,
      expectedRevision: closed.data.revision,
      expectedWorkspaceRevision: activeWorkspace.data.revision,
      authorityRefs: [],
    }),
  ).toMatchObject({ ok: false, code: "invalid_transition" });
});

test("candidate capture preserves executable and symlink metadata without following links", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-"));
  writeFileSync(join(root, "run.sh"), "echo hi");
  chmodSync(join(root, "run.sh"), 0o755);
  symlinkSync("../outside", join(root, "escape"));
  const result = captureCandidate(root, scope(), []);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "run.sh", kind: "file", executable: true }),
      expect.objectContaining({ path: "escape", kind: "symlink", executable: null }),
    ]),
  );
});

test("verified closure requires an assessed policy and current evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) return;
  const task = store.listTasks();
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data[0] || !workspace.ok || !workspace.data) return;
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId: task.data[0].id,
      expectedRevision: task.data[0].revision,
      expectedWorkspaceRevision: workspace.data.revision,
      outcome: "verified",
      summary: "done",
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
});

test("policy preview is pure and closure requires every applicable evidence type", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) return;
  const task = store.listTasks();
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data[0] || !workspace.ok || !workspace.data) return;
  const preview = core.policy({
    schemaVersion: 1,
    action: "preview",
    taskId: task.data[0].id,
    assessment: assessment(),
  });
  expect(preview.ok).toBe(true);
  expect(store.readTask(task.data[0].id)).toMatchObject({ ok: true, data: task.data[0] });
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: task.data[0].id,
    expectedRevision: task.data[0].revision,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  const assessedTask = store.readTask(task.data[0].id);
  const assessedWorkspace = store.readWorkspace();
  if (
    !assessedTask.ok ||
    !assessedWorkspace.ok ||
    !assessedWorkspace.data ||
    !assessedTask.data.policy
  )
    return;
  const ids = assessedTask.data.policy.requirements.map((item) => item.id);
  const check = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: assessedTask.data.id,
    expectedRevision: assessedTask.data.revision,
    evidence: {
      kind: "check",
      claim: "checks",
      requirementIds: ids,
      beforeCandidateId: null,
      candidateId: null,
      result: "passed",
      summary: "passed",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(check.ok).toBe(true);
  const afterCheck = store.readTask(assessedTask.data.id);
  const afterCheckWorkspace = store.readWorkspace();
  if (!afterCheck.ok || !afterCheckWorkspace.ok || !afterCheckWorkspace.data) return;
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId: afterCheck.data.id,
      expectedRevision: afterCheck.data.revision,
      expectedWorkspaceRevision: afterCheckWorkspace.data.revision,
      outcome: "verified",
      summary: "done",
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
});

test("an applicable approved limitation satisfies only its permitted requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) return;
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !listed.data[0] || !workspace.ok || !workspace.data) return;
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: listed.data[0].id,
    expectedRevision: listed.data[0].revision,
    assessment: assessment(),
  });
  if (!assessed.ok) return;
  const task = store.readTask(listed.data[0].id);
  if (!task.ok || !task.data.policy) return;
  const requirement = task.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) return;
  const decisionBase = {
    purpose: "limitation" as const,
    binding: {
      taskId: task.data.id,
      workspaceId: workspace.data.id,
      scope: task.data.intent.data.scope,
      presented: "accept",
      approvedContent: "accept",
      contentRefs: [],
    },
    response: "approved" as const,
    requirementIds: [requirement.id],
    revoked: null,
    consumption: null,
  };
  const decision = { ...decisionBase, digest: decisionDigest(decisionBase as any) } as any;
  const changed = store.mutateTask(task.data.id, task.data.revision, (current, mutation) =>
    success(mutation.revision, null, {
      ...current,
      decisions: [
        ...current.decisions,
        {
          id: newId(),
          recordedAt: mutation.now,
          provenance: {
            kind: "host_observed",
            host: "workit_cli",
            session: null,
            workerId: null,
            receipts: [],
          },
          data: decision,
        },
      ],
    }),
  );
  if (!changed.ok) return;
  const view = core.task({
    schemaVersion: 1,
    action: "inspect",
    taskId: task.data.id,
    view: "full",
  });
  const closureForVerified =
    view.ok && "task" in view.data ? evaluateClosure("verified", view.data) : null;
  expect(view).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: requirement.id, status: "accepted_limitation" }),
      ]),
    },
  });
  if (closureForVerified)
    expect(closureForVerified).toMatchObject({
      ok: false,
      code: "requirements_unsatisfied",
    });
});

test("a passing repository check does not satisfy an untested behavior requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) return;
  const listed = store.listTasks();
  if (!listed.ok || !listed.data[0]) return;
  const behavior = assessment({
    signals: {
      ...assessment().signals,
      approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
      productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
      behaviorChange: { value: true, basis: "observed", reason: "behavior", refs: [ref()] },
      mechanicalLowRisk: { value: false, basis: "inferred", reason: "not mechanical", refs: [] },
    },
  });
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: listed.data[0].id,
    expectedRevision: listed.data[0].revision,
    assessment: behavior,
  });
  if (!assessed.ok) return;
  const task = store.readTask(listed.data[0].id);
  if (!task.ok || !task.data.policy) return;
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) return;
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "check",
      claim: "repository checks exit zero",
      requirementIds: task.data.policy.requirements.map((item) => item.id),
      beforeCandidateId: null,
      candidateId: null,
      result: "passed",
      summary: "passed",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(evidence.ok).toBe(true);
  const after = store.readTask(task.data.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data) return;
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId: after.data.id,
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
      outcome: "verified",
      summary: "done",
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
});
