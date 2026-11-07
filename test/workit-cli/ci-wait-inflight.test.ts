import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { localLockHost, processStartOf } from "@/packages/workit-core/src/core/store-lock";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
} from "@/test/shared/helpers/forge-replay";

// Retro 2026-11-07 R4: a lead whose `ci wait` was moved to the background
// started a second one for the same PR and head. The second reports the live
// one instead of polling again.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-ci-wait-inflight-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
const sleepers: ChildProcess[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const child of sleepers.splice(0)) child.kill();
});

const STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

const setup = () => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "graphql find": fixture("github/find-pr.json"),
      [STATUS]: fixture("github/pr-passing.json"),
    },
    repo.subs,
  );
  let clock = 0;
  Object.assign(forgeDeps, {
    runner,
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
  });
  const polls = () => runner.calls.filter((call) => call.op === "status").length;
  return { repo, polls };
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: process.env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const markerFile = (repo: ForgeRepo) =>
  path.join(repo.cwd, ".git", "workit", "ci-waits", "pr-12.json");

/** A first `ci wait` on PR 12, held by a live process unless `dead`. */
const firstWait = (repo: ForgeRepo, options: { head?: string | null; dead?: boolean } = {}) => {
  let pid = 2 ** 22 + 12_345;
  if (!options.dead) {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    sleepers.push(child);
    pid = child.pid!;
  }
  mkdirSync(path.dirname(markerFile(repo)), { recursive: true });
  writeFileSync(
    markerFile(repo),
    JSON.stringify({
      pr: 12,
      head: options.head === undefined ? repo.head : options.head,
      pid,
      start: options.dead ? null : processStartOf(pid),
      host: localLockHost(),
      startedAt: Date.now(),
      deadline: Date.now() + 600_000,
    }),
  );
  return pid;
};

test("Given a live ci wait for PR 12 at head H, When a second ci wait for the same PR and head starts, Then it reports the first and never polls", async () => {
  const { repo, polls } = setup();
  const pid = firstWait(repo);
  const second = await run(["ci", "wait", "--pr", "12", "--timeout", "2m", "--json"], repo.cwd);
  expect(second.code).toBe(4);
  expect(second.json()).toMatchObject({
    code: "busy",
    data: { state: "in_flight", pr: 12, waiter: { pid, head: repo.head } },
  });
  expect(second.json().error).toContain("already running");
  expect(polls()).toBe(0);
  // The first wait's marker is left alone.
  expect(JSON.parse(readFileSync(markerFile(repo), "utf8")).pid).toBe(pid);
  // One that has not polled yet (no head recorded) is reported too.
  firstWait(repo, { head: null });
  const early = await run(["ci", "wait", "--pr", "12", "--timeout", "2m", "--json"], repo.cwd);
  expect(early.code).toBe(4);
  expect(polls()).toBe(0);
});

test("Given a first wait whose process died or that waits on another head, When ci wait starts, Then it polls as before and removes its own marker when done", async () => {
  const { repo, polls } = setup();
  firstWait(repo, { dead: true });
  const afterDead = await run(["ci", "wait", "--pr", "12", "--timeout", "2m", "--json"], repo.cwd);
  expect(afterDead.code, afterDead.stdout).toBe(0);
  expect(polls()).toBe(1);
  expect(existsSync(markerFile(repo))).toBe(false);
  firstWait(repo, { head: "0123456789abcdef0123456789abcdef01234567" });
  const otherHead = await run(["ci", "wait", "--pr", "12", "--timeout", "2m", "--json"], repo.cwd);
  expect(otherHead.code, otherHead.stdout).toBe(0);
  expect(polls()).toBe(2);
});
