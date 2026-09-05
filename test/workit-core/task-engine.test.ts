import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
  if (!started.ok) throw new Error(started.error);
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
  if (!started.ok) throw new Error(started.error);
  const task = store.listTasks();
  if (!task.ok || !task.data[0]) throw new Error("task missing");
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
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
  if (!pausedTask.ok || !pausedWorkspace.ok || !pausedWorkspace.data)
    throw new Error("paused state missing");
  const resumed = core.task({
    schemaVersion: 1,
    action: "resume",
    taskId: task.data[0].id,
    expectedRevision: pausedTask.data.revision,
    expectedWorkspaceRevision: pausedWorkspace.data.revision,
    authorityRefs: [ref()],
  });
  expect(resumed.ok).toBe(true);
  const activeTask = store.readTask(task.data[0].id);
  const activeWorkspace = store.readWorkspace();
  if (!activeTask.ok || !activeWorkspace.ok || !activeWorkspace.data)
    throw new Error("active state missing");
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
  if (!closed.ok) throw new Error(closed.error);
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
  if (!result.ok) throw new Error(result.error);
  expect(result.data.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "run.sh", kind: "file", executable: true }),
      expect.objectContaining({ path: "escape", kind: "symlink", executable: null }),
    ]),
  );
});

test("candidate capture is deterministic, records absent scope paths, and rejects duplicate environments", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-"));
  const captured = captureCandidate(root, scope({ paths: ["missing", "."] }), [
    { name: "Z_INPUT", value: null },
    { name: "A_INPUT", value: "one" },
  ]);
  expect(captured.ok).toBe(true);
  if (!captured.ok) throw new Error(captured.error);
  expect(captured.data.files).toEqual(
    expect.arrayContaining([{ path: "missing", kind: "absent", digest: null, executable: null }]),
  );
  expect(captured.data.environment.map((item) => item.name)).toEqual(["A_INPUT", "Z_INPUT"]);
  expect(
    captureCandidate(root, scope(), [
      { name: "A_INPUT", value: "one" },
      { name: "A_INPUT", value: "two" },
    ]),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("engine mutations honor a fixed trusted clock", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-clock-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  const task = store.readTask(taskId);
  expect(task.ok).toBe(true);
  if (!task.ok) throw new Error(task.error);
  expect(task.data.createdAt).toBe("2026-01-01T00:00:00Z");
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    expectedRevision: task.data.revision,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const assessedTask = store.readTask(taskId);
  expect(assessedTask.ok).toBe(true);
  if (!assessedTask.ok) throw new Error(assessedTask.error);
  expect(assessedTask.data.assessments.at(-1)?.recordedAt).toBe("2026-01-01T00:00:00Z");
});

test("review evidence uses the trusted caller session and requires an independent session", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-review-"));
  const store = new TaskStore(root);
  const leadContext = context(root);
  const lead = new WorkitCore(store, leadContext);
  const started = lead.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  const task = store.readTask(taskId);
  expect(task.ok).toBe(true);
  if (!task.ok) throw new Error(task.error);
  const assessed = lead.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    expectedRevision: task.data.revision,
    assessment: assessment({
      signals: {
        ...assessment().signals,
        approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
        productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
        behaviorChange: {
          value: true,
          basis: "observed",
          reason: "behavior changed",
          refs: [ref()],
        },
        mechanicalLowRisk: { value: false, basis: "inferred", reason: "behavioral", refs: [] },
      },
    }),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const assessedTask = store.readTask(taskId);
  expect(assessedTask.ok).toBe(true);
  if (!assessedTask.ok || !assessedTask.data.policy) throw new Error("policy missing");
  const reviewRequirement = assessedTask.data.policy.requirements.find(
    (item) => item.dimension === "review",
  );
  if (!reviewRequirement) throw new Error("review requirement missing");
  const candidate = captureCandidate(root, assessedTask.data.intent.data.scope, []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const reviewer = new WorkitCore(store, {
    ...leadContext,
    caller: caller({ actor: "reviewer" }),
  });
  const recorded = reviewer.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: assessedTask.data.revision,
    evidence: {
      kind: "review",
      claim: "independent review",
      requirementIds: [reviewRequirement.id],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "review passed",
      refs: [],
      exitCode: 0,
      reviewContext: { kind: "host", host: "workit_cli", handle: "reviewer" },
    },
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error(recorded.error);
  expect(recorded.data.provenance).toMatchObject({
    kind: "agent_reported",
    session: { kind: "host", host: "workit_cli", handle: "reviewer" },
  });
  const view = reviewer.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(view).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: reviewRequirement.id, status: "satisfied" }),
      ]),
    },
  });
  const leadView = lead.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(leadView).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: reviewRequirement.id, status: "satisfied" }),
      ]),
    },
  });
  const forged = reviewer.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: (() => {
      const current = store.readTask(taskId);
      return current.ok ? current.data.revision : assessedTask.data.revision;
    })(),
    evidence: {
      kind: "review",
      claim: "forged",
      requirementIds: [reviewRequirement.id],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "forged",
      refs: [],
      exitCode: 0,
      reviewContext: { kind: "host", host: "workit_cli", handle: "not-reviewer" },
    },
  });
  expect(forged).toMatchObject({ ok: false, code: "invalid_input" });
});

test("summary and full inspection recapture candidates so scoped freshness agrees", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-freshness-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.ts"), "initial");
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(
    taskStartRequest({
      intent: {
        objective: "scoped check",
        scope: scope({ paths: ["src"] }),
        authorityRefs: [ref()],
      },
    }),
  );
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  let task = store.readTask(taskId);
  expect(task.ok).toBe(true);
  if (!task.ok) throw new Error(task.error);
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    expectedRevision: task.data.revision,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  task = store.readTask(taskId);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  const verification = task.data.policy.requirements.find(
    (item) => item.dimension === "verification",
  );
  if (!verification) throw new Error("verification requirement missing");
  const candidate = captureCandidate(root, task.data.intent.data.scope, []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const evidence = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "check",
      claim: "verification passed",
      requirementIds: [verification.id],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "passed",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(evidence.ok).toBe(true);
  if (!evidence.ok) throw new Error(evidence.error);
  const unchanged = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
  expect(unchanged).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: verification.id, status: "satisfied" }),
      ]),
    },
  });
  writeFileSync(join(root, "unrelated.txt"), "ignored");
  const unrelated = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(unrelated).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: verification.id, status: "satisfied" }),
      ]),
    },
  });
  writeFileSync(join(src, "a.ts"), "changed");
  const summary = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
  const full = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(summary).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: verification.id, status: "unsatisfied" }),
      ]),
    },
  });
  expect(full).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: verification.id, status: "unsatisfied" }),
      ]),
    },
  });
});

test("verified closure requires an assessed policy and current evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.listTasks();
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data[0] || !workspace.ok || !workspace.data)
    throw new Error("task or workspace missing");
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
  if (!started.ok) throw new Error(started.error);
  const task = store.listTasks();
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data[0] || !workspace.ok || !workspace.data)
    throw new Error("task or workspace missing");
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
    throw new Error("assessed task or workspace missing");
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
  if (!afterCheck.ok || !afterCheckWorkspace.ok || !afterCheckWorkspace.data)
    throw new Error("post-check state missing");
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
  if (!started.ok) throw new Error(started.error);
  const listed = store.listTasks();
  const workspace = store.readWorkspace();
  if (!listed.ok || !listed.data[0] || !workspace.ok || !workspace.data)
    throw new Error("task or workspace missing");
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: listed.data[0].id,
    expectedRevision: listed.data[0].revision,
    assessment: assessment(),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const task = store.readTask(listed.data[0].id);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  const requirement = task.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) throw new Error("limitation-capable requirement missing");
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
  if (!changed.ok) throw new Error(changed.error);
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

test("a limitation excluding part of a requirement scope cannot bypass that requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-scope-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  const task = store.readTask(taskId);
  expect(task.ok).toBe(true);
  if (!task.ok) throw new Error(task.error);
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    expectedRevision: task.data.revision,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const assessedTask = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!assessedTask.ok || !assessedTask.data.policy || !workspace.ok || !workspace.data)
    throw new Error("assessment state missing");
  const requirement = assessedTask.data.policy.requirements.find((item) => item.acceptanceAllowed);
  if (!requirement) throw new Error("limitation-capable requirement missing");
  const base = {
    purpose: "limitation" as const,
    binding: {
      taskId,
      workspaceId: workspace.data.id,
      scope: scope({ exclusions: ["secret"] }),
      presented: "accept",
      approvedContent: "accept",
      contentRefs: [],
    },
    response: "approved" as const,
    requirementIds: [requirement.id],
    revoked: null,
    consumption: null,
  };
  const decision = { ...base, digest: decisionDigest(base as any) } as any;
  const changed = store.mutateTask(taskId, assessedTask.data.revision, (current, mutation) =>
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
  expect(changed.ok).toBe(true);
  const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(view).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: requirement.id, status: "unsatisfied" }),
      ]),
    },
  });
});

test("a passing repository check does not satisfy an untested behavior requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const listed = store.listTasks();
  if (!listed.ok || !listed.data[0]) throw new Error("task missing");
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
  if (!assessed.ok) throw new Error(assessed.error);
  const task = store.readTask(listed.data[0].id);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
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
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data)
    throw new Error("post-evidence state missing");
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
