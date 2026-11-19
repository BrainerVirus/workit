// `workit check` and the short-first lease (#884): a configured check may
// declare `heavy: true | "io"` (anything else is a config error naming those),
// a network-bound check (`heavy: "io"`, ad-hoc `--io`) and a check whose last
// measured run is under 30 s run without a slot while every slot is held, and
// a check never measured queues as before.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { loadCheckConfig } from "@/packages/workit-core/src/check-config";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A repo with temp state, config and HOME; `held` slots are taken by this (live) test process. */
const setup = (checks: Record<string, unknown>, held = 0) => {
  const root = temp("wk-short-first-");
  spawnSync("git", ["init", "-q", "-b", "feature/short-first"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(path.join(root, ".workit", "checks.json"), JSON.stringify({ checks }));
  const state = temp("wk-short-first-state-");
  const config = temp("wk-short-first-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, pressure: false } }],
    }),
  );
  const leases = path.join(state, "leases");
  mkdirSync(leases, { recursive: true });
  for (let slot = 0; slot < held; slot += 1)
    writeFileSync(
      path.join(leases, `slot-${slot}.json`),
      JSON.stringify({
        id: `00000000-0000-4000-8000-00000000000${slot}`,
        pid: process.pid,
        processStart: null,
        bootId: null,
        check: "test",
        cwd: root,
        session: "s-other",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        scope: null,
        // A full suite measured at 1 MiB: the memory budget has room left.
        bytes: 1024 ** 2,
      }),
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp("wk-short-first-home-"),
    WORKIT_SESSION_ID: "s-short-first",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env, leases };
};

const check = async (root: string, env: NodeJS.ProcessEnv, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(["check", "--json", ...argv], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  const envelope = JSON.parse(stdout) as { error?: string; data?: Record<string, any> };
  return { code, stderr, envelope, data: envelope.data ?? {} };
};

const quick = [BUN, "-e", "0"];

test("Given a check entry with its own heavy, Then true and io are read; any other value or key is a config error naming what is allowed", () => {
  const { root } = setup({
    test: { command: quick, heavy: true },
    bench: { command: "bun run bench", heavy: "io" },
    lint: "bun run lint",
  });
  const config = loadCheckConfig(root);
  expect(config.error).toBeNull();
  expect(config.checks.map(({ name, argv, heavy }) => ({ name, argv, heavy }))).toEqual([
    { name: "test", argv: quick, heavy: true },
    { name: "bench", argv: ["bun", "run", "bench"], heavy: "io" },
    { name: "lint", argv: ["bun", "run", "lint"], heavy: undefined },
  ]);
  for (const [entry, message] of [
    [{ command: quick, heavy: "network" }, 'heavy must be true or "io", not "network"'],
    [{ command: quick, heavy: false }, 'heavy must be true or "io", not false'],
    [{ command: quick, weight: 2 }, '"weight" is not a check setting (use command or heavy)'],
    [{ heavy: "io" }, 'needs "command"'],
  ] as const) {
    const bad = setup({ bench: entry });
    expect(loadCheckConfig(bad.root).error).toContain(`check "bench": ${message}`);
  }
});

test("Given an unknown heavy value, When the check runs, Then it fails as an invalid config naming the allowed values", async () => {
  const { root, env } = setup({ bench: { command: quick, heavy: "cpu" } });
  const run = await check(root, env, ["bench"]);
  expect(run.code).toBe(2);
  expect(run.envelope.error).toContain('heavy must be true or "io", not "cpu"');
});

test('Given every slot held, When a check with heavy "io" runs, Then it starts without a slot and says it is network-bound', async () => {
  const { root, env, leases } = setup({ bench: { command: quick, heavy: "io" } }, 1);
  const run = await check(root, env, ["bench", "--no-wait"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.data.lease).toMatchObject({ slot: null, admitted: "io", waitedMs: 0 });
  expect(run.stderr).toContain("running without a heavy-check slot: a network-bound check (io)");
  // Released when the check ended.
  expect(readdirSync(path.join(leases, "admitted"))).toEqual([]);
});

test("Given every slot held, When an ad-hoc run passes --io, Then it starts without a slot; without it, an ad-hoc run takes no lease", async () => {
  const { root, env } = setup({ test: quick }, 1);
  const run = await check(root, env, ["--io", "--no-wait", "--name", "bench", "--", ...quick]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.data.lease).toMatchObject({ slot: null, admitted: "io" });
  const usage = await check(root, env, ["--io", "--no-lease", "--reason", "x", "--", ...quick]);
  expect(usage.code).toBe(2);
  expect(usage.envelope.error).toContain("--io goes without --no-lease");
});

test("Given every slot held, When a heavy check whose last run took 8 s runs, Then it starts without a slot; never measured, it waits as before", async () => {
  const { root, env } = setup({ unit: { command: quick, heavy: true } }, 1);
  const busy = await check(root, env, ["unit", "--no-wait"]);
  expect(busy.code, busy.stderr).toBe(4);
  expect(busy.envelope.error).toContain("the heavy-check lease is busy");
  expect(
    appendObserved(root, {
      type: "check",
      actor: actorFromEnv(env),
      name: "unit",
      result: "passed",
      exitCode: 0,
      timedOut: false,
      durationMs: 8_000,
    }).ok,
  ).toBe(true);
  const run = await check(root, env, ["unit", "--no-wait"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.data.lease).toMatchObject({ slot: null, admitted: "short" });
  expect(run.stderr).toContain("its last measured run took 8s, under 30s");
});
