import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { executeBranchRerun } from "@/packages/workit-core/src/forge/report";
import { rerunLogPath } from "@/packages/workit-core/src/forge/reruns";
import { fixture } from "@/test/shared/helpers/forge-replay";
import { GL, GL_PIPE, connect, gitlabRoutes, useForgeHarness } from "./forge/shared";

// `ci rerun --branch` on GitLab: the branch's latest pipeline on its tip is
// read through branchChecks and its failed jobs retried through the pipeline
// retry endpoint, under the same once-per-head record as the MR form.

const { repoFor } = useForgeHarness();

const options = { failed: true, names: [], reason: "infra", force: false };

test("given GitLab, when ci rerun --branch main --failed, then the failed jobs of main's latest pipeline are retried once per head", () => {
  const repo = repoFor("gitlab");
  const routes = gitlabRoutes();
  routes[`GET ${GL}/pipelines?ref=main&sha=${repo.base}&order_by=id&sort=desc&per_page=1`] =
    JSON.stringify([
      {
        id: 2909499411,
        project_id: 34675721,
        status: "failed",
        web_url: "https://gitlab.com/group/project/-/pipelines/2909499411",
      },
    ]);
  const { resolved, calls } = connect(repo, routes);
  const ref = resolved.forge.branchChecks("main");
  if (!ref.ok) throw new Error(ref.error);
  expect(ref.data.sha).toBe(repo.base);

  const first = executeBranchRerun(repo.cwd, resolved, "main", ref.data, options);
  if (!first.ok) throw new Error(first.error);
  const failing = JSON.parse(fixture("gitlab/jobs.json")).filter(
    (job: { status: string; allow_failure?: boolean }) =>
      job.status === "failed" && !job.allow_failure,
  );
  expect(first.data).toMatchObject({ pr: null, branch: "main", head: repo.base, recorded: true });
  expect(first.data.rerun.map((check) => check.jobId)).toEqual(
    failing.map((job: { id: number }) => job.id),
  );
  expect(calls.filter((call) => call.method === "POST").map((call) => call.endpoint)).toEqual([
    `${GL_PIPE}/retry`,
  ]);
  const rows = readFileSync(rerunLogPath(repo.cwd)!, "utf8").trim().split("\n");
  expect(JSON.parse(rows[0])).toMatchObject({
    forge: "gitlab",
    pr: null,
    branch: "main",
    runId: 2909499411,
    reason: "infra",
  });

  const second = executeBranchRerun(repo.cwd, resolved, "main", ref.data, options);
  expect(second).toMatchObject({ ok: false, code: "blocked" });
  expect(!second.ok && second.error).toStartWith("rerun_limit:");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("given a branch head with no CI reported, when rerun, then it is not_found and nothing is retried", () => {
  const repo = repoFor("gitlab");
  const { resolved, calls } = connect(repo, gitlabRoutes());
  const ref = resolved.forge.branchChecks("main");
  if (!ref.ok) throw new Error(ref.error);
  const done = executeBranchRerun(repo.cwd, resolved, "main", ref.data, options);
  expect(done).toMatchObject({ ok: false, code: "not_found" });
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
});
