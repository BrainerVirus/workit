import { expect, test } from "bun:test";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { waiveChecks } from "@/packages/workit-core/src/forge/report";
import type { ForgeCheck, ForgePrStatus } from "@/packages/workit-core/src/forge/types";
import { replyError, replayRunner } from "@/test/shared/helpers/forge-replay";
import { GL, gitlabRoutes } from "./shared";

// #269 D1 waivers pass only checks the forge says are optional; #284 N16
// GitLab reads "Pipelines must succeed" to say which jobs are required.

const check = (name: string, overrides: Partial<ForgeCheck> = {}): ForgeCheck => ({
  name: `CI / ${name}`,
  context: name,
  state: "failing",
  conclusion: "failure",
  url: null,
  runId: 1,
  jobId: 2,
  scope: null,
  required: false,
  ...overrides,
});

const status = (checks: ForgeCheck[], requiredContexts: string[] | null = []): ForgePrStatus => ({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "open",
  draft: false,
  base: "main",
  baseSha: null,
  head: { branch: "feature/x", sha: "a".repeat(40) },
  mergeable: "yes",
  conflicts: false,
  rebaseRequired: false,
  reviewDecision: null,
  mergeState: "unstable",
  inMergeQueue: false,
  checks,
  requiredContexts,
  threads: [],
  truncated: false,
});

test("Given an optional failing check, When it is waived by its context or full name, Then it reads skipped as waived", () => {
  for (const name of ["codeql", "CI / codeql"]) {
    const result = waiveChecks(status([check("codeql"), check("unit", { state: "passing" })]), {
      checks: [name],
      reason: "r",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.waived.map((waived) => waived.name)).toEqual(["CI / codeql"]);
    expect(result.data.status.checks[0]).toMatchObject({
      state: "skipped",
      conclusion: "waived_failure",
    });
    expect(result.data.status.checks[1].state).toBe("passing");
  }
});

test("Given a check named by branch protection (required flag unset), When waived, Then it is refused", () => {
  const result = waiveChecks(status([check("unit", { required: null })], ["unit"]), {
    checks: ["unit"],
    reason: "r",
  });
  expect(result).toMatchObject({ ok: false, code: "blocked" });
  expect(result.ok || result.error).toContain("CI / unit (required by branch protection)");
});

test("Given unreadable protection and no required flag, When waived, Then it is refused as not shown optional", () => {
  const result = waiveChecks(status([check("unit", { required: null })], null), {
    checks: ["unit"],
    reason: "r",
  });
  expect(result.ok || result.error).toContain("the forge cannot say it is optional");
});

test("Given a name that matches no check, When waived, Then it is invalid input listing the checks", () => {
  const result = waiveChecks(status([check("unit")]), { checks: ["codeq"], reason: "r" });
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  expect(result.ok || result.error).toContain("CI / unit");
});

const gitlabStatus = (project: Parameters<typeof replayRunner>[0][string]) => {
  const runner = replayRunner({ ...gitlabRoutes(), [`GET ${GL}`]: project });
  const forge = createGitLabForge({ apiHost: "gitlab.com", repo: "group/project", runner });
  const read = forge.prStatus(12);
  if (!read.ok) throw new Error(read.error);
  return read.data;
};

test("Given a GitLab project without 'Pipelines must succeed', When an MR has a failing job, Then its jobs are optional and none is a required context", () => {
  const read = gitlabStatus(
    JSON.stringify({ id: 1, only_allow_merge_if_pipeline_succeeds: false }),
  );
  const failing = read.checks.filter((item) => item.state === "failing");
  expect(failing.length).toBeGreaterThan(0);
  expect(read.checks.every((item) => item.required === false)).toBe(true);
  expect(read.requiredContexts).toEqual([]);
});

test("Given a GitLab project with 'Pipelines must succeed', When an MR has a failing job, Then the jobs that may not fail are required contexts", () => {
  const read = gitlabStatus(JSON.stringify({ id: 1, only_allow_merge_if_pipeline_succeeds: true }));
  const failing = read.checks.find((item) => item.state === "failing");
  expect(failing?.required).toBe(true);
  expect(read.requiredContexts).toContain(failing?.context);
});

test("Given an unreadable GitLab project, When an MR has a failing job, Then the job stays required (a waiver is refused)", () => {
  const read = gitlabStatus(replyError("glab: HTTP 500"));
  const failing = read.checks.find((item) => item.state === "failing");
  expect(failing?.required).toBe(true);
});
