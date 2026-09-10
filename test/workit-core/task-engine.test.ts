import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  captureCandidate,
  decisionDigest,
  evaluateClosure,
  evaluateEvidence,
  newId,
  success,
  type OperationContext,
} from "@/packages/workit-core/src/core";
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

test("Git candidate capture ignores excluded trees while retaining tracked and relevant files", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-git-ignore-"));
  mkdirSync(join(root, "node_modules", "large"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules/\ncoverage/\n");
  writeFileSync(join(root, "node_modules", "large", "ignored.js"), "ignored");
  writeFileSync(join(root, "src", "app.ts"), "source");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Workit Test",
        "-c",
        "user.email=workit@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  const candidate = captureCandidate(root, scope(), []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.data.files.map((file) => file.path)).toContain("src/app.ts");
  expect(candidate.data.files.map((file) => file.path)).not.toContain(
    "node_modules/large/ignored.js",
  );
  expect(candidate.data.completeness).toBe("known");
  const subdirectory = captureCandidate(root, scope({ paths: ["src"] }), []);
  expect(subdirectory).toMatchObject({ ok: true, data: { files: [{ path: "src/app.ts" }] } });
});

test("Git candidate capture includes untracked non-ignored source files", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-git-untracked-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "src", "tracked.ts"), "tracked");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Workit Test",
        "-c",
        "user.email=workit@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  writeFileSync(join(root, "src", "new.ts"), "untracked");
  const candidate = captureCandidate(root, scope(), []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.data.files.map((file) => file.path)).toContain("src/new.ts");
  expect(candidate.data.completeness).toBe("known");
});

test("Git candidate capture keeps force-tracked files under ignore rules", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-git-forced-"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "node_modules", "pkg", "forced.js"), "forced");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "-f", "node_modules/pkg/forced.js"], { cwd: root }).status).toBe(
    0,
  );
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Workit Test",
        "-c",
        "user.email=workit@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  writeFileSync(join(root, "node_modules", "pkg", "ignored.js"), "ignored");
  const candidate = captureCandidate(root, scope(), []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.data.files.map((file) => file.path)).toContain("node_modules/pkg/forced.js");
  expect(candidate.data.files.map((file) => file.path)).not.toContain(
    "node_modules/pkg/ignored.js",
  );
  expect(candidate.data.completeness).toBe("known");
});

test("non-Git candidate capture recursively walks nested files", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-candidate-nongit-walk-"));
  mkdirSync(join(root, "nested", "deep"), { recursive: true });
  writeFileSync(join(root, "nested", "deep", "leaf.txt"), "leaf");
  const candidate = captureCandidate(root, scope(), []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.data.files.map((file) => file.path)).toContain("nested/deep/leaf.txt");
  expect(candidate.data.completeness).toBe("known");
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

test("canonical relative scope spellings still inventory and stale edits", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-scope-canonical-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "before");
  const before = captureCandidate(root, scope({ paths: ["./src/"] }), []);
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error(before.error);
  expect(before.data.files).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "src/a.ts", kind: "file" })]),
  );
  writeFileSync(join(root, "src", "a.ts"), "after");
  const after = captureCandidate(root, scope({ paths: ["src"] }), []);
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.id).not.toBe(before.data.id);
});

test("candidate inventory retains staged deletions as absent entries", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-staged-delete-"));
  writeFileSync(join(root, "removed.txt"), "tracked");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "removed.txt"], { cwd: root }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Workit Test",
        "-c",
        "user.email=workit@example.test",
        "commit",
        "-qm",
        "init",
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  unlinkSync(join(root, "removed.txt"));
  expect(spawnSync("git", ["add", "-u"], { cwd: root }).status).toBe(0);
  const candidate = captureCandidate(root, scope(), []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  expect(candidate.data.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "removed.txt", kind: "absent", digest: null }),
    ]),
  );
});

test("evidence freshness checks each referenced requirement scope independently", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-multi-scope-"));
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a");
  writeFileSync(join(root, "src", "generated", "g.ts"), "before");
  const before = captureCandidate(root, scope(), [{ name: "RUNTIME", value: "same" }]);
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error(before.error);
  writeFileSync(join(root, "src", "generated", "g.ts"), "after");
  const after = captureCandidate(root, scope(), [{ name: "RUNTIME", value: "same" }]);
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.error);
  const firstRequirement = "1".repeat(64);
  const secondRequirement = "2".repeat(64);
  const task = {
    candidates: [before.data],
    policy: {
      requirements: [
        { id: firstRequirement, scope: scope({ paths: ["src"], exclusions: ["src/generated"] }) },
        { id: secondRequirement, scope: scope({ paths: ["src/generated"] }) },
      ],
    },
    evidence: [
      {
        id: "3".repeat(16),
        data: {
          kind: "check",
          result: "passed",
          requirementIds: [firstRequirement, secondRequirement],
          beforeCandidateId: before.data.id,
          candidateId: before.data.id,
        },
      },
    ],
  } as any;
  expect(evaluateEvidence(task, after.data)[0]).toMatchObject({ status: "stale" });
});

test("relevant environment changes stale evidence regardless of file scope", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-environment-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a");
  const before = captureCandidate(root, scope({ paths: ["src"] }), [
    { name: "RUNTIME", value: "one" },
  ]);
  const after = captureCandidate(root, scope({ paths: ["src"] }), [
    { name: "RUNTIME", value: "two" },
  ]);
  expect(before.ok).toBe(true);
  expect(after.ok).toBe(true);
  if (!before.ok || !after.ok) throw new Error("environment candidate missing");
  const requirementId = "4".repeat(64);
  const task = {
    candidates: [before.data],
    policy: { requirements: [{ id: requirementId, scope: scope({ paths: ["src"] }) }] },
    evidence: [
      {
        id: "5".repeat(16),
        data: {
          kind: "check",
          result: "passed",
          requirementIds: [requirementId],
          beforeCandidateId: before.data.id,
          candidateId: before.data.id,
        },
      },
    ],
  } as any;
  expect(evaluateEvidence(task, after.data)[0]).toMatchObject({ status: "stale" });
  const unknown = captureCandidate(root, scope({ paths: ["src"] }), [
    { name: "RUNTIME", value: null },
  ]);
  expect(unknown).toMatchObject({ ok: true, data: { completeness: "uncertain" } });
  if (!unknown.ok) throw new Error(unknown.error);
  const uncertainTask = {
    ...task,
    candidates: [unknown.data],
    evidence: [
      {
        ...task.evidence[0],
        data: {
          ...task.evidence[0].data,
          beforeCandidateId: unknown.data.id,
          candidateId: unknown.data.id,
        },
      },
    ],
  } as any;
  expect(evaluateEvidence(uncertainTask, after.data)[0]).toMatchObject({ status: "stale" });
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

test("trusted clocks are isolated between cores sharing one store", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-clock-isolation-"));
  const store = new TaskStore(root);
  const first = new WorkitCore(store, context(root));
  const second = new WorkitCore(store, {
    ...context(root),
    now: "2030-02-03T04:05:06Z",
    caller: caller({ actor: "second" }),
  });
  const started = first.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const firstTask = store.readTask((started.data as any).id as string);
  expect(firstTask.ok).toBe(true);
  if (!firstTask.ok) throw new Error(firstTask.error);
  const workspace = store.readWorkspace();
  expect(workspace.ok).toBe(true);
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const secondStarted = second.task(
    taskStartRequest({ expectedWorkspaceRevision: workspace.data.revision }),
  );
  expect(secondStarted.ok).toBe(true);
  if (!secondStarted.ok) throw new Error(secondStarted.error);
  const assessed = first.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: firstTask.data.id,
    expectedRevision: firstTask.data.revision,
    assessment: assessment(),
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.error);
  const after = store.readTask(firstTask.data.id);
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.assessments.at(-1)?.recordedAt).toBe("2026-01-01T00:00:00Z");
});

test("a context rooted at another checkout cannot read or mutate the store", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-root-"));
  const other = mkdtempSync(join(tmpdir(), "workit-other-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, { ...context(other), root: other });
  expect(core.task(taskStartRequest())).toMatchObject({ ok: false, code: "invalid_input" });
  expect(store.readWorkspace()).toEqual(success(null, null, null));
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
  const otherRequirement = assessedTask.data.policy.requirements.find(
    (item) => item.dimension !== "review",
  );
  if (!otherRequirement) throw new Error("additional requirement missing");
  const candidate = captureCandidate(root, assessedTask.data.intent.data.scope, []);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const reviewer = new WorkitCore(store, {
    ...leadContext,
    caller: caller({ actor: "reviewer" }),
  });
  const implementationEvidence = reviewer.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: assessedTask.data.revision,
    evidence: {
      kind: "check",
      claim: "reviewer's check",
      requirementIds: [otherRequirement.id],
      beforeCandidateId: candidate.data.id,
      candidateId: candidate.data.id,
      result: "passed",
      summary: "check passed",
      refs: [],
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(implementationEvidence.ok).toBe(true);
  if (!implementationEvidence.ok) throw new Error(implementationEvidence.error);
  const taskAfterCheck = store.readTask(taskId);
  expect(taskAfterCheck.ok).toBe(true);
  if (!taskAfterCheck.ok) throw new Error(taskAfterCheck.error);
  const recorded = reviewer.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: taskAfterCheck.data.revision,
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
        expect.objectContaining({ requirementId: reviewRequirement.id, status: "unsatisfied" }),
      ]),
    },
  });
  const leadView = lead.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
  expect(leadView).toMatchObject({
    ok: true,
    data: {
      requirements: expect.arrayContaining([
        expect.objectContaining({ requirementId: reviewRequirement.id, status: "unsatisfied" }),
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

test("verified closure remains blocked while a finding is open", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-finding-close-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const assessed = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    expectedRevision: task.data.revision,
    assessment: assessment(),
  });
  if (!assessed.ok) throw new Error(assessed.error);
  const afterPolicy = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!afterPolicy.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const finding = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: afterPolicy.data.revision,
    claim: "open blocker",
    consequence: "unsafe closure",
    scope: afterPolicy.data.intent.data.scope,
    candidateId: null,
    refs: [ref()],
  });
  expect(finding.ok).toBe(true);
  const current = store.readTask(taskId);
  const currentWorkspace = store.readWorkspace();
  if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId,
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      outcome: "verified",
      summary: "done",
      decisionIds: [],
    }),
  ).toMatchObject({
    ok: false,
    code: "requirements_unsatisfied",
    error: "open findings must be resolved before closure",
  });
});

const recordFinding = (core: WorkitCore, taskId: string, expectedRevision: string) => {
  const recorded = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision,
    claim: "regression risk",
    consequence: "unsafe change",
    scope: scope({ paths: ["."] }),
    candidateId: null,
    refs: [ref()],
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error(recorded.error);
  return recorded.data as { id: string };
};

const recordCheck = (
  core: WorkitCore,
  taskId: string,
  expectedRevision: string,
  claim: string,
  refs: Array<ReturnType<typeof ref>> = [],
) => {
  const recorded = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision,
    evidence: {
      kind: "check",
      claim,
      requirementIds: [],
      result: "passed",
      summary: claim,
      refs,
      exitCode: 0,
      reviewContext: null,
    },
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error(recorded.error);
  return recorded.data as { id: string };
};

const resolveFixed = (
  core: WorkitCore,
  taskId: string,
  expectedRevision: string,
  findingId: string,
  evidenceId: string,
) => {
  const resolved = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId,
    expectedRevision,
    findingId,
    disposition: "fixed",
    reason: "verified by passing check",
    evidenceIds: [evidenceId],
    decisionIds: [],
  });
  expect(resolved).toMatchObject({ ok: true, data: { data: { disposition: "fixed" } } });
};

const findingDisposition = (store: TaskStore, taskId: string, findingId: string) => {
  const task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  return task.data.findings.find((entry) => entry.id === findingId)?.data.disposition;
};

test("unrelated evidence keeps a verified fix fixed", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-reopen-keep-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  let task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const finding = recordFinding(core, taskId, task.data.revision);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const check = recordCheck(core, taskId, task.data.revision, "fix verified");
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  resolveFixed(core, taskId, task.data.revision, finding.id, check.id);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const noted = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "artifact",
      claim: "sequencing note",
      requirementIds: [],
      result: "passed",
      summary: "unrelated artifact",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(noted.ok).toBe(true);
  expect(findingDisposition(store, taskId, finding.id)).toBe("fixed");
});

test("evidence after a tree move reopens a fix whose verification lapsed", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-reopen-lapse-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(
    taskStartRequest({
      intent: {
        objective: "test task",
        scope: scope({ paths: ["src"] }),
        authorityRefs: [ref()],
      },
    }),
  );
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "v1\n");
  let task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const finding = recordFinding(core, taskId, task.data.revision);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const check = recordCheck(core, taskId, task.data.revision, "fix verified");
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  resolveFixed(core, taskId, task.data.revision, finding.id, check.id);
  writeFileSync(join(root, "src", "a.ts"), "v2\n");
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const noted = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "artifact",
      claim: "note after the tree moved",
      requirementIds: [],
      result: "passed",
      summary: "unrelated artifact",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(noted.ok).toBe(true);
  expect(findingDisposition(store, taskId, finding.id)).toBe("open");
});

test("an unsupported stored policy version fails verified closure even with no requirements", () => {
  const view = {
    task: { policy: { policyVersion: "9.9.9", requirements: [] } },
    requirements: [],
  } as any;
  expect(evaluateClosure("verified", view)).toMatchObject({
    ok: false,
    code: "requirements_unsatisfied",
  });
});

test("an unsupported stored policy version blocks stopped closure at the public boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-unsupported-close-"));
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
  expect(assessedTask.ok).toBe(true);
  if (!assessedTask.ok || !assessedTask.data.policy) throw new Error("policy missing");
  const forged = store.mutateTask(taskId, assessedTask.data.revision, (current, mutation) =>
    success(mutation.revision, null, {
      ...current,
      policy: { ...current.policy!, policyVersion: "9.9.9" },
    }),
  );
  expect(forged.ok).toBe(true);
  if (!forged.ok) throw new Error(forged.error);
  const workspace = store.readWorkspace();
  expect(workspace.ok).toBe(true);
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId,
      expectedRevision: forged.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      outcome: "stopped",
      summary: "stopped",
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

test("failed evidence with overlapping refs reopens a fixed finding", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-reopen-contradict-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  let task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const finding = recordFinding(core, taskId, task.data.revision);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const check = recordCheck(core, taskId, task.data.revision, "fix verified");
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  resolveFixed(core, taskId, task.data.revision, finding.id, check.id);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const failed = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "check",
      claim: "regression check failed",
      requirementIds: [],
      result: "failed",
      summary: "contradicting signal",
      refs: [ref()],
      exitCode: 1,
      reviewContext: null,
    },
  });
  expect(failed.ok).toBe(true);
  expect(findingDisposition(store, taskId, finding.id)).toBe("open");
});

test("a dismissed finding stays dismissed without a tree move", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-engine-dismissed-stays-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  let task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const finding = recordFinding(core, taskId, task.data.revision);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const basis = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "investigation",
      claim: "dismissal basis",
      requirementIds: [],
      result: "passed",
      summary: "not reproducible",
      refs: [ref()],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(basis.ok).toBe(true);
  if (!basis.ok) throw new Error(basis.error);
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const dismissed = core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId,
    expectedRevision: task.data.revision,
    findingId: finding.id,
    disposition: "dismissed",
    reason: "not an issue",
    evidenceIds: [(basis.data as { id: string }).id],
    decisionIds: [],
  });
  expect(dismissed).toMatchObject({ ok: true, data: { data: { disposition: "dismissed" } } });
  task = store.readTask(taskId);
  if (!task.ok) throw new Error(task.error);
  const noted = core.evidence({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision: task.data.revision,
    evidence: {
      kind: "artifact",
      claim: "unrelated note",
      requirementIds: [],
      result: "passed",
      summary: "no tree move",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(noted.ok).toBe(true);
  expect(findingDisposition(store, taskId, finding.id)).toBe("dismissed");
});
