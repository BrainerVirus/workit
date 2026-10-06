import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  captureCandidate,
  selectMethods,
  type OperationContext,
} from "@/packages/workit-core/src/core";
import type { Assessment } from "@/test/workit-core/task-fixtures";
import { METHODS } from "@/packages/workit-core/src/core/methods";
import {
  assessment,
  caller,
  checkObservation,
  methodConstraint,
  ref,
  scope,
  taskStartRequest,
  writeTestCheck,
} from "./task-fixtures";

const context = (
  root: string,
  actor = "test",
  constraints: OperationContext["constraints"] = [],
): OperationContext => ({
  root,
  caller: caller({ actor }),
  capabilities: [],
  constraints,
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

const behavioralSignals = (): Assessment["signals"] => ({
  ...mechanicalSignals(),
  behaviorChange: {
    value: true,
    basis: "observed",
    reason: "behavior",
    refs: [ref()],
  },
  mechanicalLowRisk: {
    value: false,
    basis: "inferred",
    reason: "behavioral",
    refs: [],
  },
});

const startAndAssess = (
  root: string,
  signals: Parameters<typeof assess>[2],
  actor = "test",
  constraints: OperationContext["constraints"] = [],
) => {
  writeTestCheck(root);
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root, actor, constraints));
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
  approachUnknown: {
    value: false,
    basis: "inferred",
    reason: "known",
    refs: [],
  },
  productChoiceOpen: {
    value: false,
    basis: "inferred",
    reason: "settled",
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
    reason: "mechanical",
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
  helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
  testFirstPractical: {
    value: false,
    basis: "inferred",
    reason: "none",
    refs: [],
  },
});

const policyOf = (store: TaskStore, taskId: string) => {
  const task = store.readTask(taskId);
  if (!task.ok || !task.data.policy) throw new Error("policy missing");
  return task.data.policy;
};

test("close ignores dependent_action gates", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-close-partition-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    const { store, core, taskId } = startAndAssess(root, mechanicalSignals());
    const policy = policyOf(store, taskId);
    // Close-time verification takes a CLI-observed check; review stays agent-recorded.
    expect(core.observeCheck({ taskId, observation: checkObservation() }).ok).toBe(true);
    for (const requirement of policy.requirements.filter(
      (item) => item.ruleId !== "pre-pr-cleanup" && item.dimension === "review",
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
    expect(closed).toMatchObject({
      ok: true,
      data: { closure: { outcome: "verified" } },
    });
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
    const view = core.task({
      schemaVersion: 1,
      action: "inspect",
      taskId,
      view: "summary",
    });
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent-reported RED then GREEN is a note: it never satisfies a close testing gate", () => {
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
    expect(record("passed", "tests pass").ok).toBe(true);
    writeFileSync(join(root, "a.ts"), "after");
    expect(record("passed", "green on new candidate").ok).toBe(true);
    const testingOf = () => {
      const view = core.task({
        schemaVersion: 1,
        action: "inspect",
        taskId,
        view: "summary",
      });
      if (!view.ok) throw new Error(view.error);
      return (view.data as { requirements: Array<{ requirementId: string }> }).requirements.find(
        (item) => item.requirementId === testing.id,
      );
    };
    expect(testingOf()).toMatchObject({
      status: "unsatisfied",
      reason: expect.stringContaining("agent-reported checks are notes"),
    });
    // A CLI-observed passing check satisfies it without a recorded RED.
    expect(core.observeCheck({ taskId, observation: checkObservation() }).ok).toBe(true);
    expect(testingOf()).toMatchObject({ status: "satisfied" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same reviewer session may re-verify the same requirement", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-reviewer-retry-"));
  try {
    writeFileSync(join(root, "a.ts"), "before");
    // Evidence-based review comes from a project constraint; derived verdicts read the ledger.
    const { store, core, taskId } = startAndAssess(root, behavioralSignals(), "test", [
      methodConstraint("review"),
    ]);
    const policy = policyOf(store, taskId);
    const reviewRequirement = policy.requirements.find((item) =>
      item.ruleId.startsWith("project-constraint:repo-review"),
    )!;
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
          reviewContext: {
            kind: "host",
            host: "workit_cli",
            handle: "reviewer",
          },
        },
      });
    const first = captureCandidate(root, scope(), []);
    if (!first.ok) throw new Error(first.error);
    expect(review(first.data.id).ok).toBe(true);
    writeFileSync(join(root, "a.ts"), "after");
    const second = captureCandidate(root, scope(), []);
    if (!second.ok) throw new Error(second.error);
    expect(review(second.data.id).ok).toBe(true);
    const view = core.task({
      schemaVersion: 1,
      action: "inspect",
      taskId,
      view: "summary",
    });
    expect(view).toMatchObject({
      ok: true,
      data: {
        requirements: expect.arrayContaining([
          expect.objectContaining({
            requirementId: reviewRequirement.id,
            status: "satisfied",
          }),
        ]),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived requirements route to their method skills; dead routes are gone", () => {
  const ruleIds = Object.values(METHODS).flatMap((definition) => definition.ruleIds ?? []);
  for (const dead of ["root-cause-investigation", "durable-handoff"])
    expect(ruleIds).not.toContain(dead);
  const root = mkdtempSync(join(tmpdir(), "workit-method-routes-"));
  try {
    writeTestCheck(root);
    const core = new WorkitCore(new TaskStore(root), context(root));
    const routed = (judgment: Record<string, unknown>) => {
      const preview = core.policy({ action: "preview", ...judgment });
      if (!preview.ok || !preview.data) throw new Error("preview failed");
      return selectMethods(preview.data, []).map((method) => method.id);
    };
    expect(core.task({ action: "start", objective: "route" }).ok).toBe(true);
    expect(routed({ behaviorChange: true, riskTier: "normal" })).toEqual([
      "workit-bdd",
      "workit-review",
    ]);
    expect(routed({ productChoiceOpen: true, needsPlan: true })).toEqual(["workit-shape"]);
    expect(routed({ riskTier: "trivial" })).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
