import { expect, test } from "bun:test";
import type { ForgeRunner } from "@/packages/workit-core/src/forge/exec";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";

// GitLab branchChecks reads the newest pipeline on the base tip: the merge
// guard (#470) refuses on its failing jobs. A stub runner stands in for glab.

const PROJECT = "projects/group%2Fproject";

type Job = {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
};

const forgeWith = (routes: Record<string, unknown>) => {
  const runner: ForgeRunner = (_bin, args) => {
    const endpoint = args[1] ?? "";
    if (!(endpoint in routes))
      return {
        status: 1,
        stdout: "",
        stderr: `unrecorded ${endpoint}`,
        timedOut: false,
        missing: false,
      };
    return {
      status: 0,
      stdout: JSON.stringify(routes[endpoint]),
      stderr: "",
      timedOut: false,
      missing: false,
    };
  };
  return createGitLabForge({
    apiHost: "gitlab.com",
    repo: "group/project",
    runner,
  });
};

const pipelineRoutes = (
  pipelineStatus: string,
  jobs: Job[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  [`${PROJECT}/repository/branches/main`]: { commit: { id: "tip123" } },
  [`${PROJECT}/pipelines?ref=main&sha=tip123&order_by=id&sort=desc&per_page=1`]: [
    {
      id: 55,
      project_id: 9,
      status: pipelineStatus,
      web_url: "https://gitlab.com/group/project/-/pipelines/55",
    },
  ],
  "projects/9/pipelines/55/jobs?per_page=100&page=1": jobs,
  "projects/9/pipelines/55/bridges?per_page=100&page=1": [],
  ...extra,
});

const job = (name: string, status: string, allow_failure = false): Job => ({
  id: name.length,
  name,
  stage: "test",
  status,
  allow_failure,
});

test("given a green pipeline on the base, branchChecks reports passing checks only", () => {
  const read = forgeWith(
    pipelineRoutes("success", [job("unit", "success"), job("lint", "success")]),
  ).branchChecks("main");
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.data.sha).toBe("tip123");
  expect(read.data.requiredKnown).toBe(true);
  expect(read.data.checks.map((check) => check.state)).toEqual(["passing", "passing"]);
});

test("given a red pipeline on the base, branchChecks names the failing required job and an allowed failure does not fail", () => {
  const read = forgeWith(
    pipelineRoutes("failed", [
      job("unit", "failed"),
      job("flaky", "failed", true),
      job("lint", "success"),
    ]),
  ).branchChecks("main");
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const failing = read.data.checks.filter((check) => check.state === "failing");
  expect(failing.map((check) => check.name)).toEqual(["test / unit"]);
  expect(failing[0]?.required).toBe(true);
});

test("given a failed pipeline no job explains, branchChecks adds a failing pipeline check", () => {
  const read = forgeWith(pipelineRoutes("failed", [job("unit", "success")])).branchChecks("main");
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.data.checks.filter((check) => check.state === "failing")).toMatchObject([
    {
      name: "pipeline",
      conclusion: "failed",
      url: "https://gitlab.com/group/project/-/pipelines/55",
    },
  ]);
});

test("given a running pipeline on the base, branchChecks reports pending checks and nothing failing", () => {
  const read = forgeWith(
    pipelineRoutes("running", [job("unit", "running"), job("lint", "success")]),
  ).branchChecks("main");
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.data.checks.filter((check) => check.state === "pending").map((c) => c.name)).toEqual([
    "test / unit",
  ]);
  expect(read.data.checks.some((check) => check.state === "failing")).toBe(false);
});

test("given no pipeline on the base tip, branchChecks has no checks; a missing branch is not_found", () => {
  const none = forgeWith({
    [`${PROJECT}/repository/branches/main`]: { commit: { id: "tip123" } },
    [`${PROJECT}/pipelines?ref=main&sha=tip123&order_by=id&sort=desc&per_page=1`]: [],
  }).branchChecks("main");
  expect(none).toMatchObject({
    ok: true,
    data: { sha: "tip123", checks: [], requiredKnown: true },
  });
  const missing = forgeWith({}).branchChecks("main");
  expect(missing).toMatchObject({ ok: false, code: "not_found" });
});
