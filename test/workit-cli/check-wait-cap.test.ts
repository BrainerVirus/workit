// The lease wait (#508, replacing #325's 100 s host cap): a queued check
// waits its turn, `--wait <dur>` or `resources.wait` (default 30 min), inside
// a Claude Code or OpenCode shell too; `--no-wait` answers at once; light
// checks never wait.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { readLedger } from "@/packages/workit-core/src/ledger";

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

/** A repo whose lease is held by this process, with a configured wait of `waitS`. */
const setup = (waitS: number) => {
  const root = temp("wk-wait-cap-");
  spawnSync("git", ["init", "-q", "-b", "feature/wait"], { cwd: root });
  mkdirSync(path.join(root, ".workit"));
  writeFileSync(
    path.join(root, ".workit", "checks.json"),
    JSON.stringify({
      checks: { typecheck: [BUN, "-e", "0"], test: [BUN, "-e", "0"] },
    }),
  );
  const state = temp("wk-wait-cap-state-");
  const config = temp("wk-wait-cap-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, wait: waitS } }],
    }),
  );
  const leases = path.join(state, "leases");
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000d1",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "test",
      cwd: "/elsewhere",
      session: "s-other",
      startedAt: new Date().toISOString(),
      scope: null,
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-wait",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env };
};

const heavy = async (root: string, env: NodeJS.ProcessEnv, flags: string[] = []) => {
  let stdout = "";
  const code = await main(["check", "--heavy", ...flags, "--json", "--", BUN, "-e", "0"], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, waitedMs: JSON.parse(stdout).data?.lease?.waitedMs as number };
};

const named = async (root: string, env: NodeJS.ProcessEnv, name: string, flags: string[] = []) => {
  let stdout = "";
  let stderr = "";
  const code = await main(["check", name, ...flags, "--json"], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stderr, data: JSON.parse(stdout).data };
};

test("Given a held lease in a Claude Code or OpenCode shell, When a heavy check waits, Then it waits the configured wait, not a 100 s host cap", async () => {
  for (const marker of ["CLAUDECODE", "OPENCODE"]) {
    const { root, env } = setup(2);
    const started = Date.now();
    const result = await heavy(root, { ...env, [marker]: "1" });
    expect(result.code, marker).toBe(4);
    expect(Date.now() - started, marker).toBeGreaterThanOrEqual(1_800);
  }
}, 20_000);

test("Given a held lease, When a heavy check runs with --wait 1s, Then the duration sets the wait", async () => {
  const { root, env } = setup(30);
  const started = Date.now();
  const result = await heavy(root, env, ["--wait", "1s"]);
  expect(result.code).toBe(4);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 20_000);

test("Given a held lease, When a heavy check runs with --no-wait, Then it exits 4 at once naming the holder", async () => {
  const { root, env } = setup(30);
  let stdout = "";
  const started = Date.now();
  const code = await main(["check", "--heavy", "--no-wait", "--json", "--", BUN, "-e", "0"], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  expect(code).toBe(4);
  expect(Date.now() - started).toBeLessThan(2_000);
  const envelope = JSON.parse(stdout);
  expect(envelope).toMatchObject({ ok: false, code: "busy" });
  expect(envelope.error).toContain("--no-wait");
});

test("Given --wait and --no-wait together, or a junk --wait, Then the usage is refused", async () => {
  const { root, env } = setup(30);
  expect((await heavy(root, env, ["--wait", "1m", "--no-wait"])).code).toBe(2);
  expect((await heavy(root, env, ["--wait", "soon"])).code).toBe(2);
});

test("Given a held lease, When `workit check typecheck` runs, Then it runs at once without the lease (a light check), while `test` queues", async () => {
  const { root, env } = setup(30);
  const started = Date.now();
  const light = await named(root, env, "typecheck");
  expect(light.code, light.stderr).toBe(0);
  expect(light.data.lease).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
  const queued = await named(root, env, "test", ["--wait", "1"]);
  expect(queued.code).toBe(4);
  expect(queued.stderr).toContain("queued at position 1, waiting up to 1s");
}, 20_000);

test("Given no host marker, When a heavy check waits, Then the configured wait applies", async () => {
  const { root, env } = setup(2);
  const started = Date.now();
  const result = await heavy(root, env);
  expect(result.code).toBe(4);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_800);
}, 20_000);

test("Given a slot that frees with less than the run floor left of --timeout, When the heavy check gets it, Then it exits 4 as a wait timeout and never starts the command", async () => {
  // --timeout 8 s: the floor is min(10 s, 2 s) = 2 s; the slot frees about 1 s before the end.
  const { root, env } = setup(30);
  const marker = path.join(root, "ran");
  const slot = path.join(env.WORKIT_STATE_DIR as string, "leases", "slot-0.json");
  const free = setTimeout(() => rmSync(slot, { force: true }), 6_300);
  let stdout = "";
  let stderr = "";
  const code = await main(
    [
      "check",
      "--heavy",
      "--timeout",
      "8",
      "--json",
      "--",
      BUN,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
    ],
    {
      cwd: root,
      env,
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    },
  );
  clearTimeout(free);
  expect(code, stderr).toBe(4);
  const envelope = JSON.parse(stdout);
  expect(envelope).toMatchObject({ ok: false, code: "busy", data: { lease: { starved: true } } });
  expect(envelope.error).toContain("the check did not run");
  expect(existsSync(marker)).toBe(false);
  // The slot it took is released again.
  expect(existsSync(slot)).toBe(false);
}, 20_000);

test("Given a stuck holder auto-reaped only when less than the run floor is left of --timeout, When the heavy check gets its slot, Then it says the lease was reclaimed and records the reap before exiting 4", async () => {
  // --timeout 8 s (floor 2 s); the live holder's 2.5 s max hold makes it auto-reapable
  // (3x the max hold, silent) about 6.3 s in, so the acquire that frees it is starved.
  const { root, env } = setup(30);
  const slot = path.join(env.WORKIT_STATE_DIR as string, "leases", "slot-0.json");
  writeFileSync(
    slot,
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000d2",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "test",
      cwd: "/elsewhere/stuck",
      session: "s-stuck",
      startedAt: new Date(Date.now() - 1_200).toISOString(),
      maxHoldMs: 2_500,
      scope: null,
    }),
  );
  let stdout = "";
  let stderr = "";
  const code = await main(["check", "--heavy", "--timeout", "8", "--json", "--", BUN, "-e", "0"], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  expect(code, stderr).toBe(4);
  expect(JSON.parse(stdout)).toMatchObject({ code: "busy", data: { lease: { starved: true } } });
  expect(stderr).toContain("reclaimed a stuck heavy-check lease");
  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows.filter((row) => row.type === "lease.reaped")).toEqual([
    expect.objectContaining({ by: "auto", pid: process.pid, session: "s-stuck", check: "test" }),
  ]);
}, 20_000);
