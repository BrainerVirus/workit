import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliFailure, systemRunner } from "@/packages/workit-core/src/forge/exec";
import { prStatusReport } from "@/packages/workit-core/src/forge/report";
import { checkIdentity, resolveForge } from "@/packages/workit-core/src/forge/resolve";
import {
  fixture,
  replayRunner,
  replyError,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { githubRoutes, gitlabRoutes, connect, useForgeHarness } from "./shared";

const { configDir, repoFor } = useForgeHarness();

describe("S10 forge resolution and identity", () => {
  const writeWorkspace = (repo: ForgeRepo, vcs: Record<string, unknown>) =>
    writeFileSync(
      path.join(configDir(), "workspaces.json"),
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
    const tokenFile = path.join(configDir(), "gh.token");
    writeFileSync(tokenFile, "ghp_fileTokenValue\n", { mode: 0o600 });
    writeWorkspace(github, {
      provider: "github",
      account: "someone",
      tokenFile,
    });
    const filed = connect(github, githubRoutes());
    expect(filed.resolved.credential).toBe("workspace_token_file");
    const mismatch = checkIdentity(filed.resolved);
    expect(mismatch).toMatchObject({ ok: false, code: "blocked" });
    expect(!mismatch.ok && mismatch.unblock).toContain("vcs.tokenFile");
    expect(JSON.stringify(mismatch)).not.toContain("ghp_fileTokenValue");
    expect(filed.calls.every((call) => call.token === "ghp_fileTokenValue")).toBe(true);
    rmSync(tokenFile);
  });

  test.skipIf(process.platform === "win32")(
    "Given a vcs.tokenFile other users can read, When the forge resolves, Then it is refused with a chmod 600 unblock and the token is never read",
    () => {
      const tokenFile = path.join(configDir(), "shared.token");
      writeFileSync(tokenFile, "ghp_groupReadableValue\n", { mode: 0o640 });
      chmodSync(tokenFile, 0o640);
      const github = repoFor("github");
      writeWorkspace(github, {
        provider: "github",
        account: "someone",
        tokenFile,
      });
      const refused = resolveForge(github.cwd, {
        runner: replayRunner(githubRoutes()),
      });
      expect(refused).toMatchObject({ ok: false, code: "blocked" });
      expect(!refused.ok && refused.error).toContain("readable by group or other (mode 0640)");
      expect(!refused.ok && refused.unblock).toBe(`chmod 600 ${tokenFile}`);
      expect(JSON.stringify(refused)).not.toContain("ghp_groupReadableValue");
      // 0400 has no group/other bits: accepted.
      chmodSync(tokenFile, 0o400);
      expect(connect(github, githubRoutes()).resolved.credential).toBe("workspace_token_file");
      rmSync(tokenFile, { force: true });
    },
  );

  test("a tokenFile token is sent only to a verified host, never to a look-alike (github.evil.com)", () => {
    const tokenFile = path.join(configDir(), "work.token");
    writeFileSync(tokenFile, "ghp_workPatValue\n", { mode: 0o600 });
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
        data: {
          credential: "workspace_token_file",
          forge: { apiHost: "github.com" },
        },
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
      data: {
        login: null,
        matches: null,
        note: expect.stringContaining("identity not checked"),
      },
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
    expect(prStatusReport(repo.cwd, resolved, {})).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  test("a fork push remote looks PRs up in the parent repository (M6)", () => {
    const repo = repoFor("github");
    repo.git("remote", "set-url", "--push", "origin", "https://github.com/me/r.git");
    const routes: Record<string, Reply> = {
      ...githubRoutes(),
      "GET repos/me/r": JSON.stringify({
        id: 7,
        fork: true,
        parent: { full_name: "o/r" },
      }),
    };
    const { resolved, calls } = connect(repo, routes);
    expect(resolved).toMatchObject({
      fork: true,
      headRepo: "me/r",
      forge: { repo: "o/r" },
    });
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

  test("a GitLab account mismatch is blocked with a workspace-token fix", () => {
    const gitlab = repoFor("gitlab");
    writeWorkspace(gitlab, { provider: "gitlab", account: "Octo" });
    expect(checkIdentity(connect(gitlab, gitlabRoutes()).resolved)).toMatchObject({
      ok: true,
      data: { login: "octo", matches: true },
    });
    writeWorkspace(gitlab, { provider: "gitlab", account: "cpincetti" });
    // glab keeps one login per host, so the fix is a workspace token, not a switch.
    expect(checkIdentity(connect(gitlab, gitlabRoutes()).resolved)).toMatchObject({
      ok: false,
      code: "blocked",
      unblock:
        "put a token for cpincetti in the workspace w vcs.tokenFile (glab keeps one login per host, so workit never switches it)",
    });
  });

  test("a glab login switch shows on the next identity check in the same process (cli_login is not memoized)", () => {
    const gitlab = repoFor("gitlab");
    writeWorkspace(gitlab, { provider: "gitlab", account: "octo" });
    let login = "octo";
    const runner = replayRunner({
      ...gitlabRoutes(),
      "GET user": () => JSON.stringify({ id: 1, username: login }),
    });
    const check = () => {
      const resolved = resolveForge(gitlab.cwd, { runner });
      if (!resolved.ok) throw new Error(resolved.error);
      return checkIdentity(resolved.data);
    };
    expect(check()).toMatchObject({ ok: true, data: { matches: true } });
    login = "someone-else";
    expect(check()).toMatchObject({ ok: false, code: "blocked" });
  });

  test("an explicit gh account token is looked up once per process and gh config dir", () => {
    const github = repoFor("github");
    writeWorkspace(github, { provider: "github", account: "octo" });
    const runner = replayRunner({
      ...githubRoutes(),
      "CLI auth token --hostname github.com --user octo": "gho_octo\n",
    });
    const lookups = () => runner.calls.filter((call) => call.method === "CLI").length;
    const env = { ...process.env, GH_CONFIG_DIR: "/one" };
    for (const _ of [1, 2]) expect(resolveForge(github.cwd, { runner, env }).ok).toBe(true);
    expect(lookups()).toBe(1);
    expect(
      resolveForge(github.cwd, {
        runner,
        env: { ...env, GH_CONFIG_DIR: "/two" },
      }).ok,
    ).toBe(true);
    expect(lookups()).toBe(2);
  });

  test("a workspace provider that disagrees with the push remote is blocked (D16)", () => {
    const repo = repoFor("github");
    writeWorkspace(repo, { provider: "gitlab" });
    const resolved = resolveForge(repo.cwd, { runner: replayRunner({}) });
    expect(resolved).toMatchObject({ ok: false, code: "blocked" });
    expect(!resolved.ok && resolved.error).toStartWith("forge_mismatch:");
    expect(!resolved.ok && resolved.unblock).toContain('"vcs": {"provider": "github"}');
    expect(!resolved.ok && resolved.unblock).not.toContain("workit-github-override");
  });

  test("a gh auth token that times out or errors is unavailable (exit 5), not a missing login (M1)", () => {
    const github = repoFor("github");
    writeWorkspace(github, { provider: "github", account: "octo" });
    const key = "CLI auth token --hostname github.com --user octo";
    const timedOut = resolveForge(github.cwd, {
      runner: replayRunner({
        ...githubRoutes(),
        [key]: {
          status: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          missing: false,
        },
      }),
    });
    expect(timedOut).toMatchObject({ ok: false, code: "unavailable" });
    expect(!timedOut.ok && timedOut.error).toStartWith("gh auth token timed out after 20000 ms");
    expect(!timedOut.ok && timedOut.unblock).not.toContain("auth login");
    const broken = resolveForge(github.cwd, {
      runner: replayRunner({
        ...githubRoutes(),
        [key]: replyError("error connecting to github.com"),
      }),
    });
    expect(broken).toMatchObject({
      ok: false,
      code: "unavailable",
      error: "gh auth token failed (network): error connecting to github.com",
    });
  });

  test("a resolution deadline bounds the token lookup and every probe after it (M2)", () => {
    const github = repoFor("github");
    writeWorkspace(github, { provider: "github", account: "octo" });
    let clock = 0;
    const offered: number[] = [];
    const resolved = resolveForge(github.cwd, {
      now: () => clock,
      deadline: 4_000,
      runner: (_bin, args, options) => {
        offered.push(options.timeoutMs);
        clock += Math.min(options.timeoutMs, 3_000);
        return args[0] === "auth"
          ? {
              status: 0,
              stdout: "gho_t\n",
              stderr: "",
              timedOut: false,
              missing: false,
            }
          : {
              status: null,
              stdout: "",
              stderr: "",
              timedOut: true,
              missing: false,
            };
      },
    });
    expect(offered).toEqual([4_000, 1_000]);
    expect(resolved).toMatchObject({
      ok: false,
      code: "unavailable",
      error: "gh api repository o/r timed out after 1000 ms",
    });
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
    expect(run("gh: Not Found (HTTP 404)")).toMatchObject({
      code: "not_found",
    });
    // Transport trouble is retryable: unavailable (exit 5), not failed (m9).
    expect(run("error connecting to api.github.com")).toMatchObject({
      code: "unavailable",
    });
    expect(run("gh: HTTP 502: Bad Gateway")).toMatchObject({
      code: "unavailable",
    });
    expect(run("gh: Validation Failed (HTTP 422)")).toMatchObject({
      code: "failed",
    });
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
        const runner = systemRunner("github", "ghe.example.com", {
          ...process.env,
          PATH: bin,
        });
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
