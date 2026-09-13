#!/usr/bin/env bun
/** Live Workit v1 qualification runner. Requires explicit bounded authorization. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  authorizeLiveEvaluation,
  buildEvaluationPlan,
  type EvaluationAuthorization,
} from "../test/acceptance/harness";

const ARTIFACT_ROOT = path.resolve(import.meta.dir, "..", ".workit-evaluation");

const readAuthorization = (): EvaluationAuthorization | undefined => {
  const raw = process.env.WORKIT_EVALUATION_AUTHORIZATION;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as EvaluationAuthorization;
    return parsed.externalWrites === false ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const main = () => {
  const plan = buildEvaluationPlan();
  const authorization = readAuthorization();
  const gate = authorizeLiveEvaluation(authorization, plan.runs.length);
  if (!gate.ok) {
    console.error(JSON.stringify(gate, null, 2));
    process.exit(2);
  }
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  console.error(
    "live evaluation is authorized but not invoked by this implementation commit; " +
      "record artifacts under .workit-evaluation/ after an explicitly approved batch",
  );
  console.log(
    JSON.stringify(
      {
        status: "needs_input",
        plannedRuns: plan.runs.length,
        fixtureRevision: plan.fixtureRevision,
        artifactRoot: ARTIFACT_ROOT,
      },
      null,
      2,
    ),
  );
};

main();
