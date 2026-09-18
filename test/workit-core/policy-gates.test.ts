import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  captureCandidate,
  selectMethods,
  type Assessment,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import { METHODS } from "@/packages/workit-core/src/core/methods";
import { assessment, caller, ref, scope, taskStartRequest } from "./task-fixtures";

const context = (root: string, actor = "test"): OperationContext => ({
  root,
  caller: caller({ actor }),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const assess = (core: WorkitCore, taskId: string, signals: Assessment["signals"]) => {
  const result = core.policy({
    schemaVersion: 1,
    action: "assess",
    taskId,
    assessment: assessment({ signals }),
  });
  if (!result.ok) throw new Error(result.error);
  return result;
};

const fileDigest = (root: string, path: string) =>
  createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");

const behavioralSignals = (): Assessment["signals"] => ({
  ...mechanicalSignals(),
  behaviorChange: { value: true, basis: "observed", reason: "behavior", refs: [ref()] },
  mechanicalLowRisk: { value: false, basis: "inferred", reason: "behavioral", refs: [] },
});

const startAndAssess = (root: string, signals: Parameters<typeof assess>[2], actor = "test") => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root, actor));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  assess(core, taskId, signals);
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !task.data.policy || !workspace.ok || !workspace.data)
    throw new Error("policy missing");
  return { store, core, taskId, task: task.data, workspace: workspace.data };
};

const mechanicalSignals = (): Assessment["signals"] => ({
  approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
  productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
  behaviorChange: { value: false, basis: "inferred", reason: "mechanical", refs: [] },
  mechanicalLowRisk: { value: true, basis: "inferred", reason: "mechanical", refs: [] },
  durableAgreementNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
  coordinationPlanNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
  helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
  testFirstPractical: { value: false, basis: "inferred", reason: "none", refs: [] },
});

const policyOf = (store: TaskStore, taskId: string) => {
  const task = store.readTask(taskId);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  return task.data.policy;
};

test("before:write blocks writer.acquire until the spec lands", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-write-gate-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId, task, workspace } = startAndAssess(root, {
      ...mechanicalSignals(),
      durableAgreementNeeded: { value: true, basis: "inferred", reason: "spec needed", refs: [] },
    });
    const blocked = core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId,
      expectedRevision: task.revision,
      expectedWorkspaceRevision: workspace.revision,
      workerId: null,
    });
    expect(blocked).toMatchObject({ ok: false, code: "requirements_unsatisfied" });
    const policy = policyOf(store, taskId);
    const spec = policy.requirements.find((item) => item.ruleId === "durable-spec")!;
    writeFileSync(join(root, "docs-spec.md"), "spec\n");
    const recorded = core.evidence({
      schemaVersion: 1,
      action: "record",
      taskId,
      evidence: {
        kind: "artifact",
        claim: "spec recorded",
        requirementIds: [spec.id],
        result: "passed",
        summary: "spec written",
        refs: [{ kind: "file", path: "docs-spec.md", digest: fileDigest(root, "docs-spec.md") }],
        exitCode: 0,
        reviewContext: null,
      },
    });
    expect(recorded.ok).toBe(true);
    const reacquired = store.readTask(taskId);
    const reworkspace = store.readWorkspace();
    if (!reacquired.ok || !reworkspace.ok || !reworkspace.data) throw new Error("state missing");
    const fresh = core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId,
      expectedRevision: reacquired.data.revision,
      expectedWorkspaceRevision: reworkspace.data.revision,
      workerId: null,
    });
    expect(fresh).toMatchObject({ ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close ignores dependent_action gates", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-close-partition-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId } = startAndAssess(root, mechanicalSignals());
    const policy = policyOf(store, taskId);
    for (const requirement of policy.requirements.filter(
      (item) => item.ruleId !== "pre-pr-cleanup",
    )) {
      expect(
        core.evidence({
          schemaVersion: 1,
          action: "record",
          taskId,
          evidence: {
            kind: requirement.dimension === "review" ? "review" : "check",
            claim: requirement.ruleId,
            requirementIds: [requirement.id],
            result: "passed",
            summary: "lead checked the current candidate",
            refs: [],
            exitCode: 0,
            reviewContext:
              requirement.dimension === "review"
                ? { kind: "host", host: "workit_cli", handle: "test" }
                : null,
          },
        }).ok,
      ).toBe(true);
    }
    const closed = core.task({
      schemaVersion: 1,
      action: "close",
      taskId,
      outcome: "verified",
      summary: "mechanical change reviewed",
      decisionIds: [],
    });
    expect(closed).toMatchObject({ ok: true, data: { closure: { outcome: "verified" } } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind mismatches name the expected evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-kind-names-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId } = startAndAssess(root, behavioralSignals());
    const policy = policyOf(store, taskId);
    const testing = policy.requirements.find((item) => item.dimension === "testing")!;
    expect(
      core.evidence({
        schemaVersion: 1,
        action: "record",
        taskId,
        evidence: {
          kind: "artifact",
          claim: "wrong kind",
          requirementIds: [testing.id],
          result: "passed",
          summary: "artifact for a testing requirement",
          refs: [],
          exitCode: 0,
          reviewContext: null,
        },
      }).ok,
    ).toBe(true);
    const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(view).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({
            requirementId: testing.id,
            status: "unsatisfied",
            reason: expect.stringContaining("needs kind:check"),
          }),
        ]),
      },
    });
    const cleanup = policy.requirements.find((item) => item.ruleId === "pre-pr-cleanup")!;
    expect(
      core.evidence({
        schemaVersion: 1,
        action: "record",
        taskId,
        evidence: {
          kind: "artifact",
          claim: "deslop report",
          requirementIds: [cleanup.id],
          result: "passed",
          summary: "deslop pass",
          refs: [],
          exitCode: 0,
          reviewContext: null,
        },
      }).ok,
    ).toBe(true);
    const after = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(after).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({ requirementId: cleanup.id, status: "satisfied" }),
        ]),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RED-first yields to prior baselines but still gates fresh claims", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-red-scope-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const behavioral = behavioralSignals;
    const { store, core, taskId } = startAndAssess(root, behavioral());
    const policy = policyOf(store, taskId);
    const testing = policy.requirements.find((item) => item.dimension === "testing")!;
    const record = (kind: "check", result: "passed" | "failed", claim: string) =>
      core.evidence({
        schemaVersion: 1,
        action: "record",
        taskId,
        evidence: {
          kind,
          claim,
          requirementIds: [testing.id],
          result,
          summary: claim,
          refs: [],
          exitCode: result === "passed" ? 0 : 1,
          reviewContext: null,
        },
      });
    expect(record("check", "passed", "green alone").ok).toBe(true);
    const alone = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(alone).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({ requirementId: testing.id, status: "unsatisfied" }),
        ]),
      },
    });
    writeFileSync(join(root, "a.ts"), "after");
    expect(record("check", "passed", "green on new candidate").ok).toBe(true);
    const based = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(based).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({ requirementId: testing.id, status: "satisfied" }),
        ]),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classic RED then GREEN still satisfies testing requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-red-classic-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId } = startAndAssess(root, behavioralSignals());
    const policy = policyOf(store, taskId);
    const testing = policy.requirements.find((item) => item.dimension === "testing")!;
    const record = (result: "passed" | "failed", claim: string) =>
      core.evidence({
        schemaVersion: 1,
        action: "record",
        taskId,
        evidence: {
          kind: "check",
          claim,
          requirementIds: [testing.id],
          result,
          summary: claim,
          refs: [],
          exitCode: result === "passed" ? 0 : 1,
          reviewContext: null,
        },
      });
    expect(record("failed", "red first").ok).toBe(true);
    expect(record("passed", "green after red").ok).toBe(true);
    const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(view).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({ requirementId: testing.id, status: "satisfied" }),
        ]),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same reviewer session may re-verify the same requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-reviewer-retry-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId } = startAndAssess(root, behavioralSignals());
    const policy = policyOf(store, taskId);
    const reviewRequirement = policy.requirements.find((item) => item.dimension === "review")!;
    const reviewer = new WorkitCore(store, {
      ...context(root),
      caller: caller({ actor: "reviewer" }),
    });
    const review = (candidateId: string) =>
      reviewer.evidence({
        schemaVersion: 1,
        action: "record",
        taskId,
        evidence: {
          kind: "review",
          claim: "independent review",
          requirementIds: [reviewRequirement.id],
          beforeCandidateId: candidateId,
          candidateId,
          result: "passed",
          summary: "review passed",
          refs: [],
          exitCode: 0,
          reviewContext: { kind: "host", host: "workit_cli", handle: "reviewer" },
        },
      });
    const first = captureCandidate(root, scope(), []);
    if (!first.ok) throw new Error(first.error);
    expect(review(first.data.id).ok).toBe(true);
    writeFileSync(join(root, "a.ts"), "after");
    const second = captureCandidate(root, scope(), []);
    if (!second.ok) throw new Error(second.error);
    expect(review(second.data.id).ok).toBe(true);
    const view = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(view).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({ requirementId: reviewRequirement.id, status: "satisfied" }),
        ]),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dead skill routes are gone and self-review is routed", () => {
  const ruleIds = Object.values(METHODS).flatMap((definition) => definition.ruleIds ?? []);
  expect(ruleIds).not.toContain("root-cause-investigation");
  expect(ruleIds).not.toContain("durable-handoff");
  const root = mkdtempSync(join(tmpdir(), "workit-method-routes-"));
  try {
    const { store, taskId } = startAndAssess(root, mechanicalSignals());
    const policy = policyOf(store, taskId);
    const selfReview = policy.requirements.find((item) => item.ruleId === "self-review")!;
    expect(
      selectMethods(
        { policyVersion: "1.0.0", inputDigest: "0".repeat(64), requirements: policy.requirements },
        [],
      ).map((method) => method.id),
    ).toContain("workit-review");
    const mechanical = policy.requirements.find(
      (item) => item.ruleId === "mechanical-existing-checks",
    )!;
    expect(
      selectMethods(
        {
          policyVersion: "1.0.0" as const,
          inputDigest: "0".repeat(64),
          requirements: [mechanical],
        } as never,
        [],
      ).map((method) => method.id),
    ).toContain("workit-behavioral-tdd");
    void selfReview;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
