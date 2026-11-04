// The heavy-check lease from `workit check`'s side (#645, #326): --timeout
// bounds the whole check, the lease wait included; a configured slot count
// lets that many heavy checks run at once; the targeted `--name unit -- bun
// test <file>` lane never takes or waits for the lease; and a waiter names its
// place, the holder and an estimated wait from the ledger's measured runs.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const sleeper = (ms: number) => [BUN, "-e", `setTimeout(() => {}, ${ms})`];

/** A repo with a temp state and config dir; `held` slots are taken by this (live) test process. */
const setup = (
  options: {
    resources?: Record<string, unknown>;
    held?: number;
    checks?: Record<string, unknown>;
  } = {},
) => {
  const root = temp("wk-lanes-");
  spawnSync("git", ["init", "-q", "-b", "feature/lanes"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({ checks: options.checks ?? { test: [BUN, "-e", "0"] } }),
  );
  const state = temp("wk-lanes-state-");
  const config = temp("wk-lanes-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, ...options.resources } }],
    }),
  );
  const leases = path.join(state, "leases");
  mkdirSync(leases, { recursive: true });
  for (let slot = 0; slot < (options.held ?? 0); slot += 1)
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
      }),
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-lanes",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

const check = async (root: string, env: NodeJS.ProcessEnv, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const started = Date.now();
  const code = await main(["check", "--json", ...argv], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  const envelope = JSON.parse(stdout) as { error?: string; data?: Record<string, any> };
  return { code, stderr, envelope, data: envelope.data ?? {}, ms: Date.now() - started };
};

test("Given a held lease, When a heavy check runs with --timeout 1, Then it gives up within its own timeout, not the 20 s configured wait (#645)", async () => {
  const { root, env } = setup({ resources: { wait: 20 }, held: 1 });
  const run = await check(root, env, ["test", "--timeout", "1"]);
  expect(run.code, run.stderr).toBe(4);
  expect(run.ms).toBeLessThan(6_000);
  expect(run.envelope.error).toContain("--timeout");
  expect(run.stderr).toContain("waiting up to 1s");
}, 30_000);

test("Given N parallel heavy checks each with --timeout 4 and one slot, When they run, Then none outlives its own timeout (#645)", async () => {
  const names = ["c1", "c2", "c3", "c4"];
  const { root, env } = setup({
    resources: { slots: 1, heavy: names },
    checks: Object.fromEntries(names.map((name) => [name, sleeper(2500)])),
  });
  const runs = await Promise.all(
    names.map(
      (name) =>
        new Promise<{ name: string; code: number | null; ms: number; stderr: string }>(
          (resolve) => {
            const began = Date.now();
            const child = spawn(BUN, [MAIN, "check", name, "--timeout", "4", "--cwd", root], {
              env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
            child.stdout.resume();
            const killer = setTimeout(() => child.kill("SIGKILL"), 40_000);
            child.on("close", (code) => {
              clearTimeout(killer);
              resolve({ name, code, ms: Date.now() - began, stderr });
            });
          },
        ),
    ),
  );
  // Serially the four take over 10 s; each is bounded by its 4 s timeout plus start-up.
  for (const run of runs) expect(run.ms, `${run.name}: ${run.stderr}`).toBeLessThan(9_000);
  expect(runs.filter((run) => run.code === 0).length).toBeGreaterThanOrEqual(1);
  for (const run of runs.filter((item) => item.code !== 0)) {
    expect(run.code, run.stderr).toBe(4);
    expect(run.stderr).toContain("--timeout");
  }
}, 60_000);

test("Given resources.slots 2 and one slot held, When a heavy check runs, Then it takes the second slot at once; with both held it waits", async () => {
  const one = setup({ resources: { slots: 2 }, held: 1 });
  const run = await check(one.root, one.env, ["test", "--no-wait"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.data.lease).toMatchObject({ slot: 1, waitedMs: 0 });
  const both = setup({ resources: { slots: 2 }, held: 2 });
  const busy = await check(both.root, both.env, ["test", "--no-wait"]);
  expect(busy.code).toBe(4);
  expect(busy.envelope.error).toContain("busy");
});

test("Given the default slot count and one slot held, When a heavy check runs, Then it waits as before", async () => {
  const { root, env } = setup({ held: 1 });
  const busy = await check(root, env, ["test", "--wait", "1"]);
  expect(busy.code).toBe(4);
  expect(busy.stderr).toContain("waiting for the heavy-check lease (1 slot)");
}, 20_000);

test("Given every slot held and unit listed heavy, When `workit check --name unit -- bun test <file>` runs, Then it runs at once and never takes or waits for the lease", async () => {
  const { root, env } = setup({ resources: { heavy: ["test", "unit"], wait: 20 }, held: 1 });
  writeFileSync(
    path.join(root, "one.test.ts"),
    'import { expect, test } from "bun:test";\ntest("one", () => expect(1).toBe(1));\n',
  );
  const run = await check(root, env, ["--name", "unit", "--", BUN, "test", "./one.test.ts"]);
  expect(run.code, run.stderr).toBe(0);
  expect(run.data.lease).toBeNull();
  expect(run.stderr).not.toContain("heavy-check lease");
  expect(run.ms).toBeLessThan(15_000);
}, 30_000);

test("Given a holder whose check last ran 10 min, When a heavy check queues, Then it names its position, the holder with its elapsed time and an estimated wait", async () => {
  const { root, env } = setup({ held: 1 });
  const row = appendObserved(root, {
    type: "check",
    actor: actorFromEnv(env),
    name: "test",
    result: "passed",
    exitCode: 0,
    timedOut: false,
    durationMs: 600_000,
  });
  expect(row.ok).toBe(true);
  const run = await check(root, env, ["test", "--wait", "1"]);
  expect(run.code).toBe(4);
  expect(run.stderr).toContain("queued at position 1");
  expect(run.stderr).toMatch(/held by test, pid \d+, session s-other, 1m( \ds)?,/u);
  // 10 min measured, about 1 min elapsed: about 9 min left.
  expect(run.stderr).toMatch(/estimated wait ~(8|9)m/u);
}, 20_000);

test("Given a holder whose check was never measured, When a heavy check queues, Then it says there is no estimate yet and why", async () => {
  const { root, env } = setup({ held: 1 });
  const run = await check(root, env, ["test", "--wait", "1"]);
  expect(run.code).toBe(4);
  expect(run.stderr).toContain("no wait estimate yet (no measured run of test)");
}, 20_000);
