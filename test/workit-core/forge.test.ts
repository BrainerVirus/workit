import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliFailure, systemRunner } from "@/packages/workit-core/src/forge/exec";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { logTail, redactText, shortBody } from "@/packages/workit-core/src/forge/redact";
import {
  babysitAction,
  executeRerun,
  nextAction,
  pollDelay,
  prStatusReport,
  waitVerdict,
  type PrStatusDoc,
} from "@/packages/workit-core/src/forge/report";
import {
  checkIdentity,
  resolveForge,
  type ResolvedForge,
} from "@/packages/workit-core/src/forge/resolve";
import { rerunLogPath } from "@/packages/workit-core/src/forge/reruns";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  replyError,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// S10 (design §2.0, §2.1, §5): forge adapters behind one interface, replayed
// from recorded gh/glab API fixtures. No test here reaches the network.

// Each test builds git repos and fetches from a local bare remote; Windows
// runners need well over the 5 s default.
setDefaultTimeout(60_000);

let configDir = "";
const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
const previousVcs = process.env.WORKFLOW_VCS_CONFIG;
beforeAll(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), "wk-forge-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  delete process.env.WORKFLOW_VCS_CONFIG;
});
afterAll(() => {
  if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
  if (previousVcs !== undefined) process.env.WORKFLOW_VCS_CONFIG = previousVcs;
  rmSync(configDir, { recursive: true, force: true });
});

const repos: ForgeRepo[] = [];
afterEach(() => {
  rmSync(path.join(configDir, "workspaces.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});
const repoFor = (kind: "github" | "gitlab"): ForgeRepo => {
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  return repo;
};

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';
const GL = "projects/group%2Fproject";
const GL_PIPE = "projects/34675721/pipelines/2909499411";

const githubRoutes = (pr = "github/pr-failing-thread.json"): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "graphql find": fixture("github/find-pr.json"),
  [GH_STATUS]: fixture(pr),
  "GET repos/o/r/actions/jobs/102/logs": fixture("github/job-log.txt"),
  "POST repos/o/r/actions/runs/1/rerun-failed-jobs": "",
  "POST repos/o/r/actions/jobs/102/rerun": "",
});

const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...JSON.parse(fixture("gitlab/mr-failing-thread.json")), ...overrides });

const gitlabRoutes = (mr: string = gitlabMr()): Record<string, Reply> => ({
  "GET user": fixture("gitlab/user.json"),
  [`GET ${GL}`]: fixture("gitlab/project.json"),
  [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
  [`GET ${GL_PIPE}/bridges?per_page=100&page=1`]: fixture("gitlab/bridges.json"),
  [`GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`]:
    fixture("gitlab/find-mr.json"),
  [`GET ${GL}/merge_requests/12`]: mr,
  [`GET ${GL_PIPE}/jobs?per_page=100&page=1`]: fixture("gitlab/jobs.json"),
  [`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`]:
    fixture("gitlab/discussions.json"),
  "GET projects/34675721/jobs/16914440402/trace": fixture("gitlab/job-trace.txt"),
  [`POST ${GL_PIPE}/retry`]: "{}",
  "POST projects/34675721/jobs/16914440402/retry": "{}",
});

const connect = (
  repo: ForgeRepo,
  routes: Record<string, Reply>,
): { resolved: ResolvedForge; calls: ReturnType<typeof replayRunner>["calls"] } => {
  const runner = replayRunner(routes, repo.subs);
  const resolved = resolveForge(repo.cwd, { runner });
  if (!resolved.ok) throw new Error(resolved.error);
  return { resolved: resolved.data, calls: runner.calls };
};

const statusOf = (repo: ForgeRepo, routes: Record<string, Reply>, pr?: number): PrStatusDoc => {
  const { resolved } = connect(repo, routes);
  const report = prStatusReport(repo.cwd, resolved, { pr });
  if (!report.ok) throw new Error(report.error);
  return report.data.doc;
};

/** Value types, recursively; arrays by their first element. */
const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shape(item)]),
    );
  return value === null ? "null" : typeof value;
};

describe("S10 pr status", () => {
  test("Given GitHub and GitLab fixtures of an open PR with a failing job, one unresolved thread, and base 3 behind, When pr status --json, Then both forges return identical-shape data with logTail populated, unresolvedThreads.length==1, behindBase.behind==3, and next==RESOLVE_THREADS", () => {
    const github = repoFor("github");
    const gitlab = repoFor("gitlab");
    const docs = [statusOf(github, githubRoutes()), statusOf(gitlab, gitlabRoutes())];
    for (const [doc, repo] of [
      [docs[0], github],
      [docs[1], gitlab],
    ] as const) {
      expect(doc.state).toBe("open");
      expect(doc.number).toBe(12);
      expect(doc.head).toEqual({
        branch: "feature/x",
        sha: repo.head,
        localSha: repo.head,
        pushed: true,
      });
      expect(doc.behindBase).toEqual({ behind: 3, ahead: 1, baseSha: repo.base, upToDate: false });
      expect(doc.checks.state).toBe("failing");
      expect(doc.checks.failing).toHaveLength(1);
      expect(doc.checks.failing[0].logTail.length).toBeGreaterThan(5);
      expect(doc.reviews.unresolvedThreads).toHaveLength(1);
      expect(doc.reviews.unresolvedThreads[0]).toMatchObject({
        path: "src/a.ts",
        line: 10,
        author: "reviewer",
        isBot: false,
        body: "Please handle the empty case here before merging.",
      });
      expect(doc.reviews.decision).toBe("review_required");
      expect(doc.mergeable).toBe("yes");
      expect(doc.next).toBe("RESOLVE_THREADS");
      expect(doc.babysit).toBe("address-threads");
    }
    expect(shape(docs[0])).toEqual(shape(docs[1]));
    expect(docs.map((doc) => doc.forge)).toEqual(["github", "gitlab"]);

    // The tail ends at the failure: no timestamps, no ANSI, no runner cleanup.
    const githubTail = docs[0].checks.failing[0].logTail;
    expect(githubTail.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(githubTail.join("\n")).toContain("1 tests failed:");
    expect(githubTail.join("\n")).not.toMatch(/^\d{4}-\d{2}-\d{2}T/mu);
    expect(githubTail.join("\n")).not.toContain("Cleaning up orphan processes");
    const gitlabTail = docs[1].checks.failing[0].logTail;
    expect(gitlabTail.at(-1)).toBe("ERROR: Job failed: exit code 1");
    expect(gitlabTail).toContain("(fail) handles the empty case [1.02ms]");
    expect(gitlabTail.join("\n")).not.toContain("\u001b");
    expect(gitlabTail.join("\n")).not.toMatch(/section_(start|end)/u);

    // GitHub names carry the workflow; GitLab names carry the stage. An
    // allowed GitLab failure does not fail the MR; manual jobs are skipped.
    expect(docs[0].checks.failing[0]).toMatchObject({
      name: "CI / test (ubuntu-latest)",
      runId: 1,
      jobId: 102,
      conclusion: "failure",
      rerunsOnHead: 0,
    });
    expect(docs[1].checks.failing[0]).toMatchObject({
      name: "test / test",
      runId: 2909499411,
      jobId: 16914440402,
      conclusion: "failed",
    });
    expect(docs[1].checks.passing).toBe(3); // lint, allowed-failure audit, bridge
  });

  test("the current branch's PR is found: same-repo head over a fork, open over closed", () => {
    const repo = repoFor("github");
    const { resolved, calls } = connect(repo, githubRoutes());
    const report = prStatusReport(repo.cwd, resolved, {});
    expect(report.ok).toBe(true);
    const find = calls.find((call) => call.op === "find");
    expect(find?.vars).toEqual({ owner: "o", name: "r", head: "feature/x" });
    expect(resolved.forge.findPr("feature/x", { owner: "o", projectId: null, sha: null })).toEqual({
      ok: true,
      data: {
        number: 12,
        url: "https://github.com/o/r/pull/12",
        state: "open",
        headBranch: "feature/x",
        headSha: repo.head,
      },
    });
    // The forker's PR #11 matches neither owner nor sha.
    expect(
      resolved.forge.findPr("feature/x", { owner: "nobody", projectId: null, sha: repo.head }),
    ).toMatchObject({ ok: true, data: { number: 12 } });
    const gitlab = repoFor("gitlab");
    expect(
      connect(gitlab, gitlabRoutes()).resolved.forge.findPr("feature/x", {
        owner: null,
        projectId: 34675721,
        sha: null,
      }),
    ).toMatchObject({
      ok: true,
      data: { number: 12, state: "open" },
    });
  });

  test("no PR for the branch is not_found with the open-one hint, on both forges", () => {
    const github = repoFor("github");
    const gh = connect(github, {
      ...githubRoutes(),
      "graphql find": fixture("github/find-none.json"),
    });
    expect(prStatusReport(github.cwd, gh.resolved, {})).toEqual({
      ok: false,
      code: "not_found",
      error: "no pull request for branch feature/x from o/r in o/r",
      unblock: "workit git push && workit pr create --fill  # or pass --pr <n>",
    });
    const gitlab = repoFor("gitlab");
    const routes = gitlabRoutes();
    routes[
      `GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`
    ] = "[]";
    const gl = connect(gitlab, routes);
    expect(prStatusReport(gitlab.cwd, gl.resolved, {})).toMatchObject({
      ok: false,
      code: "not_found",
      error: "no merge request for branch feature/x from group/project in group/project",
    });
  });

  test("an unknown PR number is not_found (GraphQL error body on exit 1)", () => {
    const repo = repoFor("github");
    const routes = githubRoutes();
    routes['graphql status {"owner":"o","name":"r","number":"999"}'] = {
      status: 1,
      stdout: fixture("github/pr-not-found.json"),
      stderr: "gh: Could not resolve to a PullRequest with the number of 999.",
      timedOut: false,
      missing: false,
    };
    const { resolved } = connect(repo, routes);
    expect(prStatusReport(repo.cwd, resolved, { pr: 999 })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  test("a draft with running checks reads draft:true and WAITING_CI", () => {
    const github = repoFor("github");
    const doc = statusOf(github, githubRoutes("github/pr-draft.json"));
    expect(doc).toMatchObject({ draft: true, next: "WAITING_CI" });
    expect(doc.checks).toMatchObject({ state: "pending", pending: ["CI / fast checks"] });
    const gitlab = repoFor("gitlab");
    const draftMr = JSON.parse(gitlabMr({ draft: true, detailed_merge_status: "draft_status" }));
    draftMr.head_pipeline.status = "running";
    const routes = gitlabRoutes(JSON.stringify(draftMr));
    routes[`GET ${GL_PIPE}/jobs?per_page=100&page=1`] = JSON.stringify([
      { id: 1, name: "test", stage: "test", status: "running", allow_failure: false },
    ]);
    routes[`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`] = "[]";
    expect(statusOf(gitlab, routes)).toMatchObject({ draft: true, next: "WAITING_CI" });
  });

  test("conflicts outrank every other next action, on both forges", () => {
    const github = repoFor("github");
    expect(statusOf(github, githubRoutes("github/pr-conflicts.json"))).toMatchObject({
      mergeable: "no",
      conflicts: true,
      next: "RESOLVE_CONFLICTS",
    });
    const gitlab = repoFor("gitlab");
    expect(
      statusOf(
        gitlab,
        gitlabRoutes(gitlabMr({ has_conflicts: true, detailed_merge_status: "conflict" })),
      ),
    ).toMatchObject({ mergeable: "no", conflicts: true, next: "RESOLVE_CONFLICTS" });
  });

  test("behind base is REBASE only when the forge requires an up-to-date head", () => {
    const github = repoFor("github");
    expect(statusOf(github, githubRoutes("github/pr-behind.json"))).toMatchObject({
      rebaseRequired: true,
      behindBase: { behind: 3 },
      reviews: { decision: "approved" },
      next: "REBASE",
      babysit: "update-branch",
    });
    const gitlab = repoFor("gitlab");
    const routes = gitlabRoutes(gitlabMr({ detailed_merge_status: "need_rebase" }));
    routes[`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`] = "[]";
    expect(statusOf(gitlab, routes)).toMatchObject({ rebaseRequired: true, next: "REBASE" });
    // Behind but not required, nothing else open: READY to merge, but a
    // babysitter keeps the branch updated with its base.
    const passing = repoFor("github");
    expect(statusOf(passing, githubRoutes("github/pr-passing.json"))).toMatchObject({
      rebaseRequired: false,
      behindBase: { behind: 3 },
      next: "READY",
      babysit: "update-branch",
    });
  });

  test("a merged PR reads MERGED and skips the behind-base fetch", () => {
    const repo = repoFor("github");
    expect(statusOf(repo, githubRoutes("github/pr-merged.json"))).toMatchObject({
      state: "merged",
      behindBase: null,
      next: "MERGED",
      babysit: "merged",
    });
  });

  test("a GitLab pipeline for an older head reads pending for the current head, never none", () => {
    const repo = repoFor("gitlab");
    const mr = JSON.parse(gitlabMr());
    mr.head_pipeline.sha = "0".repeat(40);
    const doc = statusOf(repo, gitlabRoutes(JSON.stringify(mr)));
    expect(doc.checks).toMatchObject({ state: "pending", failing: [], pending: ["pipeline"] });
    expect(waitVerdict(doc, { elapsedMs: 10 * 60_000 }).state).toBe("waiting");
  });

  test("a merged-results pipeline without source_sha counts when its merge commit's parent is the MR head", () => {
    const repo = repoFor("gitlab");
    // Shape per the GitLab MR API: head_pipeline on refs/merge-requests/:iid/merge, no source_sha.
    const mr = JSON.parse(gitlabMr());
    Object.assign(mr.head_pipeline, { sha: "d".repeat(40), ref: "refs/merge-requests/12/merge" });
    const routes = gitlabRoutes(JSON.stringify(mr));
    routes[`GET projects/34675721/repository/commits/${"d".repeat(40)}`] = JSON.stringify({
      id: "d".repeat(40),
      parent_ids: [repo.base, repo.head],
    });
    expect(statusOf(repo, routes).checks.state).toBe("failing");
    // A merge commit of some other head is stale: pending.
    routes[`GET projects/34675721/repository/commits/${"d".repeat(40)}`] = JSON.stringify({
      id: "d".repeat(40),
      parent_ids: [repo.base, "e".repeat(40)],
    });
    expect(statusOf(repo, routes).checks).toMatchObject({
      state: "pending",
      pending: ["pipeline"],
    });
  });

  test("on an unprotected branch every check gates and the blocker reads checks_failing", () => {
    const repo = repoFor("github");
    const pr = JSON.parse(fixture("github/pr-failing-thread.json"));
    for (const node of pr.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup
      .contexts.nodes)
      node.isRequired = false;
    pr.data.repository.pullRequest.reviewThreads.nodes = [];
    const routes = githubRoutes();
    routes[GH_STATUS] = JSON.stringify(pr);
    routes["GET repos/o/r/branches/main"] = JSON.stringify({ name: "main", protected: false });
    const doc = statusOf(repo, routes);
    expect(doc.checks.state).toBe("failing");
    expect(doc.blockers[0]).toBe("checks_failing");
    expect(statusOf(repoFor("github"), githubRoutes()).blockers).toContain(
      "required_checks_failing",
    );
  });

  test("a GitLab merged-results pipeline (source_sha = MR head) counts, and a failed pipeline is a floor", () => {
    const repo = repoFor("gitlab");
    const mr = JSON.parse(gitlabMr({ detailed_merge_status: "ci_must_pass" }));
    mr.head_pipeline.sha = "b".repeat(40);
    mr.head_pipeline.source_sha = repo.head;
    const routes = gitlabRoutes(JSON.stringify(mr));
    // Only passing jobs are visible, but the pipeline itself failed.
    routes[`GET ${GL_PIPE}/jobs?per_page=100&page=1`] = JSON.stringify([
      { id: 1, name: "lint", stage: "check", status: "success" },
    ]);
    routes[`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`] = "[]";
    const doc = statusOf(repo, routes);
    expect(doc.checks.state).toBe("failing");
    expect(doc.checks.failing.map((check) => check.name)).toEqual(["pipeline"]);
    expect(doc.next).toBe("FIX_CI");
    expect(doc.babysit).toBe("fix-ci");
    expect(waitVerdict(doc, { elapsedMs: 100_000 }).state).toBe("failed");
  });

  test("GitLab bridge (trigger) jobs carry the downstream pipeline's status", () => {
    const repo = repoFor("gitlab");
    const routes = gitlabRoutes();
    const bridge = JSON.parse(fixture("gitlab/bridges.json"));
    bridge[0].downstream_pipeline.status = "failed";
    routes[`GET ${GL_PIPE}/bridges?per_page=100&page=1`] = JSON.stringify(bridge);
    const doc = statusOf(repo, routes);
    expect(doc.checks.failing.map((check) => [check.name, check.conclusion, check.jobId])).toEqual([
      ["test / test", "failed", 16914440402],
      ["deploy / deploy-docs", "downstream_failed", null],
    ]);
  });

  test("merge blockers beyond CI keep a green PR from READY (draft, changes requested, BLOCKED)", () => {
    const repo = repoFor("github");
    const pr = JSON.parse(fixture("github/pr-passing.json"));
    Object.assign(pr.data.repository.pullRequest, {
      isDraft: true,
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BLOCKED",
    });
    const routes = githubRoutes();
    routes[GH_STATUS] = JSON.stringify(pr);
    const doc = statusOf(repo, routes);
    expect(doc.checks.state).toBe("passing");
    expect(doc.blockers).toEqual(["changes_requested", "draft"]);
    expect(doc.next).toBe("ADDRESS_REVIEW");
    // No rollup and unreadable protection: never "ready" for lack of checks.
    pr.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = null;
    routes[GH_STATUS] = JSON.stringify(pr);
    routes["GET repos/o/r/rules/branches/main"] = replyError("gh: Not Found (HTTP 404)");
    const bare = statusOf(repo, routes);
    expect(bare.checks).toMatchObject({ state: "none", missingRequired: null });
    expect(waitVerdict(bare, { elapsedMs: 100_000 })).toEqual({
      state: "waiting",
      reason: "no_checks_yet",
    });
  });

  test("required checks gate; an optional failure is reported but does not block", () => {
    const repo = repoFor("github");
    const pr = JSON.parse(fixture("github/pr-passing.json"));
    const contexts =
      pr.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
    contexts.push({
      ...contexts[0],
      name: "docs preview",
      conclusion: "FAILURE",
      databaseId: 109,
      isRequired: false,
    });
    Object.assign(pr.data.repository.pullRequest, {
      mergeStateStatus: "UNSTABLE",
      reviewDecision: "APPROVED",
    });
    const routes = githubRoutes();
    routes[GH_STATUS] = JSON.stringify(pr);
    routes["GET repos/o/r/actions/jobs/109/logs"] = "x\n";
    const doc = statusOf(repo, routes);
    expect(doc.checks.state).toBe("passing");
    expect(doc.checks.failing).toEqual([
      expect.objectContaining({ name: "CI / docs preview", required: false }),
    ]);
    expect(doc.next).toBe("READY");
    // A required context that never reported keeps CI pending.
    contexts.splice(1, 1);
    routes[GH_STATUS] = JSON.stringify(pr);
    const missing = statusOf(repo, routes);
    expect(missing.checks).toMatchObject({
      state: "pending",
      missingRequired: ["test (ubuntu-latest)"],
    });
    expect(missing.next).toBe("WAITING_CI");
  });

  test("pr status is a pure read: no ref in the repository moves", () => {
    const repo = repoFor("github");
    const refs = () => repo.git("for-each-ref", "--format=%(refname) %(objectname)");
    const before = refs();
    expect(statusOf(repo, githubRoutes()).behindBase).toMatchObject({ behind: 3 });
    expect(refs()).toBe(before);
    expect(repo.git("rev-parse", "--git-path", "FETCH_HEAD")).toBeTruthy();
  });
});

describe("S10 pagination", () => {
  test("GitHub pages review threads and check contexts together and keeps the latest check run per name", () => {
    const repo = repoFor("github");
    const routes = githubRoutes();
    routes[GH_STATUS] = fixture("github/pr-page1.json");
    routes['graphql status {"owner":"o","name":"r","number":"12","threads":"T1","contexts":"C1"}'] =
      fixture("github/pr-page2.json");
    routes["GET repos/o/r/actions/jobs/202/logs"] = "boom\n";
    const { resolved, calls } = connect(repo, routes);
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    expect(calls.filter((call) => call.op === "status")).toHaveLength(2);
    expect(status.data.truncated).toBe(false);
    expect(status.data.threads).toEqual([
      expect.objectContaining({ id: "PRRT_4", author: "coderabbitai", isBot: true }),
    ]);
    expect(status.data.checks.map((check) => [check.name, check.state, check.jobId])).toEqual([
      ["CI / fast checks", "passing", 101],
      ["CI / test (ubuntu-latest)", "failing", 202],
      ["CI / lint", "pending", 203],
    ]);
    const capped = createGitHubForge({
      apiHost: "github.com",
      repo: "o/r",
      runner: replayRunner(routes, repo.subs),
      maxPages: 1,
    }).prStatus(12);
    expect(capped.ok && capped.data.truncated).toBe(true);
  });

  test("GitLab pages pipeline jobs and discussions until a short page", () => {
    const repo = repoFor("gitlab");
    const routes = gitlabRoutes();
    const template = JSON.parse(fixture("gitlab/jobs.json"))[0];
    routes[`GET ${GL_PIPE}/jobs?per_page=100&page=1`] = JSON.stringify(
      Array.from({ length: 100 }, (_, index) => ({
        ...template,
        id: index + 1,
        name: `shard ${index + 1}`,
      })),
    );
    routes[`GET ${GL_PIPE}/jobs?per_page=100&page=2`] = fixture("gitlab/jobs.json");
    const { resolved } = connect(repo, routes);
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    expect(status.data.checks).toHaveLength(105); // 104 jobs + 1 bridge
    expect(status.data.checks.filter((check) => check.state === "failing")).toHaveLength(1);
    expect(status.data.truncated).toBe(false);
    const capped = createGitLabForge({
      apiHost: "gitlab.com",
      repo: "group/project",
      runner: replayRunner(routes, repo.subs),
      maxPages: 1,
    }).prStatus(12);
    expect(capped.ok && capped.data.truncated).toBe(true);
  });
});

describe("S10 ci rerun", () => {
  for (const kind of ["github", "gitlab"] as const) {
    test(`Given a second ci rerun --failed on the same head (${kind}), Then blocked unless --force`, () => {
      const repo = repoFor(kind);
      const routes = kind === "github" ? githubRoutes() : gitlabRoutes();
      const { resolved, calls } = connect(repo, routes);
      const status = resolved.forge.prStatus(12);
      if (!status.ok) throw new Error(status.error);
      const options = { failed: true, names: [], reason: "flake", force: false };
      const first = executeRerun(repo.cwd, resolved, status.data, options);
      expect(first).toMatchObject({
        ok: true,
        data: { pr: 12, head: repo.head, forced: false, recorded: true, skipped: [] },
      });
      const posts = calls.filter((call) => call.method === "POST").map((call) => call.endpoint);
      expect(posts).toEqual([
        kind === "github" ? "repos/o/r/actions/runs/1/rerun-failed-jobs" : `${GL_PIPE}/retry`,
      ]);

      const second = executeRerun(repo.cwd, resolved, status.data, options);
      expect(second).toMatchObject({ ok: false, code: "blocked" });
      expect(!second.ok && second.error).toContain("rerun_limit:");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

      const forced = executeRerun(repo.cwd, resolved, status.data, { ...options, force: true });
      expect(forced).toMatchObject({ ok: true, data: { forced: true } });

      // The record is shared by worktrees (git common dir) and visible in status.
      const log = rerunLogPath(repo.cwd);
      // Canonical spelling varies (/private/var on macOS, 8.3 names on Windows).
      expect(log!.replaceAll("\\", "/")).toEndWith("/work/.git/workit/ci-reruns.jsonl");
      expect(readFileSync(log!, "utf8").trim().split("\n")).toHaveLength(2);
      const doc = prStatusReport(repo.cwd, resolved, { pr: 12 });
      expect(doc.ok && doc.data.doc.checks.failing[0].rerunsOnHead).toBe(2);

      // A new head starts a fresh allowance.
      const moved = { ...status.data, head: { ...status.data.head, sha: "f".repeat(40) } };
      expect(executeRerun(repo.cwd, resolved, moved, options).ok).toBe(true);
    });
  }

  test("--check reruns the named job; unknown or running checks are refused", () => {
    const repo = repoFor("github");
    const { resolved, calls } = connect(repo, githubRoutes());
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    const named = executeRerun(repo.cwd, resolved, status.data, {
      failed: false,
      names: ["CI / test (ubuntu-latest)"],
      reason: "infra",
      force: false,
    });
    expect(named).toMatchObject({
      ok: true,
      data: { rerun: [{ name: "CI / test (ubuntu-latest)", jobId: 102 }] },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      endpoint: "repos/o/r/actions/jobs/102/rerun",
    });
    expect(
      executeRerun(repo.cwd, resolved, status.data, {
        failed: false,
        names: ["nope"],
        reason: "infra",
        force: false,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const merged = { ...status.data, state: "merged" as const };
    expect(
      executeRerun(repo.cwd, resolved, merged, {
        failed: true,
        names: [],
        reason: "flake",
        force: false,
      }),
    ).toMatchObject({ ok: false, code: "blocked" });
  });

  test("--failed waits for the run to finish: busy while a sibling job is still running", () => {
    const repo = repoFor("github");
    const { resolved, calls } = connect(repo, githubRoutes());
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    const running = {
      ...status.data,
      checks: [
        ...status.data.checks,
        {
          ...status.data.checks[0],
          name: "CI / test (windows-latest)",
          state: "pending" as const,
          jobId: 104,
        },
      ],
    };
    expect(
      executeRerun(repo.cwd, resolved, running, {
        failed: true,
        names: [],
        reason: "flake",
        force: false,
      }),
    ).toMatchObject({ ok: false, code: "busy", unblock: "workit ci wait, then rerun" });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("the once-per-head check runs under an atomic lock: a held lock is busy, a stale one is taken over", () => {
    const repo = repoFor("github");
    const { resolved, calls } = connect(repo, githubRoutes());
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    const lock = rerunLogPath(repo.cwd)!.replace(/\.jsonl$/u, ".lock");
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    const options = { failed: true, names: [], reason: "flake", force: false };
    expect(executeRerun(repo.cwd, resolved, status.data, options)).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(executeRerun(repo.cwd, resolved, status.data, options).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a forge refusal is reported and nothing is recorded", () => {
    const repo = repoFor("github");
    const routes = githubRoutes();
    routes["POST repos/o/r/actions/runs/1/rerun-failed-jobs"] = replyError(
      "gh: This workflow run cannot be rerun (HTTP 403)",
    );
    const { resolved } = connect(repo, routes);
    const status = resolved.forge.prStatus(12);
    if (!status.ok) throw new Error(status.error);
    const result = executeRerun(repo.cwd, resolved, status.data, {
      failed: true,
      names: [],
      reason: "flake",
      force: false,
    });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(() => readFileSync(rerunLogPath(repo.cwd)!, "utf8")).toThrow();
  });
});

describe("S10 forge resolution and identity", () => {
  const writeWorkspace = (repo: ForgeRepo, vcs: Record<string, unknown>) =>
    writeFileSync(
      path.join(configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, vcs }],
      }),
    );

  test("the forge comes from the push remote host, not the fetch URL", () => {
    const repo = repoFor("gitlab");
    const { resolved } = connect(repo, gitlabRoutes());
    expect(resolved).toMatchObject({
      remote: "origin",
      url: "https://gitlab.com/group/project.git",
      forge: { kind: "gitlab", apiHost: "gitlab.com", repo: "group/project" },
      workspace: null,
      expectedAccount: null,
    });
    expect(checkIdentity(resolved)).toEqual({
      ok: true,
      data: { login: "octo", expected: null, matches: null },
    });
  });

  test("the workspace account's token is passed per call; the active account is never switched", () => {
    const github = repoFor("github");
    writeWorkspace(github, { provider: "github", account: "octo" });
    const routes = {
      ...githubRoutes(),
      "CLI auth token --hostname github.com --user octo": "gho_octoTokenFromKeyring\n",
    };
    const { resolved, calls } = connect(github, routes);
    expect(resolved.credential).toBe("gh_account_token");
    expect(checkIdentity(resolved)).toMatchObject({
      ok: true,
      data: { login: "octo", matches: true },
    });
    const apiCalls = calls.filter((call) => call.method !== "CLI");
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.every((call) => call.token === "gho_octoTokenFromKeyring")).toBe(true);
    expect(calls.some((call) => call.endpoint.includes("switch"))).toBe(false);

    // No login for the account: blocked with a login hint, not a switch.
    writeWorkspace(github, { provider: "github", account: "someone" });
    const none = resolveForge(github.cwd, {
      runner: replayRunner({
        ...githubRoutes(),
        "CLI auth token --hostname github.com --user someone": replyError("no oauth token found"),
      }),
    });
    expect(none).toMatchObject({ ok: false, code: "blocked" });
    expect(!none.ok && none.unblock).toStartWith("gh auth login --hostname github.com");
    expect(JSON.stringify(none)).not.toContain("auth switch");

    // A workspace tokenFile wins, is never printed, and a mismatch names the file fix.
    const tokenFile = path.join(configDir, "gh.token");
    writeFileSync(tokenFile, "ghp_fileTokenValue\n");
    writeWorkspace(github, { provider: "github", account: "someone", tokenFile });
    const filed = connect(github, githubRoutes());
    expect(filed.resolved.credential).toBe("workspace_token_file");
    const mismatch = checkIdentity(filed.resolved);
    expect(mismatch).toMatchObject({ ok: false, code: "blocked" });
    expect(!mismatch.ok && mismatch.unblock).toContain("vcs.tokenFile");
    expect(JSON.stringify(mismatch)).not.toContain("ghp_fileTokenValue");
    expect(filed.calls.every((call) => call.token === "ghp_fileTokenValue")).toBe(true);
    rmSync(tokenFile);
  });

  test("a tokenFile token is sent only to a verified host, never to a look-alike (github.evil.com)", () => {
    const tokenFile = path.join(configDir, "work.token");
    writeFileSync(tokenFile, "ghp_workPatValue\n");
    const evil = repoFor("github");
    evil.git("remote", "set-url", "--push", "origin", "https://github.evil.com/o/r.git");
    writeWorkspace(evil, { provider: "github", tokenFile });
    const runner = replayRunner({});
    const blocked = resolveForge(evil.cwd, { runner });
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
    expect(!blocked.ok && blocked.error).toStartWith("token_host_unverified:");
    expect(runner.calls).toEqual([]);
    expect(JSON.stringify(blocked)).not.toContain("ghp_workPatValue");

    // An ~/.ssh/config alias that resolves to github.com gets the token.
    const alias = repoFor("github");
    try {
      alias.git("remote", "set-url", "--push", "origin", "git@github-work.com:o/r.git");
      writeWorkspace(alias, { provider: "github", tokenFile });
      const aliasRunner = replayRunner(githubRoutes(), alias.subs);
      const resolved = resolveForge(alias.cwd, {
        runner: aliasRunner,
        sshConfig: "Host github-work.com\n  HostName github.com\n",
      });
      expect(resolved).toMatchObject({
        ok: true,
        data: { credential: "workspace_token_file", forge: { apiHost: "github.com" } },
      });
      expect(aliasRunner.calls.length).toBeGreaterThan(0);
      expect(aliasRunner.calls.every((call) => call.token === "ghp_workPatValue")).toBe(true);
    } finally {
      rmSync(tokenFile, { force: true });
    }
  });

  test("an app/Actions token that cannot read /user passes read verbs with a note", () => {
    const repo = repoFor("github");
    const routes = githubRoutes();
    routes["GET user"] = replyError("gh: Resource not accessible by integration (HTTP 403)");
    expect(checkIdentity(connect(repo, routes).resolved)).toMatchObject({
      ok: true,
      data: { login: null, matches: null, note: expect.stringContaining("identity not checked") },
    });
  });

  test("a branch-name match from a stranger's fork is not our PR (M5)", () => {
    const repo = repoFor("github");
    const routes = githubRoutes();
    routes["graphql find"] = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 99,
                url: "u",
                state: "OPEN",
                headRefName: "feature/x",
                headRefOid: "2".repeat(40),
                headRepositoryOwner: { login: "stranger" },
              },
            ],
          },
        },
      },
    });
    const { resolved } = connect(repo, routes);
    expect(prStatusReport(repo.cwd, resolved, {})).toMatchObject({ ok: false, code: "not_found" });
  });

  test("a fork push remote looks PRs up in the parent repository (M6)", () => {
    const repo = repoFor("github");
    repo.git("remote", "set-url", "--push", "origin", "https://github.com/me/r.git");
    const routes: Record<string, Reply> = {
      ...githubRoutes(),
      "GET repos/me/r": JSON.stringify({ id: 7, fork: true, parent: { full_name: "o/r" } }),
    };
    const { resolved, calls } = connect(repo, routes);
    expect(resolved).toMatchObject({ fork: true, headRepo: "me/r", forge: { repo: "o/r" } });
    routes["graphql find"] = fixture("github/find-pr.json").replaceAll(
      '"login": "o"',
      '"login": "me"',
    );
    const forked = connect(repo, routes);
    const report = prStatusReport(repo.cwd, forked.resolved, {});
    expect(report.ok && report.data.doc).toMatchObject({
      number: 12,
      repo: "o/r",
      headRepo: "me/r",
    });
    expect(calls.some((call) => call.endpoint === "repos/me/r")).toBe(true);
    // An `upstream` remote names the base repo directly.
    const up = repoFor("github");
    up.git("remote", "add", "upstream", "https://github.com/o/r.git");
    up.git("remote", "set-url", "--push", "origin", "https://github.com/me/r.git");
    const viaUpstream = connect(up, {
      ...routes,
      "GET repos/me/r": JSON.stringify({ id: 7, fork: false }),
    });
    expect(viaUpstream.resolved).toMatchObject({
      fork: true,
      baseRemote: "upstream",
      forge: { repo: "o/r" },
    });
  });

  test("a GitLab account mismatch is blocked with a login hint", () => {
    const gitlab = repoFor("gitlab");
    writeWorkspace(gitlab, { provider: "gitlab", account: "Octo" });
    expect(checkIdentity(connect(gitlab, gitlabRoutes()).resolved)).toMatchObject({
      ok: true,
      data: { login: "octo", matches: true },
    });
    writeWorkspace(gitlab, { provider: "gitlab", account: "cpincetti" });
    expect(checkIdentity(connect(gitlab, gitlabRoutes()).resolved)).toMatchObject({
      ok: false,
      code: "blocked",
      unblock: "glab auth login --hostname gitlab.com  # sign in as cpincetti",
    });
  });

  test("a workspace provider that disagrees with the push remote is blocked (D16)", () => {
    const repo = repoFor("github");
    writeWorkspace(repo, { provider: "gitlab" });
    const resolved = resolveForge(repo.cwd, { runner: replayRunner({}) });
    expect(resolved).toMatchObject({ ok: false, code: "blocked" });
    expect(!resolved.ok && resolved.error).toStartWith("forge_mismatch:");
    expect(!resolved.ok && resolved.unblock).toContain("workit-github-override");
  });

  test("a missing gh is unavailable with an install hint", () => {
    const repo = repoFor("github");
    const empty = mkdtempSync(path.join(os.tmpdir(), "wk-empty-path-"));
    try {
      const resolved = resolveForge(repo.cwd, {
        env: { ...process.env, PATH: empty, Path: empty },
      });
      expect(resolved).toEqual({
        ok: false,
        code: "unavailable",
        error: "gh is not installed",
        unblock: "install the GitHub CLI (https://cli.github.com) and run: gh auth login",
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("CLI failures map to envelope codes without echoing secrets", () => {
    const run = (stderr: string, extra: Partial<Parameters<typeof cliFailure>[2]> = {}) =>
      cliFailure("gh", "github.com", { ...replyError(stderr), ...extra }, "user", 20_000);
    expect(run("To get started with GitHub CLI, please run:  gh auth login")).toEqual({
      ok: false,
      code: "unavailable",
      error: "gh is not authenticated for github.com",
      unblock: "gh auth login --hostname github.com",
    });
    expect(run("", { timedOut: true })).toMatchObject({
      code: "unavailable",
      error: "gh api user timed out after 20000 ms",
    });
    expect(run("gh: Not Found (HTTP 404)")).toMatchObject({ code: "not_found" });
    const token = `ghp_${"A1b2".repeat(9)}`;
    const leaked = run(`fatal: https://x:${token}@github.com/o/r failed`);
    expect(JSON.stringify(leaked)).not.toContain(token);
  });

  test.skipIf(process.platform === "win32")(
    "the system runner targets the API host, disables prompts, and is killed at its timeout",
    () => {
      const bin = mkdtempSync(path.join(os.tmpdir(), "wk-fake-gh-"));
      const sleepBin = ["/bin/sleep", "/usr/bin/sleep"].find((file) => existsSync(file));
      try {
        writeFileSync(
          path.join(bin, "gh"),
          `#!/bin/sh\n[ "$2" = slow ] && exec ${sleepBin} 5\nprintf '{"login":"%s"}' "$GH_HOST-$GH_PROMPT_DISABLED"\n`,
          { mode: 0o755 },
        );
        const runner = systemRunner("github", "ghe.example.com", { ...process.env, PATH: bin });
        expect(runner("gh", ["api", "user"], { timeoutMs: 5000 })).toMatchObject({
          status: 0,
          stdout: '{"login":"ghe.example.com-1"}',
        });
        const started = Date.now();
        expect(runner("gh", ["api", "slow"], { timeoutMs: 300 })).toMatchObject({ timedOut: true });
        expect(Date.now() - started).toBeLessThan(4000);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );
});

describe("S10 redaction and verdicts", () => {
  // Every reviewer example; secrets are assembled at runtime so no literal
  // token-shaped string sits in the repository.
  const a = (n: number, c = "a") => c.repeat(n);
  // Prefixes are joined at runtime so secret scanners see no token literal.
  const GL_PAT = ["gl", "pat-"].join("");
  const REDACTION_CASES: Array<[string, string, string]> = [
    ["ghp", `token ghp_${a(36)}`, `ghp_${a(36)}`],
    [
      "ghs in url",
      `https://x-access-token:ghs_${a(36, "B")}@github.com/o/r.git`,
      `ghs_${a(36, "B")}`,
    ],
    ["github_pat", `github_pat_11ABCDEFG0${a(70, "x")}`, a(70, "x")],
    ["glpat", `${GL_PAT}abcdEFGH1234ijkl5678`, "abcdEFGH1234ijkl5678"],
    ["glrt", `glrt-t1_${a(20, "Z")}`, a(20, "Z")],
    ["gldt", `gldt-${a(20, "q")}`, a(20, "q")],
    [
      "CI_JOB_TOKEN glcbt",
      `CI_JOB_TOKEN=${["gl", "cbt-"].join("")}64_abcdefghijklmnopqrstu`,
      "abcdefghijklmnopqrstu",
    ],
    ["aws id", `AKIA${"IOSFODNN7EXAMPLE"}`, "IOSFODNN7EXAMPLE"],
    [
      "aws secret env",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI",
    ],
    [
      "aws secret yaml",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI",
    ],
    ["GH_TOKEN env", `GH_TOKEN=${a(5, "deadbeef")}`, "deadbeefdeadbeef"],
    ["NPM_TOKEN env", "NPM_TOKEN=abcdef0123456789abcdef", "abcdef0123456789abcdef"],
    ["DB_PASSWORD env", "DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
    ["MY_API_KEY env", "MY_API_KEY=abcdef0123456789", "abcdef0123456789"],
    ["DJANGO_SECRET_KEY env", "DJANGO_SECRET_KEY=abcdef0123456789xyz", "abcdef0123456789xyz"],
    ["json access_token", '{"access_token": "abcdefghijklmnop1234"}', "abcdefghijklmnop1234"],
    ["json password", '"password":"s3cr3tpassw0rd"', "s3cr3tpassw0rd"],
    [
      "jwt",
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
      "dozjgNryP4J3",
    ],
    ["url user-only token", `https://ghp_${a(36, "c")}@github.com/o/r`, a(36, "c")],
    [
      "url oauth2",
      `https://oauth2:${GL_PAT}abcdefghijklmnopqrst@gitlab.com/g/p.git`,
      "abcdefghijklmnopqrst",
    ],
    ["url password with %40", "https://user:p%40ss@host/x", "p%40ss"],
    ["url password with colon", "postgres://admin:pa:ss@db:5432/x", "pa:ss"],
    ["basic auth header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["x-api-key header", "X-Api-Key: 0123456789abcdef0123", "0123456789abcdef0123"],
    ["PRIVATE-TOKEN header", "PRIVATE-TOKEN: abcdefghijklmnop", "abcdefghijklmnop"],
    ["curl -u", "curl -u admin:SuperSecret123 https://x", "SuperSecret123"],
    [
      "base64 blob",
      "echo dXNlcjpnaHBfYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh | base64 -d",
      "dXNlcjpnaHBf",
    ],
    ["slack webhook", `https://hooks.slack.com/services/T000/B000/${a(24, "X")}`, a(24, "X")],
    ["google api key", `AIza${"SyA-1234567890abcdefghijklmnopqrstu"}`, "SyA-1234567890"],
    ["stripe live", `sk_live_${a(24)}`, a(24)],
    [
      "azure AccountKey",
      "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc123def456ghi789==;",
      "abc123def456ghi789",
    ],
    [
      "private key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXk",
    ],
    [
      "truncated private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz",
      "MIIEowIBAAKCAQEAxyz",
    ],
    ["ansi-split token", `ghp_\u001b[0m${a(36)}`, a(36)],
    ["bearer", `Authorization: Bearer ${a(4, "abcdef")}`, a(4, "abcdef")],
    ["quoted value with spaces", 'password: "correct horse battery"', "correct horse"],
    ["netrc", "machine api.github.com login bot password s3cr3tv4lue", "s3cr3tv4lue"],
    ["netrc multiline", "login bot\npassword multiline_secret", "multiline_secret"],
    [
      "azure sas sig",
      "https://a.blob.core.windows.net/c/f?sv=2022-11-02&sig=AbCdEf%2Bgh%3D&se=2026",
      "AbCdEf",
    ],
    ["sshpass -p", "sshpass -p hunter22 ssh host", "hunter22"],
    ["mysql -p", "mysql -u root -pSuperSecret db", "SuperSecret"],
  ];
  for (const [label, input, secret] of REDACTION_CASES)
    test(`redacts ${label}`, () => {
      const out = redactText(input);
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED");
    });

  test("ordinary log text, shas and prose survive redaction", () => {
    for (const keep of [
      "token validation failed for user",
      "Author: reviewer",
      "HEAD is now at 209cdeb890ea6b264f50fa34ef6f160549b7dd8b fix(core): x",
      "error: expect(received).toEqual(expected)",
      "(fail) Given three processes each making 40 writes",
      "password reset email sent",
      "mysql -u root -p db",
    ])
      expect(redactText(keep)).toBe(keep);
  });

  test("a private key split across log lines is gone from the tail; secrets in comments too", () => {
    const keylog = [
      "start",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxyz",
      "MIIEowIBAAKCAQEAabc",
      "-----END RSA PRIVATE KEY-----",
      "done",
    ].join("\n");
    expect(logTail(keylog, 4).join("\n")).not.toMatch(/MIIEow/u);
    expect(shortBody(`use token ghp_${a(36, "z")} please`)).toBe("use token [REDACTED] please");
  });

  test("a bare carriage return keeps what the terminal finally showed", () => {
    expect(logTail("10%\r50%\r100% done\nerror: x\r\n", 5)).toEqual(["100% done", "error: x"]);
  });

  test("the log view leads with the region around the first real error, then the end", () => {
    const log = [
      ...Array.from({ length: 30 }, (_, i) => `(pass) case ${i} handles a failed reservation`),
      "setup line",
      "src/a.test.ts:",
      "error: expect(received).toBe(expected)",
      "Expected: 0",
      "Received: 1",
      ...Array.from({ length: 50 }, (_, i) => `noise ${i}`),
      " 1 fail",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
    ].join("\n");
    const view = logTail(log, 12);
    expect(view.length).toBeLessThanOrEqual(12);
    expect(view.slice(0, 3)).toEqual([
      "(pass) case 29 handles a failed reservation",
      "setup line",
      "src/a.test.ts:",
    ]);
    expect(view).toContain("error: expect(received).toBe(expected)");
    expect(view).toContain("…");
    expect(view.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(view).not.toContain("Post job cleanup.");
  });

  test("comment bodies are capped at 300 chars and flattened", () => {
    expect(shortBody("x".repeat(400))).toHaveLength(300);
    expect(shortBody("line one\n\n  line two")).toBe("line one line two");
  });

  test("next follows the pstack priority: conflicts > rebase > threads > CI", () => {
    const base = {
      forge: "github" as const,
      state: "open" as const,
      draft: false,
      conflicts: false,
      rebaseRequired: false,
      mergeable: "yes" as const,
      mergeState: "clean",
      inMergeQueue: false,
      reviewDecision: null,
      threads: 0,
    };
    expect(
      nextAction({ ...base, conflicts: true, rebaseRequired: true, threads: 2, checks: "failing" }),
    ).toBe("RESOLVE_CONFLICTS");
    expect(nextAction({ ...base, rebaseRequired: true, threads: 2, checks: "failing" })).toBe(
      "REBASE",
    );
    expect(nextAction({ ...base, threads: 1, checks: "failing" })).toBe("RESOLVE_THREADS");
    expect(nextAction({ ...base, checks: "failing" })).toBe("FIX_CI");
    expect(nextAction({ ...base, checks: "pending" })).toBe("WAITING_CI");
    expect(nextAction({ ...base, checks: "none" })).toBe("READY");
    expect(nextAction({ ...base, state: "merged", conflicts: true, checks: "failing" })).toBe(
      "MERGED",
    );
    expect(nextAction({ ...base, state: "closed", checks: "passing" })).toBe("CLOSED");
    const green = { ...base, checks: "passing" as const };
    expect(nextAction({ ...green, reviewDecision: "changes_requested", draft: true })).toBe(
      "ADDRESS_REVIEW",
    );
    expect(nextAction({ ...green, reviewDecision: "review_required" })).toBe("REVIEW");
    expect(nextAction({ ...green, draft: true })).toBe("MARK_READY");
    expect(nextAction({ ...green, inMergeQueue: true })).toBe("IN_MERGE_QUEUE");
    expect(nextAction({ ...green, mergeState: "blocked" })).toBe("NOT_MERGEABLE");
    expect(nextAction({ ...green, mergeable: "unknown" })).toBe("NOT_MERGEABLE");
    expect(nextAction({ ...green, mergeState: "unstable" })).toBe("READY");
    const gl = { ...green, forge: "gitlab" as const };
    expect(nextAction({ ...gl, mergeState: "mergeable" })).toBe("READY");
    expect(nextAction({ ...gl, mergeState: "not_approved" })).toBe("REVIEW");
    expect(nextAction({ ...gl, mergeState: "discussions_not_resolved" })).toBe("RESOLVE_THREADS");
    expect(nextAction({ ...gl, checks: "none", mergeState: "ci_must_pass" })).toBe("WAITING_CI");
    expect(nextAction({ ...gl, mergeState: "draft_status" })).toBe("MARK_READY");
    expect(nextAction({ ...gl, mergeState: "jira_association_missing" })).toBe("NOT_MERGEABLE");
  });

  test("babysit maps next to one step and updates a stale branch only when nothing else is open", () => {
    const behind = { behind: 2 };
    const even = { behind: 0 };
    expect(babysitAction("MERGED", "merged", behind)).toBe("merged");
    expect(babysitAction("CLOSED", "closed", behind)).toBeNull();
    expect(babysitAction("RESOLVE_CONFLICTS", "conflicts", even)).toBe("update-branch");
    expect(babysitAction("REBASE", "behind_base_required", even)).toBe("update-branch");
    // A fix or a wait in flight is not churned by a base update.
    expect(babysitAction("RESOLVE_THREADS", "unresolved_threads", behind)).toBe("address-threads");
    expect(babysitAction("ADDRESS_REVIEW", "changes_requested", even)).toBe("address-threads");
    expect(babysitAction("FIX_CI", "checks_failing", behind)).toBe("fix-ci");
    expect(babysitAction("WAITING_CI", "checks_pending", behind)).toBe("wait");
    expect(babysitAction("IN_MERGE_QUEUE", "in_merge_queue", even)).toBe("wait");
    expect(babysitAction("NOT_MERGEABLE", "mergeability_unknown", even)).toBe("wait");
    // Nothing left for the agent: a human approval or a forge rule decides.
    expect(babysitAction("REVIEW", "review_required", even)).toBe("ready");
    expect(babysitAction("NOT_MERGEABLE", "merge_state_blocked", even)).toBe("ready");
    expect(babysitAction("READY", null, null)).toBe("ready");
    expect(babysitAction("READY", null, behind)).toBe("update-branch");
    expect(babysitAction("REVIEW", "review_required", behind)).toBe("update-branch");
  });

  test("ci wait verdicts and the deterministic backoff", () => {
    const doc = (checks: PrStatusDoc["checks"]["state"], extra: Partial<PrStatusDoc> = {}) =>
      ({
        state: "open",
        conflicts: false,
        base: "main",
        head: { branch: "b", sha: "abc123", localSha: null, pushed: null },
        mergeState: "clean",
        checks: { state: checks, failing: [], pending: [], passing: 0, missingRequired: [] },
        ...extra,
      }) as PrStatusDoc;
    expect(waitVerdict(doc("passing"), { elapsedMs: 0 })).toEqual({
      state: "ready",
      reason: "checks_passing",
    });
    expect(waitVerdict(doc("failing"), { elapsedMs: 0 }).state).toBe("failed");
    expect(waitVerdict(doc("pending"), { elapsedMs: 0 }).state).toBe("waiting");
    expect(waitVerdict(doc("passing"), { head: "def", elapsedMs: 0 })).toEqual({
      state: "waiting",
      reason: "head_mismatch",
    });
    expect(waitVerdict(doc("none"), { elapsedMs: 0 }).reason).toBe("no_checks_yet");
    expect(waitVerdict(doc("none"), { elapsedMs: 100_000 })).toEqual({
      state: "ready",
      reason: "no_checks",
    });
    expect(waitVerdict(doc("none", { conflicts: true }), { elapsedMs: 0 }).state).toBe("blocked");
    expect(waitVerdict(doc("passing", { state: "closed" }), { elapsedMs: 0 })).toMatchObject({
      state: "blocked",
      reason: "pr_closed",
    });
    expect(waitVerdict(doc("passing", { state: "merged" }), { elapsedMs: 0 }).state).toBe(
      "blocked",
    );
    expect([0, 1, 2, 3, 4, 5].map((poll) => pollDelay(30_000, poll))).toEqual([
      30_000, 45_000, 67_500, 101_250, 120_000, 120_000,
    ]);
  });
});
