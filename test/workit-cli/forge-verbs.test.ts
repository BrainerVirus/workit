import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  replyError,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// S10 CLI verbs over recorded GitHub fixtures: `pr status`, `ci wait` (with a
// virtual clock), `ci rerun`, and their envelope codes and exit codes.

// Test repos fetch from a local bare remote; slow on Windows runners.
setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
let clock = 0;
let delays: number[] = [];
beforeAll(() => {
  configHome = useConfigHome("wk-forge-cli-config-");
  configDir = configHome.configDir;
});
afterAll(() => {
  configHome.restore();
});

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  rmSync(path.join(configDir, "workspaces.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

const setup = (status: Reply = fixture("github/pr-failing-thread.json")) => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "CLI auth token --hostname github.com --user someone": replyError(
        "no oauth token found for github.com account someone",
      ),
      "graphql find": fixture("github/find-pr.json"),
      [STATUS]: status,
      "GET repos/o/r/actions/jobs/102/logs": fixture("github/job-log.txt"),
      "POST repos/o/r/actions/runs/1/rerun-failed-jobs": "",
    },
    repo.subs,
  );
  clock = 0;
  delays = [];
  Object.assign(forgeDeps, {
    runner,
    now: () => clock,
    sleep: async (ms: number) => {
      delays.push(ms);
      clock += ms;
    },
  });
  return { repo, runner };
};

const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("pr status --json returns the status document in the shared envelope", async () => {
  const { repo } = setup();
  const result = await run(["pr", "status", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  const envelope = result.json();
  expect(envelope).toMatchObject({
    ok: true,
    code: "ok",
    data: {
      forge: "github",
      repo: "o/r",
      number: 12,
      behindBase: { behind: 3 },
      checks: { state: "failing" },
      next: "RESOLVE_THREADS",
    },
  });
  expect(envelope.data.checks.failing[0].logTail.length).toBeGreaterThan(0);

  const human = await run(["pr", "status", "--log-lines", "3"], repo.cwd);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("PR #12 open: feature/x -> main");
  expect(human.stdout).toContain("behind main: 3, ahead 1");
  expect(human.stdout).toContain("x CI / test (ubuntu-latest) (failure)");
  expect(human.stdout).toContain("##[error]Process completed with exit code 1.");
  expect(human.stdout).toContain("- src/a.ts:10 @reviewer: Please handle the empty case");
  expect(human.stdout).toEndWith("next: RESOLVE_THREADS\n");
});

test("pr usage errors exit 2", async () => {
  const { repo } = setup();
  expect((await run(["pr", "status", "--pr", "abc", "--json"], repo.cwd)).json()).toMatchObject({
    ok: false,
    code: "invalid_input",
    error: "--pr must be a positive integer",
  });
  expect((await run(["pr", "status", "--bogus"], repo.cwd)).code).toBe(2);
  expect((await run(["pr"], repo.cwd)).code).toBe(2);
});

test("ci wait: a flaky check that turns green exits 0 after a backoff poll", async () => {
  let polls = 0;
  const { repo } = setup(() =>
    fixture(polls++ === 0 ? "github/pr-pending.json" : "github/pr-passing.json"),
  );
  const result = await run(["ci", "wait", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json()).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      reason: "checks_passing",
      polls: 2,
      status: { checks: { state: "passing" } },
    },
  });
  expect(delays).toEqual([30_000]);
});

test("ci wait: failing checks exit 1 with the failing log tail in the final payload", async () => {
  const { repo } = setup();
  const result = await run(["ci", "wait", "--pr", "12", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  const envelope = result.json();
  expect(envelope).toMatchObject({
    ok: false,
    code: "failed",
    error: "CI failed: CI / test (ubuntu-latest)",
    data: { state: "failed", polls: 1 },
  });
  expect(envelope.data.status.checks.failing[0].logTail.at(-1)).toBe(
    "##[error]Process completed with exit code 1.",
  );
  expect(envelope.unblock).toContain("workit ci rerun --failed --reason flake");
});

test("ci wait: checks still pending at the timeout exit 4 (pending) with deterministic polls", async () => {
  const { repo } = setup(fixture("github/pr-pending.json"));
  const result = await run(
    ["ci", "wait", "--timeout", "2m", "--interval", "30s", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(4);
  expect(result.json()).toMatchObject({
    ok: false,
    code: "pending",
    data: { state: "waiting", reason: "checks_pending", polls: 4, elapsedMs: 120_000 },
    unblock: "workit ci wait --pr 12",
  });
  expect(delays).toEqual([30_000, 45_000, 45_000]);
  const usage = await run(["ci", "wait", "--interval", "0s"], repo.cwd);
  expect(usage.code).toBe(2);
});

test("ci wait: a closed PR is blocked (exit 3), never ready; --pr with --branch is a usage error", async () => {
  const closed = JSON.parse(fixture("github/pr-passing.json"));
  closed.data.repository.pullRequest.state = "CLOSED";
  const { repo } = setup(JSON.stringify(closed));
  const result = await run(["ci", "wait", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({
    code: "blocked",
    data: { state: "blocked", reason: "pr_closed" },
  });
  expect((await run(["ci", "wait", "--pr", "12", "--branch", "x"], repo.cwd)).code).toBe(2);
  expect(
    (await run(["ci", "rerun", "--pr", "12", "--branch", "x", "--reason", "flake"], repo.cwd)).code,
  ).toBe(2);
});

test("ci wait: one hard deadline covers every call, including the final status build", async () => {
  let statusCalls = 0;
  const { repo, runner } = setup(() => {
    statusCalls += 1;
    clock += 70_000; // a slow API answer that overruns the 1m budget
    return fixture("github/pr-pending.json");
  });
  const result = await run(["ci", "wait", "--timeout", "1m", "--json"], repo.cwd);
  expect(result.code).toBe(4);
  expect(result.json().data).toMatchObject({ state: "waiting", polls: 1 });
  expect(statusCalls).toBe(1);
  const afterPoll = runner.calls.findIndex((call) => call.op === "status");
  // Nothing after the poll that overran: no log tails, no further API reads.
  expect(runner.calls.slice(afterPoll + 1).filter((call) => call.method !== "CLI")).toEqual([]);
});

test("ci rerun: once per head, then blocked (exit 3) unless --force", async () => {
  const { repo, runner } = setup();
  const missing = await run(["ci", "rerun", "--failed", "--json"], repo.cwd);
  expect(missing.code).toBe(2);
  const first = await run(["ci", "rerun", "--failed", "--reason", "flake", "--json"], repo.cwd);
  expect(first.code).toBe(0);
  expect(first.json().data).toMatchObject({
    pr: 12,
    reason: "flake",
    rerun: [{ name: "CI / test (ubuntu-latest)", runId: 1, jobId: 102 }],
  });
  const second = await run(["ci", "rerun", "--reason", "flake", "--json"], repo.cwd);
  expect(second.code).toBe(3);
  expect(second.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(second.json().unblock).toContain("--force");
  const forced = await run(["ci", "rerun", "--reason", "flake", "--force"], repo.cwd);
  expect(forced.code).toBe(0);
  expect(forced.stdout).toContain("(flake, forced): CI / test (ubuntu-latest)");
  expect(runner.calls.filter((call) => call.method === "POST")).toHaveLength(2);
});

test("ci rerun: an explicit rerun=false grant blocks it with the grant command and posts nothing", async () => {
  const { repo, runner } = setup();
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github" },
          autonomy: { rerun: false },
        },
      ],
    }),
  );
  const result = await run(["ci", "rerun", "--failed", "--reason", "flake", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({
    ok: false,
    code: "blocked",
    error: 'grant_required: rerun is not granted for workspace "w"',
    data: { reason: "grant_required" },
  });
  expect(result.json().unblock).toContain("workit grant set w rerun=true");
  expect(runner.calls.some((call) => call.method === "POST")).toBe(false);
});

test("an identity mismatch blocks every forge verb with exit 3", async () => {
  const { repo, runner } = setup();
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "someone" },
        },
      ],
    }),
  );
  for (const argv of [
    ["pr", "status"],
    ["ci", "wait"],
    ["ci", "rerun", "--reason", "flake"],
  ]) {
    const result = await run([...argv, "--json"], repo.cwd);
    expect(result.code, argv.join(" ")).toBe(3);
    expect(result.json().unblock).toStartWith("gh auth login --hostname github.com");
    expect(result.stdout).not.toContain("auth switch");
  }
  expect(runner.calls.some((call) => call.method === "POST")).toBe(false);
});

test("ci rerun is blocked when the account cannot be verified (403 on /user); reads pass with a note", async () => {
  const { repo, runner } = setup();
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
        },
      ],
    }),
  );
  Object.assign(forgeDeps, {
    runner: (
      bin: "gh" | "glab",
      args: readonly string[],
      options: { timeoutMs: number; token?: string },
    ) => {
      if (args.join(" ") === "auth token --hostname github.com --user octo")
        return { status: 0, stdout: "ghs_appToken\n", stderr: "", timedOut: false, missing: false };
      if (args.join(" ") === "api user")
        return replyError("gh: Resource not accessible by integration (HTTP 403)");
      return runner(bin, args, options);
    },
  });
  const read = await run(["pr", "status", "--json", "--log-lines", "0"], repo.cwd);
  expect(read.code).toBe(0);
  expect(read.json().data.identity).toMatchObject({
    login: null,
    note: expect.stringContaining("not checked"),
  });
  const rerun = await run(["ci", "rerun", "--reason", "flake", "--json"], repo.cwd);
  expect(rerun.code).toBe(3);
  expect(rerun.json().error).toStartWith("identity_unverified:");
  expect(runner.calls.some((call) => call.method === "POST")).toBe(false);
});

test("Given gh missing, Then exit 5 with an install hint", async () => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const empty = mkdtempSync(path.join(os.tmpdir(), "wk-no-gh-"));
  try {
    const result = await run(["pr", "status", "--json"], repo.cwd, {
      ...process.env,
      PATH: empty,
      Path: empty,
    });
    expect(result.code).toBe(5);
    expect(result.json()).toEqual({
      ok: false,
      code: "unavailable",
      data: {},
      error: "gh is not installed",
      unblock: "install the GitHub CLI (https://cli.github.com) and run: gh auth login",
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
