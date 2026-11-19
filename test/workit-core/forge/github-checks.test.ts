import { expect, test } from "bun:test";
import { checkFromContext, latestPerName } from "@/packages/workit-core/src/forge/github";
import type { ForgeCheck } from "@/packages/workit-core/src/forge/types";

// #920: head and base checks are de-duplicated per workflow, so a second
// workflow with the same display name never hides the real run.

type Run = { job: number; conclusion: string; workflowId?: number | null; runId?: number };
const node = ({ job, conclusion, workflowId, runId = job }: Run) => ({
  __typename: "CheckRun" as const,
  name: "test (windows-latest)",
  status: "COMPLETED",
  conclusion,
  detailsUrl: null,
  databaseId: job,
  checkSuite: {
    workflowRun: {
      databaseId: runId,
      workflow: { ...(workflowId === undefined ? {} : { databaseId: workflowId }), name: "CI" },
    },
  },
});
const checks = (runs: Run[]): ForgeCheck[] =>
  latestPerName(runs.map((run) => checkFromContext(node(run))).filter((c) => c !== null));

test("Given a real CI workflow failing the job and a second workflow named CI passing it, When the checks are de-duplicated, Then both runs remain", () => {
  const out = checks([
    { job: 1, conclusion: "FAILURE", workflowId: 11 },
    { job: 2, conclusion: "SUCCESS", workflowId: 99 },
  ]);
  expect(out.map((c) => [c.name, c.state, c.workflow])).toEqual([
    ["CI / test (windows-latest)", "failing", 11],
    ["CI / test (windows-latest)", "passing", 99],
  ]);
});

test("Given the same workflow ran the job twice, When the checks are de-duplicated, Then the later attempt replaces the earlier one", () => {
  const out = checks([
    { job: 1, conclusion: "FAILURE", workflowId: 11, runId: 5 },
    { job: 2, conclusion: "SUCCESS", workflowId: 11, runId: 5 },
  ]);
  expect(out.map((c) => [c.state, c.jobId])).toEqual([["passing", 2]]);
});

test("Given an Actions run whose workflow id is missing, Then its check carries workflow null", () => {
  expect(checkFromContext(node({ job: 1, conclusion: "SUCCESS" }))?.workflow).toBeNull();
});

test("Given a status context, Then its check has no workflow", () => {
  const status = checkFromContext({
    __typename: "StatusContext",
    context: "ci/external",
    state: "SUCCESS",
    targetUrl: null,
  });
  expect(status).not.toHaveProperty("workflow");
});
