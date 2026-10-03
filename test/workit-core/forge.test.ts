import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliFailure, systemRunner } from "@/packages/workit-core/src/forge/exec";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { logTail, redactText, shortBody } from "@/packages/workit-core/src/forge/redact";
import {
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
    expect(docs[1].checks.passing).toBe(2);
  });

  test("the current branch's PR is found: same-repo head over a fork, open over closed", () => {
    const repo = repoFor("github");
    const { resolved, calls } = connect(repo, githubRoutes());
    const report = prStatusReport(repo.cwd, resolved, {});
    expect(report.ok).toBe(true);
    const find = calls.find((call) => call.op === "find");
    expect(find?.vars).toEqual({ owner: "o", name: "r", head: "feature/x" });
    expect(resolved.forge.findPr("feature/x")).toEqual({
      ok: true,
      data: {
        number: 12,
        url: "https://github.com/o/r/pull/12",
        state: "open",
        headBranch: "feature/x",
      },
    });
    const gitlab = repoFor("gitlab");
    expect(connect(gitlab, gitlabRoutes()).resolved.forge.findPr("feature/x")).toMatchObject({
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
      error: "no pull request for branch feature/x in o/r",
      unblock: "push the branch and open one (workit pr create, S11), or pass --pr <n>",
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
      error: "no merge request for branch feature/x in group/project",
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
    const routes = gitlabRoutes(gitlabMr({ draft: true, detailed_merge_status: "draft_status" }));
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
    });
    const gitlab = repoFor("gitlab");
    const routes = gitlabRoutes(gitlabMr({ detailed_merge_status: "need_rebase" }));
    routes[`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`] = "[]";
    expect(statusOf(gitlab, routes)).toMatchObject({ rebaseRequired: true, next: "REBASE" });
    // Behind but not required, nothing else open: READY.
    const passing = repoFor("github");
    expect(statusOf(passing, githubRoutes("github/pr-passing.json"))).toMatchObject({
      rebaseRequired: false,
      behindBase: { behind: 3 },
      next: "READY",
    });
  });

  test("a merged PR reads MERGED and skips the behind-base fetch", () => {
    const repo = repoFor("github");
    expect(statusOf(repo, githubRoutes("github/pr-merged.json"))).toMatchObject({
      state: "merged",
      behindBase: null,
      next: "MERGED",
    });
  });

  test("a GitLab pipeline for an older head does not count for the current head", () => {
    const repo = repoFor("gitlab");
    const mr = JSON.parse(gitlabMr());
    mr.head_pipeline.sha = "0".repeat(40);
    const doc = statusOf(repo, gitlabRoutes(JSON.stringify(mr)));
    expect(doc.checks).toMatchObject({ state: "none", failing: [], pending: [] });
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
    expect(status.data.checks).toHaveLength(104);
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
      // git reports the canonical path (/private/var on macOS, long names on Windows).
      expect(realpathSync(log!)).toBe(
        realpathSync(path.join(repo.cwd, ".git", "workit", "ci-reruns.jsonl")),
      );
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

  test("an account mismatch is blocked with the exact switch command", () => {
    const github = repoFor("github");
    writeWorkspace(github, { provider: "github", account: "someone" });
    expect(checkIdentity(connect(github, githubRoutes()).resolved)).toEqual({
      ok: false,
      code: "blocked",
      error: "identity_mismatch: gh is authenticated as octo but workspace w expects someone",
      unblock: "gh auth switch --hostname github.com --user someone",
    });
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
      unblock: "glab auth login --hostname gitlab.com  # as cpincetti",
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
      if (!resolved.ok) throw new Error(resolved.error);
      expect(checkIdentity(resolved.data)).toEqual({
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
  test("secrets in logs and comments are masked; bodies are capped at 300 chars", () => {
    const gh = `ghp_${"Z9y8".repeat(9)}`;
    const gl = `glpat-${"x".repeat(20)}`;
    const text = [
      `token=${gh}`,
      `curl -H "Authorization: Bearer ${"abcdef".repeat(4)}" https://u:pw123456@example.com/x`,
      `export GITLAB_TOKEN: ${gl}`,
      "token validation failed for user",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(text);
    for (const secret of [gh, gl, "abcdef".repeat(4), "pw123456", "\nabc\n"])
      expect(out).not.toContain(secret);
    expect(out).toContain("token validation failed for user");
    expect(logTail(`a\n${gh}\n`, 5)).toEqual(["a", "[REDACTED]"]);
    expect(shortBody("x".repeat(400))).toHaveLength(300);
    expect(shortBody("line one\n\n  line two")).toBe("line one line two");
  });

  test("next follows the pstack priority: conflicts > rebase > threads > CI", () => {
    const base = { state: "open" as const, conflicts: false, rebaseRequired: false, threads: 0 };
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
  });

  test("ci wait verdicts and the deterministic backoff", () => {
    const doc = (checks: PrStatusDoc["checks"]["state"], extra: Partial<PrStatusDoc> = {}) =>
      ({
        state: "open",
        conflicts: false,
        base: "main",
        head: { branch: "b", sha: "abc123", localSha: null, pushed: null },
        checks: { state: checks, failing: [], pending: [], passing: 0 },
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
    expect([0, 1, 2, 3, 4, 5].map((poll) => pollDelay(30_000, poll))).toEqual([
      30_000, 45_000, 67_500, 101_250, 120_000, 120_000,
    ]);
  });
});
