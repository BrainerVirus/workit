/** Observable-action judge for release qualification runs. */

import type { CodingHost, EvaluationRun } from "./harness";
import { FIXTURE_REVISION } from "./scenarios";

export type RunDisposition = "pending" | "passed" | "failed" | "discarded" | "missing";

export type ObservableMetrics = {
  questions: number;
  artifacts: number;
  testRounds: number;
  reviewRounds: number;
  elapsedMs: number;
  usage: { unit: "usd" | "tokens"; value: number };
};

export type RunArtifact = {
  identity: string;
  host: CodingHost;
  scenario: string;
  workit: boolean;
  model: string;
  policyVersion: string;
  configDigest: string;
  fixtureRevision: string;
  disposition: RunDisposition;
  metrics: ObservableMetrics;
  observableActions: string[];
  selfReportedCompliance: boolean;
  scored: boolean;
  passed: boolean;
  reasons: string[];
};

export const emptyMetrics = (): ObservableMetrics => ({
  questions: 0,
  artifacts: 0,
  testRounds: 0,
  reviewRounds: 0,
  elapsedMs: 0,
  usage: { unit: "usd", value: 0 },
});

export const createRunArtifact = (run: EvaluationRun, model = "unauthorized"): RunArtifact => ({
  identity: run.identity,
  host: run.host,
  scenario: run.scenario,
  workit: run.workit,
  model,
  policyVersion: "1.0.0",
  configDigest: "pending",
  fixtureRevision: FIXTURE_REVISION,
  disposition: "pending",
  metrics: emptyMetrics(),
  observableActions: [],
  selfReportedCompliance: false,
  scored: false,
  passed: false,
  reasons: [],
});

/** Score observable actions; self-reported compliance never substitutes for evidence. */
export const judgeRun = (
  artifact: RunArtifact,
  observed: {
    actions: string[];
    metrics?: Partial<ObservableMetrics>;
    selfReportedCompliance?: boolean;
  },
): RunArtifact => {
  const metrics = { ...artifact.metrics, ...observed.metrics };
  const reasons: string[] = [];
  let passed = true;

  if (observed.selfReportedCompliance && observed.actions.length === 0) {
    passed = false;
    reasons.push("self-reported compliance without observable actions");
  }

  if (artifact.disposition === "discarded" || artifact.disposition === "missing") {
    passed = false;
    reasons.push(`run disposition is ${artifact.disposition}`);
  }

  if (artifact.disposition === "failed") {
    passed = false;
    reasons.push("run failed before scoring");
  }

  return {
    ...artifact,
    metrics,
    observableActions: observed.actions,
    selfReportedCompliance: observed.selfReportedCompliance ?? false,
    scored: true,
    passed,
    reasons,
  };
};

export type BaselineComparison = {
  workit: RunArtifact;
  native: RunArtifact;
  regressions: string[];
  unnecessaryFriction: string[];
};

/** Compare with/without Workit; unknown cells fail the baseline instead of reading as supported. */
export const compareAgainstBaseline = (
  workit: RunArtifact,
  native: RunArtifact,
): BaselineComparison => {
  const regressions: string[] = [];
  const unnecessaryFriction: string[] = [];

  if (!workit.scored || !native.scored) {
    regressions.push("unscored comparison cell");
  }

  if (workit.metrics.questions > native.metrics.questions) {
    unnecessaryFriction.push("extra questions versus native baseline");
  }
  if (workit.metrics.artifacts > native.metrics.artifacts) {
    unnecessaryFriction.push("extra artifacts versus native baseline");
  }
  if (workit.metrics.reviewRounds > native.metrics.reviewRounds) {
    unnecessaryFriction.push("extra review rounds versus native baseline");
  }
  if (!workit.passed && native.passed) {
    regressions.push("Workit run failed while native baseline passed");
  }

  return { workit, native, regressions, unnecessaryFriction };
};
