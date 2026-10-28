import { describe, expect, test } from "bun:test";
import { prStatusReport, waitVerdict } from "@/packages/workit-core/src/forge/report";
import { fixture, replyError } from "@/test/shared/helpers/forge-replay";
import {
  GH_STATUS,
  GL,
  GL_PIPE,
  githubRoutes,
  gitlabMr,
  gitlabRoutes,
  connect,
  statusOf,
  shape,
  useForgeHarness,
} from "./shared";

const { repoFor } = useForgeHarness();

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
      expect(doc.behindBase).toEqual({
        behind: 3,
        ahead: 1,
        baseSha: repo.base,
        upToDate: false,
      });
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
    expect(
      resolved.forge.findPr("feature/x", {
        owner: "o",
        projectId: null,
        sha: null,
      }),
    ).toEqual({
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
      resolved.forge.findPr("feature/x", {
        owner: "nobody",
        projectId: null,
        sha: repo.head,
      }),
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
    expect(doc.checks).toMatchObject({
      state: "pending",
      pending: ["CI / fast checks"],
    });
    const gitlab = repoFor("gitlab");
    const draftMr = JSON.parse(gitlabMr({ draft: true, detailed_merge_status: "draft_status" }));
    draftMr.head_pipeline.status = "running";
    const routes = gitlabRoutes(JSON.stringify(draftMr));
    routes[`GET ${GL_PIPE}/jobs?per_page=100&page=1`] = JSON.stringify([
      {
        id: 1,
        name: "test",
        stage: "test",
        status: "running",
        allow_failure: false,
      },
    ]);
    routes[`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`] = "[]";
    expect(statusOf(gitlab, routes)).toMatchObject({
      draft: true,
      next: "WAITING_CI",
    });
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
    ).toMatchObject({
      mergeable: "no",
      conflicts: true,
      next: "RESOLVE_CONFLICTS",
    });
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
    expect(statusOf(gitlab, routes)).toMatchObject({
      rebaseRequired: true,
      next: "REBASE",
    });
    // Behind but not required, nothing else open: READY, and babysitting is
    // done too: behindBase is information, not an update on a busy base.
    const passing = repoFor("github");
    expect(statusOf(passing, githubRoutes("github/pr-passing.json"))).toMatchObject({
      rebaseRequired: false,
      behindBase: { behind: 3 },
      next: "READY",
      babysit: "ready",
    });
    // A draft that still needs a review: next is REVIEW, the babysitter marks it ready.
    const draft = JSON.parse(fixture("github/pr-passing.json"));
    Object.assign(draft.data.repository.pullRequest, {
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
    });
    const draftRoutes = githubRoutes("github/pr-passing.json");
    draftRoutes[GH_STATUS] = JSON.stringify(draft);
    expect(statusOf(repoFor("github"), draftRoutes)).toMatchObject({
      draft: true,
      next: "REVIEW",
      babysit: "mark-ready",
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
    expect(doc.checks).toMatchObject({
      state: "pending",
      failing: [],
      pending: ["pipeline"],
    });
    expect(waitVerdict(doc, { elapsedMs: 10 * 60_000 }).state).toBe("waiting");
  });

  test("a merged-results pipeline without source_sha counts when its merge commit's parent is the MR head", () => {
    const repo = repoFor("gitlab");
    // Shape per the GitLab MR API: head_pipeline on refs/merge-requests/:iid/merge, no source_sha.
    const mr = JSON.parse(gitlabMr());
    Object.assign(mr.head_pipeline, {
      sha: "d".repeat(40),
      ref: "refs/merge-requests/12/merge",
    });
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
    routes["GET repos/o/r/branches/main"] = JSON.stringify({
      name: "main",
      protected: false,
    });
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
    expect(statusOf(repo, githubRoutes()).behindBase).toMatchObject({
      behind: 3,
    });
    expect(refs()).toBe(before);
    expect(repo.git("rev-parse", "--git-path", "FETCH_HEAD")).toBeTruthy();
  });
});
