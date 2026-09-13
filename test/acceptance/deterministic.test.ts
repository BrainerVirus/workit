import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runActionCommand, runTaskCommand } from "@/packages/workit-cli/src/task";
import {
  authorizeLiveEvaluation,
  authorizedBudget,
  baselinePassesCapability,
  buildEvaluationPlan,
  CODING_HOSTS,
  collectCapabilityMatrix,
  collectToolchainEvidence,
  enforceBudget,
  hostVersionIsProbed,
  qualificationReport,
  renderCapabilitiesMarkdown,
  runIdentity,
  stableReleaseGate,
  targetedRerunSet,
  verifyCompiledSchemaParity,
  verifyReleaseCandidateDeterministicSlice,
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
  const report = qualificationReport({
    missing: ["pi/E-05/workit/repeat-2"],
    toolchain: collectToolchainEvidence(),
  });
  expect(stableReleaseGate(report)).toMatchObject({ ok: false });

  const discarded = qualificationReport({
    discarded: ["cursor/E-02/workit"],
    toolchain: collectToolchainEvidence(),
  });
  expect(stableReleaseGate(discarded)).toMatchObject({ ok: false });

  const failed = qualificationReport({
    failed: ["opencode/E-01/native"],
    toolchain: collectToolchainEvidence(),
  });
  expect(stableReleaseGate(failed)).toMatchObject({ ok: false });
});

test("live complete with empty disposition lists blocks stable release", () => {
  const report = qualificationReport({
    liveRunsComplete: true,
    toolchain: collectToolchainEvidence(),
  });
  const gate = stableReleaseGate(report);
  expect(gate).toMatchObject({ ok: false });
  expect(gate.reasons).toContain("live runs marked complete but no run identities recorded");
});

test("live complete requires exact evaluation-plan run identity coverage", () => {
  const plan = buildEvaluationPlan();
  const partial = qualificationReport({
    liveRunsComplete: true,
    completed: plan.runs.slice(0, 89).map((run) => run.identity),
    toolchain: collectToolchainEvidence(),
  });
  expect(stableReleaseGate(partial)).toMatchObject({ ok: false });

  const complete = qualificationReport({
    liveRunsComplete: true,
    completed: plan.runs.map((run) => run.identity),
    toolchain: collectToolchainEvidence(),
  });
  expect(stableReleaseGate(complete)).toMatchObject({ ok: true });
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
  expect(evidence.bun).toMatch(/^\d+\.\d+/);
  expect(evidence.typescript).toBe("7.0.2");
  expect(evidence.zod).toBe("4.5.4");
  expect(evidence.mcpSdk).toBe("1.30.0");
  for (const host of CODING_HOSTS) {
    expect(hostVersionIsProbed(evidence.hosts[host])).toBe(true);
  }
  expect(evidence.hosts.opencode).toContain("@opencode-ai/plugin@1.18.30");
  expect(evidence.hosts.cursor).toContain("@brainervirus/workit-cursor@");
  expect(evidence.hosts.codex_cli).toContain("codex-cli@0.153.");
  expect(evidence.hosts.codex_desktop).toContain("codex-desktop@");
  expect(evidence.hosts.pi).toContain("@earendil-works/pi-coding-agent@0.85.1");
});

test("CA-32 MCP schemas publish draft-2020-12 from core definitions", () => {
  expect(verifyMcpSchemaDialect()).toEqual([]);
});

test("CA-32 compiled and uncompiled operation schemas agree on the shared corpus", () => {
  expect(verifyCompiledSchemaParity()).toEqual([]);
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

test("stable release gate enforces the capability matrix baseline", () => {
  const report = qualificationReport({
    toolchain: collectToolchainEvidence(),
    liveRunsComplete: true,
    completed: buildEvaluationPlan().runs.map((run) => run.identity),
  });
  expect(stableReleaseGate(report)).toMatchObject({ ok: true });
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

test("CLI command-level acceptance inspects task and action surfaces without model sessions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-accept-cli-"));
  const scope = { description: "acceptance", paths: ["."], exclusions: [] };
  const intent = { objective: "CA acceptance", scope, authorityRefs: [] };
  const capture = () => {
    let stdout = "";
    let stderr = "";
    return {
      out: { write: (chunk: string) => void (stdout += chunk) },
      err: { write: (chunk: string) => void (stderr += chunk) },
      read: () => ({ stdout, stderr }),
    };
  };
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Workit Test"], { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "fixture\n");
    spawnSync("git", ["add", "fixture.txt"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const started = capture();
    expect(
      await runTaskCommand(
        [
          "task",
          "start",
          "--payload",
          JSON.stringify({ expectedWorkspaceRevision: null, intent }),
          "--json",
        ],
        { cwd: root, out: started.out, err: started.err },
      ),
    ).toBe(0);
    const taskId = JSON.parse(started.read().stdout).data.id as string;
    const inspected = capture();
    expect(
      await runTaskCommand(["task", "inspect", "--task", taskId, "--view", "summary", "--json"], {
        cwd: root,
        out: inspected.out,
        err: inspected.err,
      }),
    ).toBe(0);
    expect(JSON.parse(inspected.read().stdout)).toMatchObject({ ok: true, schemaVersion: 1 });
    const preview = capture();
    expect(
      await runActionCommand(
        ["context.read", "--payload", JSON.stringify({ kind: "git" }), "--json"],
        { cwd: root, out: preview.out, err: preview.err, stdinIsTTY: () => false },
      ),
    ).toBe(0);
    expect(JSON.parse(preview.read().stdout)).toMatchObject({
      ok: true,
      data: { kind: "git", context: { workspace_root: root } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release-candidate deterministic slice passes while live runs remain authorized separately", () => {
  const result = verifyReleaseCandidateDeterministicSlice();
  expect(result.ok).toBe(true);
});

test("qualification.md explains commands without fabricated live results", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs/workit-v1/qualification.md"), "utf8");
  expect(doc).toContain("run-v1-evaluation.ts");
  expect(doc).toContain("90");
  expect(doc).not.toMatch(/\bpassed\b.*\b(all|every)\b.*\bruns\b/i);
  expect(doc).not.toContain("TODO: insert results");
});
