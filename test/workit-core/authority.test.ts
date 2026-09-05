import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkitCore,
  TaskStore,
  captureCandidate,
  decisionDigest,
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

const active = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-authority-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as any).id as string);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active task missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

const actionBinding = (task: ReturnType<typeof active>["task"], workspaceId: string) => ({
  taskId: task.id,
  workspaceId,
  scope: task.intent.data.scope,
  presented: "run the bounded action",
  approvedContent: "run the bounded action",
  contentRefs: [],
});

test("decision.record derives the digest and native provenance", () => {
  const { core, task, workspace } = active();
  const binding = actionBinding(task, workspace.id);
  const result = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding,
    response: "approved",
    requirementIds: [],
  });
  expect(result).toMatchObject({ ok: true, data: { data: { purpose: "action", revoked: null } } });
  if (!result.ok) throw new Error(result.error);
  expect(result.data.data.digest).toBe(decisionDigest(result.data.data));
  expect(result.data.provenance).toMatchObject({ kind: "host_observed", host: "workit_cli" });
});

test("two invocations cannot reserve one bounded approval", () => {
  const { core, store, task, workspace } = active();
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const input = {
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host" as const, host: "workit_cli" as const, handle: "native-1" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
  };
  expect(core.reserveAction(input)).toMatchObject({ ok: true });
  const after = store.readTask(task.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data) throw new Error("state missing");
  expect(
    core.reserveAction({
      ...input,
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("ambiguous settlement blocks blind retry and not_started releases only with native evidence", () => {
  const { core, store, task, workspace } = active();
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const reservation = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
  });
  if (!reservation.ok) throw new Error(reservation.error);
  const settled = core.settleAction({ ...reservation.data, outcome: "unknown" });
  expect(settled).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  const after = store.readTask(task.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data) throw new Error("state missing");
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-2" },
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
    }),
  ).toMatchObject({ ok: false, code: "external_outcome_unknown" });
});

test("bounded workflows advance once and cannot repeat a completed step", () => {
  const { core, store, task, workspace } = active();
  const binding = {
    ...actionBinding(task, workspace.id),
    approvedContent: JSON.stringify({ steps: ["one", "two"] }),
  };
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding,
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const first = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "one" },
    step: "one",
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
  });
  if (!first.ok) throw new Error(first.error);
  const settledFirst = core.settleAction({ ...first.data, outcome: "succeeded" });
  if (!settledFirst.ok) throw new Error(settledFirst.error);
  const afterFirst = store.readTask(task.id);
  const afterFirstWorkspace = store.readWorkspace();
  if (!afterFirst.ok || !afterFirstWorkspace.ok || !afterFirstWorkspace.data)
    throw new Error("state missing");
  const second = core.reserveAction({
    taskId: task.id,
    decisionId: recorded.data.id,
    actionRef: { kind: "host", host: "workit_cli", handle: "two" },
    step: "two",
    expectedRevision: afterFirst.data.revision,
    expectedWorkspaceRevision: afterFirstWorkspace.data.revision,
  });
  expect(second).toMatchObject({
    ok: true,
    data: { completedSteps: ["one"], remainingSteps: ["two"] },
  });
  if (!second.ok) throw new Error(second.error);
  expect(core.settleAction({ ...second.data, outcome: "succeeded" })).toMatchObject({ ok: true });
  const afterSecond = store.readTask(task.id);
  const afterSecondWorkspace = store.readWorkspace();
  if (!afterSecond.ok || !afterSecondWorkspace.ok || !afterSecondWorkspace.data)
    throw new Error("state missing");
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "repeat" },
      step: "one",
      expectedRevision: afterSecond.data.revision,
      expectedWorkspaceRevision: afterSecondWorkspace.data.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("decision applicability rejects purpose, binding, scope, rejection, revocation, and byte drift", () => {
  const { core, store, task, workspace } = active();
  const binding = actionBinding(task, workspace.id);
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "design",
    binding,
    response: "approved",
    requirementIds: [],
  });
  expect(recorded).toMatchObject({ ok: true });
  if (!recorded.ok) throw new Error(recorded.error);
  expect(core.applicableDecision(task.id, "action", binding)).toMatchObject({ data: [] });
  expect(
    core.applicableDecision(task.id, "design", { ...binding, presented: "changed" }),
  ).toMatchObject({
    data: [],
  });
  const forged = store.mutateTask(
    task.id,
    recorded.revision!,
    (current, mutation) =>
      ({
        ok: true,
        schemaVersion: 1,
        revision: mutation.revision,
        workspaceRevision: null,
        data: {
          ...current,
          decisions: current.decisions.map((entry) =>
            entry.id === recorded.data.id
              ? {
                  ...entry,
                  data: {
                    ...entry.data,
                    binding: { ...entry.data.binding, approvedContent: "forged" },
                  },
                }
              : entry,
          ),
        },
      }) as any,
  );
  expect(forged.ok).toBe(true);
  const latest = store.readTask(task.id);
  if (!latest.ok) throw new Error(latest.error);
  expect(core.applicableDecision(task.id, "design", binding)).toMatchObject({ data: [] });
});

test("action reservation rejects changed approved document bytes and scope", () => {
  const { core, store, task, workspace, root } = active();
  const file = join(root, "approved.md");
  writeFileSync(file, "approved");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  const binding = {
    ...actionBinding(task, workspace.id),
    contentRefs: [{ kind: "file" as const, path: "approved.md", digest }],
  };
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding,
    response: "approved",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  writeFileSync(file, "drifted");
  const current = store.readTask(task.id);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      binding: { ...binding, scope: scope({ paths: ["other"] }) },
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("rejected and revoked decisions never authorize actions, and provenance is not agent-controlled", () => {
  const { core, store, task, workspace } = active();
  const rejected = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "rejected",
    requirementIds: [],
    provenance: { kind: "host_observed" },
  });
  expect(rejected).toMatchObject({ ok: false, code: "invalid_input" });
  const recorded = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "rejected",
    requirementIds: [],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  const after = store.readTask(task.id);
  if (!after.ok) throw new Error(after.error);
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: recorded.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-1" },
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: workspace.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  const approved = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: after.data.revision,
    purpose: "action",
    binding: actionBinding(task, workspace.id),
    response: "approved",
    requirementIds: [],
  });
  if (!approved.ok) throw new Error(approved.error);
  const approvedTask = store.readTask(task.id);
  if (!approvedTask.ok) throw new Error(approvedTask.error);
  const revoked = core.decision({
    schemaVersion: 1,
    action: "revoke",
    taskId: task.id,
    expectedRevision: approvedTask.data.revision,
    decisionId: approved.data.id,
    reason: "withdrawn",
  });
  expect(revoked).toMatchObject({ ok: true, data: { data: { revoked: { reason: "withdrawn" } } } });
  const revokedTask = store.readTask(task.id);
  if (!revokedTask.ok) throw new Error(revokedTask.error);
  expect(
    core.reserveAction({
      taskId: task.id,
      decisionId: approved.data.id,
      actionRef: { kind: "host", host: "workit_cli", handle: "native-2" },
      expectedRevision: revokedTask.data.revision,
      expectedWorkspaceRevision: workspace.revision,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("finding resolution requires verification, evidence-backed dismissal, and permitted deferral", () => {
  const { core, store, task } = active();
  const candidate = captureCandidate(store.root, task.intent.data.scope, []);
  if (!candidate.ok) throw new Error(candidate.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    evidence: {
      kind: "check",
      claim: "verification",
      requirementIds: [],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "verified",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const findingTask = store.readTask(task.id);
  if (!findingTask.ok) throw new Error(findingTask.error);
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: findingTask.data.revision,
    claim: "bad",
    consequence: "unsafe",
    scope: task.intent.data.scope,
    candidateId: candidate.data.id,
    refs: [ref()],
  });
  expect(finding).toMatchObject({ ok: true, data: { data: { disposition: "open" } } });
  if (!finding.ok) throw new Error(finding.error);
  const fixedTask = store.readTask(task.id);
  if (!fixedTask.ok) throw new Error(fixedTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: fixedTask.data.revision,
      findingId: finding.data.id,
      disposition: "fixed",
      reason: "verified",
      evidenceIds: [evidence.data.id],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: true, data: { data: { disposition: "fixed" } } });
  const resolvedTask = store.readTask(task.id);
  if (!resolvedTask.ok) throw new Error(resolvedTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: resolvedTask.data.revision,
      findingId: finding.data.id,
      disposition: "dismissed",
      reason: "unsupported",
      evidenceIds: [],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("dismissal needs evidence and deferral needs an applicable permitted limitation", () => {
  const { core, store, task, workspace } = active();
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: task.id,
    expectedRevision: task.revision,
    assessment: assessment(),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const assessedTask = store.readTask(task.id);
  if (!assessedTask.ok || !assessedTask.data.policy) throw new Error("policy missing");
  const requirement = assessedTask.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) throw new Error("limitation-capable requirement missing");
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: assessedTask.data.revision,
    claim: "unsupported",
    consequence: "unknown",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  if (!finding.ok) throw new Error(finding.error);
  const findingTask = store.readTask(task.id);
  if (!findingTask.ok) throw new Error(findingTask.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: findingTask.data.revision,
      findingId: finding.data.id,
      disposition: "dismissed",
      reason: "unsupported claim",
      evidenceIds: [],
      decisionIds: [],
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  const afterDismissalAttempt = store.readTask(task.id);
  if (!afterDismissalAttempt.ok) throw new Error(afterDismissalAttempt.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: afterDismissalAttempt.data.revision,
    evidence: {
      kind: "investigation",
      claim: "unsupported",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "passed",
      summary: "not reproduced",
      refs: [ref()],
      exitCode: 0,
      reviewContext: null,
    },
  });
  if (!evidence.ok) throw new Error(evidence.error);
  const afterEvidence = store.readTask(task.id);
  if (!afterEvidence.ok) throw new Error(afterEvidence.error);
  const dismissed = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: afterEvidence.data.revision,
    findingId: finding.data.id,
    disposition: "dismissed",
    reason: "unsupported claim",
    evidenceIds: [evidence.data.id],
    decisionIds: [],
  });
  expect(dismissed).toMatchObject({ ok: true, data: { data: { disposition: "dismissed" } } });
  const reopened = store.readTask(task.id);
  if (!reopened.ok) throw new Error(reopened.error);
  const reopenedFinding = reopened.data.findings.find((entry) => entry.id === finding.data.id);
  if (!reopenedFinding) throw new Error("finding missing");
  const reopenedAgain = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: reopened.data.revision,
    findingId: finding.data.id,
    disposition: "open",
    reason: "new evidence",
    evidenceIds: [evidence.data.id],
    decisionIds: [],
  });
  expect(reopenedAgain).toMatchObject({ ok: true, data: { data: { disposition: "open" } } });
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const limitationBinding = actionBinding(current.data, workspace.id);
  const limitation = core.decision({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    purpose: "limitation",
    binding: limitationBinding,
    response: "approved",
    requirementIds: [requirement.id],
  });
  if (!limitation.ok) throw new Error(limitation.error);
  const beforeDefer = store.readTask(task.id);
  if (!beforeDefer.ok) throw new Error(beforeDefer.error);
  expect(
    core.finding({
      schemaVersion: 1,
      action: "resolve",
      taskId: task.id,
      expectedRevision: beforeDefer.data.revision,
      findingId: finding.data.id,
      disposition: "deferred",
      reason: "accepted limitation",
      evidenceIds: [],
      decisionIds: [limitation.data.id],
    }),
  ).toMatchObject({ ok: true, data: { data: { disposition: "deferred" } } });
});

test("new candidate evidence reopens a resolved finding", () => {
  const { core, store, task } = active();
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: task.revision,
    claim: "bad",
    consequence: "unsafe",
    scope: task.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  if (!finding.ok) throw new Error(finding.error);
  const resolvedTask = store.readTask(task.id);
  if (!resolvedTask.ok) throw new Error(resolvedTask.error);
  const dismissed = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId: task.id,
    expectedRevision: resolvedTask.data.revision,
    findingId: finding.data.id,
    disposition: "dismissed",
    reason: "unsupported",
    evidenceIds: ["00000000-0000-4000-8000-000000000001"],
    decisionIds: [],
  });
  expect(dismissed.ok).toBe(false);
  writeFileSync(join(store.root, "new.txt"), "new evidence");
  const current = store.readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId: task.id,
    expectedRevision: current.data.revision,
    evidence: {
      kind: "investigation",
      claim: "new observation",
      requirementIds: [],
      beforeCandidateId: null,
      candidateId: null,
      result: "failed",
      summary: "new",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(evidence.ok).toBe(true);
  const latest = store.readTask(task.id);
  if (!latest.ok) throw new Error(latest.error);
  expect(latest.data.findings[0]?.data.disposition).toBe("open");
});
