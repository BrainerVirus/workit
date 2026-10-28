import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { executeRerun, prStatusReport } from "@/packages/workit-core/src/forge/report";
import { rerunLogPath } from "@/packages/workit-core/src/forge/reruns";
import { fixture, replayRunner, replyError } from "@/test/shared/helpers/forge-replay";
import { GH_STATUS, GL_PIPE, githubRoutes, gitlabRoutes, connect, useForgeHarness } from "./shared";

const { repoFor } = useForgeHarness();

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
      expect.objectContaining({
        id: "PRRT_4",
        author: "coderabbitai",
        isBot: true,
      }),
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
      const options = {
        failed: true,
        names: [],
        reason: "flake",
        force: false,
      };
      const first = executeRerun(repo.cwd, resolved, status.data, options);
      expect(first).toMatchObject({
        ok: true,
        data: {
          pr: 12,
          head: repo.head,
          forced: false,
          recorded: true,
          skipped: [],
        },
      });
      const posts = calls.filter((call) => call.method === "POST").map((call) => call.endpoint);
      expect(posts).toEqual([
        kind === "github" ? "repos/o/r/actions/runs/1/rerun-failed-jobs" : `${GL_PIPE}/retry`,
      ]);

      const second = executeRerun(repo.cwd, resolved, status.data, options);
      expect(second).toMatchObject({ ok: false, code: "blocked" });
      expect(!second.ok && second.error).toContain("rerun_limit:");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

      const forced = executeRerun(repo.cwd, resolved, status.data, {
        ...options,
        force: true,
      });
      expect(forced).toMatchObject({ ok: true, data: { forced: true } });

      // The record is shared by worktrees (git common dir) and visible in status.
      const log = rerunLogPath(repo.cwd);
      // Canonical spelling varies (/private/var on macOS, 8.3 names on Windows).
      expect(log!.replaceAll("\\", "/")).toEndWith("/work/.git/workit/ci-reruns.jsonl");
      expect(readFileSync(log!, "utf8").trim().split("\n")).toHaveLength(2);
      const doc = prStatusReport(repo.cwd, resolved, { pr: 12 });
      expect(doc.ok && doc.data.doc.checks.failing[0].rerunsOnHead).toBe(2);

      // A new head starts a fresh allowance.
      const moved = {
        ...status.data,
        head: { ...status.data.head, sha: "f".repeat(40) },
      };
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
    ).toMatchObject({
      ok: false,
      code: "busy",
      unblock: "workit ci wait, then rerun",
    });
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
