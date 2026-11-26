// Issue #926: a check running without a slot (short or io) that hangs shows
// `stuck?` under `admitted (no slot):` in `workit lock status`, and
// `workit lock reap` frees its memory and records it like a stuck slot.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { readLedger } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const setup = () => {
  const root = temp("wk-slot-free-lock-");
  spawnSync("git", ["init", "-q", "-b", "feature/slot-free"], { cwd: root });
  const state = temp("wk-slot-free-lock-state-");
  const config = temp("wk-slot-free-lock-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "here", glob: "**", resources: { scope: false, pressure: false } }],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-mine",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  return { root, env, leases: path.join(state, "leases") };
};

const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** An io check admitted without a slot `agoMs` ago, held by this (live) process and silent since. */
const hungIoCheck = (leases: string, agoMs: number): string => {
  const at = new Date(Date.now() - agoMs).toISOString();
  const dir = path.join(leases, "admitted");
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${String(Date.parse(at)).padStart(15, "0")}-00000000-0000-4000-8000-0000000000a1.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000a1",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "bench",
      cwd: "/elsewhere/bench",
      session: "s-other",
      startedAt: at,
      heartbeatAt: at,
      scope: null,
      kind: "io",
      units: 0,
      bytes: 1024 ** 3,
    }),
  );
  return file;
};

test("Given a slot-free io check silent past the 15 min max hold, When workit lock status runs, Then it is marked stuck? under admitted; and lock reap frees it and records it in the ledger", async () => {
  const { root, env, leases } = setup();
  const file = hungIoCheck(leases, 28 * 60_000);
  const status = await run(root, ["lock", "status"], env);
  expect(status.code, status.stderr).toBe(0);
  expect(status.stdout).toContain("admitted (no slot): 1");
  expect(status.stdout).toContain("/elsewhere/bench, stuck? (held 28m");
  expect(status.stdout).toContain(
    "a stuck? slot-free check's memory is freed by: workit lock reap",
  );
  const json = await run(root, ["lock", "status", "--json"], env);
  expect(json.json().data.admitted[0]).toMatchObject({ kind: "io", check: "bench" });
  expect(json.json().data.admitted[0].stuck).toContain("past its 15m limit");

  const reaped = await run(root, ["lock", "reap", "--json"], env);
  expect(reaped.code, reaped.stderr).toBe(0);
  const [item] = reaped.json().data.reaped;
  expect(item).toMatchObject({ slot: null, admitted: "io", pid: process.pid, check: "bench" });
  expect(existsSync(file)).toBe(false);
  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows.at(-1)).toMatchObject({
    id: item.ledgerRowId,
    type: "lease.reaped",
    by: "lock reap",
    check: "bench",
  });
  const again = await run(root, ["lock", "reap"], env);
  expect(again.stdout).toContain("no stuck holder");
});

test("Given a slot-free io check stuck, When lock reap runs without --json, Then it names the slot-free check it freed", async () => {
  const { root, env, leases } = setup();
  hungIoCheck(leases, 20 * 60_000);
  const reaped = await run(root, ["lock", "reap"], env);
  expect(reaped.code, reaped.stderr).toBe(0);
  expect(reaped.stdout).toContain("workit: reaped a slot-free io check (held 20m");
  expect(reaped.stdout).toContain("pid " + process.pid + " still runs outside the lease");
});

test("Given a fresh slot-free io check, When lock status and reap run, Then it is neither stuck nor freed", async () => {
  const { root, env, leases } = setup();
  const file = hungIoCheck(leases, 60_000);
  const status = await run(root, ["lock", "status"], env);
  expect(status.stdout).not.toContain("stuck?");
  const reaped = await run(root, ["lock", "reap"], env);
  expect(reaped.stdout).toContain("no stuck holder");
  expect(existsSync(file)).toBe(true);
});
