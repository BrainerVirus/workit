import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  authorizeLiveEvaluation,
  authorizedBudget,
  baselinePassesCapability,
  buildEvaluationPlan,
  CODING_HOSTS,
  collectCapabilityMatrix,
  collectToolchainEvidence,
  enforceBudget,
  qualificationReport,
  renderCapabilitiesMarkdown,
  runIdentity,
  stableReleaseGate,
  targetedRerunSet,
  verifyDeterministicQualification,
  verifyMcpSchemaDialect,
} from "./harness";
import { compareAgainstBaseline, createRunArtifact, judgeRun } from "./judge";
import {
  CA_SCENARIOS,
  E_SCENARIOS,
  FIXTURE_REVISION,
  SAFETY_REPEAT_SCENARIOS,
  assertFixturesFrozen,
} from "./scenarios";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

test("fixtures are frozen before execution", () => {
  assertFixturesFrozen();
  expect(CA_SCENARIOS).toHaveLength(32);
  expect(E_SCENARIOS).toHaveLength(6);
  for (const scenario of [...CA_SCENARIOS, ...E_SCENARIOS]) {
    expect(scenario.fixtureRevision).toBe(FIXTURE_REVISION);
  }
});

test("the qualification matrix is exactly 90 authorized Workit/native runs", () => {
  const plan = buildEvaluationPlan(authorizedBudget());
  expect(plan.mainRuns).toHaveLength(60);
  expect(plan.safetyRepeats).toHaveLength(30);
  expect(new Set(plan.runs.map(runIdentity)).size).toBe(90);
});

test("main runs cover five hosts times six scenarios with and without Workit", () => {
  const plan = buildEvaluationPlan();
  for (const host of CODING_HOSTS) {
    for (const scenario of E_SCENARIOS.map((s) => s.id)) {
      expect(
        plan.mainRuns.some((r) => r.host === host && r.scenario === scenario && r.workit),
      ).toBe(true);
      expect(
        plan.mainRuns.some((r) => r.host === host && r.scenario === scenario && !r.workit),
      ).toBe(true);
    }
  }
});

test("safety repeats cover E-02, E-05, and E-06 twice per host with Workit only", () => {
  const plan = buildEvaluationPlan();
  for (const host of CODING_HOSTS) {
    for (const scenario of SAFETY_REPEAT_SCENARIOS) {
      expect(
        plan.safetyRepeats.filter((r) => r.host === host && r.scenario === scenario),
      ).toHaveLength(2);
      expect(
        plan.safetyRepeats.every((r) => r.workit && SAFETY_REPEAT_SCENARIOS.includes(r.scenario)),
      ).toBe(true);
    }
  }
});

test("a missing or discarded failed run blocks stable release", () => {
  const report = qualificationReport({ missing: ["pi/E-05/workit/repeat-2"] });
  expect(stableReleaseGate(report)).toMatchObject({ ok: false });

  const discarded = qualificationReport({ discarded: ["cursor/E-02/workit"] });
  expect(stableReleaseGate(discarded)).toMatchObject({ ok: false });

  const failed = qualificationReport({ failed: ["opencode/E-01/native"] });
  expect(stableReleaseGate(failed)).toMatchObject({ ok: false });
});

test("an unqualified toolchain or schema publication blocks stable release", () => {
  const report = qualificationReport({
    deterministicFailures: ["mcp_schema_dialect"],
  });
  expect(stableReleaseGate(report)).toMatchObject({ ok: false });
});

test("live evaluation requires explicit bounded authorization", () => {
  const plan = buildEvaluationPlan();
  expect(authorizeLiveEvaluation(undefined, plan.runs.length)).toMatchObject({
    ok: false,
    code: "needs_input",
  });
  expect(authorizeLiveEvaluation(authorizedBudget(), plan.runs.length + 1)).toMatchObject({
    ok: false,
    code: "needs_input",
  });
  expect(authorizeLiveEvaluation(authorizedBudget(), plan.runs.length)).toMatchObject({ ok: true });
});

test("budget enforcement rejects exceeded runs, wall time, and usage", () => {
  const auth = authorizedBudget();
  expect(enforceBudget(auth, { runs: 91, elapsedMs: 1, usage: 0 })).toMatchObject({ ok: false });
  expect(enforceBudget(auth, { runs: 1, elapsedMs: auth.wallTimeMs + 1, usage: 0 })).toMatchObject({
    ok: false,
  });
  expect(
    enforceBudget(auth, { runs: 1, elapsedMs: 1, usage: auth.usageCeiling.value + 1 }),
  ).toMatchObject({
    ok: false,
  });
});

test("external writes are denied unless separately authorized", () => {
  const bad = { ...authorizedBudget(), externalWrites: true as false };
  expect(authorizeLiveEvaluation(bad, 90)).toMatchObject({ ok: false });
});

test("CA-31 toolchain evidence records actual Node, Bun, compiler, schema, and SDK versions", () => {
  const evidence = collectToolchainEvidence();
  expect(evidence.node).toMatch(/^v\d+/);
  expect(evidence.bun).toBeTruthy();
  expect(evidence.typescript).toBe("7.0.2");
  expect(evidence.zod).toBe("4.5.4");
  expect(evidence.mcpSdk).toBe("1.30.0");
  for (const host of CODING_HOSTS) {
    expect(evidence.hosts[host]).toBeTruthy();
  }
});

test("CA-32 MCP schemas publish draft-2020-12 from core definitions", () => {
  expect(verifyMcpSchemaDialect()).toEqual([]);
});

test("capability matrix is generated from adapter fixtures", () => {
  const cells = collectCapabilityMatrix();
  expect(cells.some((c) => c.host === "opencode" && c.capability === "interactive_decision")).toBe(
    true,
  );
  expect(cells.some((c) => c.host === "cursor" && c.capability === "interactive_decision")).toBe(
    true,
  );
  expect(cells.some((c) => c.host === "cli")).toBe(true);
  for (const cell of cells) {
    expect(baselinePassesCapability(cell)).toBe(true);
  }
});

test("unknown or untested capability cells fail the baseline", () => {
  expect(
    baselinePassesCapability({
      host: "cursor",
      capability: "x",
      assurance: "unknown",
      tested: false,
      reason: "",
    }),
  ).toBe(false);
  expect(
    baselinePassesCapability({
      host: "cursor",
      capability: "x",
      assurance: "enforced",
      tested: false,
      reason: "",
    }),
  ).toBe(false);
});

test("committed capabilities.md matches generated adapter fixtures", () => {
  const generated = renderCapabilitiesMarkdown(collectCapabilityMatrix());
  const committed = readFileSync(path.join(REPO_ROOT, "docs/workit-v1/capabilities.md"), "utf8");
  expect(committed).toBe(generated);
});

test("observable action judge rejects self-reported compliance without actions", () => {
  const run = buildEvaluationPlan().runs[0];
  const artifact = createRunArtifact(run);
  const judged = judgeRun(artifact, { actions: [], selfReportedCompliance: true });
  expect(judged.passed).toBe(false);
  expect(judged.scored).toBe(true);
});

test("baseline comparison records regressions and unnecessary friction separately", () => {
  const run = buildEvaluationPlan().runs[0];
  const workit = judgeRun(createRunArtifact(run), {
    actions: ["verified"],
    metrics: { questions: 3, artifacts: 2, reviewRounds: 2 },
  });
  const native = judgeRun(createRunArtifact({ ...run, workit: false }), {
    actions: ["verified"],
    metrics: { questions: 1, artifacts: 0, reviewRounds: 0 },
  });
  const comparison = compareAgainstBaseline(workit, native);
  expect(comparison.unnecessaryFriction.length).toBeGreaterThan(0);
});

test("targeted rerun includes affected scenarios and identities", () => {
  const reruns = targetedRerunSet(["E-05"]);
  expect(reruns.some((id) => id.includes("E-05"))).toBe(true);
  expect(reruns.length).toBeGreaterThan(5);
});

test("deterministic qualification passes while live runs remain authorized separately", () => {
  const result = verifyDeterministicQualification();
  expect(result.ok).toBe(true);
});

test("qualification.md explains commands without fabricated live results", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs/workit-v1/qualification.md"), "utf8");
  expect(doc).toContain("run-v1-evaluation.ts");
  expect(doc).toContain("90");
  expect(doc).not.toMatch(/\bpassed\b.*\b(all|every)\b.*\bruns\b/i);
  expect(doc).not.toContain("TODO: insert results");
});
