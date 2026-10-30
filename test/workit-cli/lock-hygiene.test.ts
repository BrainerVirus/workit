// Issue #608: `workit lock status` marks a stuck holder, `workit lock reap`
// frees it and records it in the ledger, `workit lock cancel` ends a queued
// check cleanly, and a check that gives up says whom it queued behind.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = () => {
  const root = temp("wk-hygiene-");
  spawnSync("git", ["init", "-q", "-b", "feature/hygiene"], { cwd: root });
  const state = temp("wk-hygiene-state-");
  const config = temp("wk-hygiene-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: { scope: false } }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-mine",
    WORKFLOW_WORKSPACE_ROOT: "",
    WORKFLOW_TOOLKIT_STATE: state,
    WORKFLOW_TOOLKIT_CONFIG_DIR: config,
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

const holdLease = (leases: string, startedAgoMs: number) => {
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000f1",
      pid: process.pid,
      processStart: null,
      bootId: null,
      check: "test",
      cwd: "/elsewhere/json-envelope",
      session: "s-other",
      startedAt: new Date(Date.now() - startedAgoMs).toISOString(),
      scope: null,
    }),
  );
};

test("Given a holder past the 15 min max hold, When workit lock status runs, Then it is marked stuck? with its age; and lock reap frees the slot and records the pid, session and command in the ledger", async () => {
  const { root, env, leases } = setup();
  holdLease(leases, 28 * 60_000);
  const status = await run(root, ["lock", "status"], env);
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("test, pid");
  expect(status.stdout).toContain("28m, /elsewhere/json-envelope, stuck? (held 28m");
  expect(status.stdout).toContain("past its 15m limit");
  expect(status.stdout).toContain("workit lock reap");
  const json = await run(root, ["lock", "status", "--json"], env);
  expect(json.json().data.slots[0].stuck).toContain("past its 15m limit");

  const reaped = await run(root, ["lock", "reap", "--json"], env);
  expect(reaped.code, reaped.stderr).toBe(0);
  const [item] = reaped.json().data.reaped;
  expect(item).toMatchObject({ slot: 0, pid: process.pid, session: "s-other", check: "test" });
  expect(existsSync(path.join(leases, "slot-0.json"))).toBe(false);
  const rows = readLedger(root);
  if (!rows.ok) throw new Error(rows.error);
  expect(rows.value.rows.at(-1)).toMatchObject({
    id: item.ledgerRowId,
    type: "lease.reaped",
    observer: "workit_cli",
    by: "lock reap",
    pid: process.pid,
    session: "s-other",
    check: "test",
  });
  const again = await run(root, ["lock", "reap"], env);
  expect(again.stdout).toContain("no stuck holder");
});

test("Given a fresh holder, When lock reap runs, Then nothing is freed", async () => {
  const { root, env, leases } = setup();
  holdLease(leases, 60_000);
  const reaped = await run(root, ["lock", "reap", "--json"], env);
  expect(reaped.json().data.reaped).toEqual([]);
  expect(existsSync(path.join(leases, "slot-0.json"))).toBe(true);
});

test("Given my queued heavy check, When workit lock cancel names my session, Then it leaves the queue and the check exits non-zero saying it was cancelled", async () => {
  const { root, env, leases } = setup();
  holdLease(leases, 60_000);
  const waiting = run(root, ["check", "--heavy", "--json", "--", BUN, "-e", "0"], {
    ...env,
    WORKIT_SESSION_ID: "s-waiter",
  });
  const queue = path.join(leases, "queue");
  const deadline = Date.now() + 5_000;
  while (!(existsSync(queue) && readdirSync(queue).some((name) => name.endsWith(".json")))) {
    if (Date.now() > deadline) throw new Error("the check never queued");
    await sleep(10);
  }
  const cancelled = await run(root, ["lock", "cancel", "s-waiter", "--json"], env);
  expect(cancelled.code).toBe(0);
  expect(cancelled.json().data.cancelled).toEqual([
    expect.objectContaining({ session: "s-waiter", how: "marker" }),
  ]);
  const result = await waiting;
  expect(result.code).toBe(4);
  expect(result.json()).toMatchObject({
    ok: false,
    data: { lease: { cancelled: true, by: "workit lock cancel s-waiter" } },
  });
  expect(result.json().error).toContain("cancelled while queued");
  expect(readdirSync(queue)).toEqual([]);
  const none = await run(root, ["lock", "cancel", "s-waiter"], env);
  expect(none.stdout).toContain("no queued waiter matches s-waiter");
}, 20_000);

test("Given a check that waits past its budget, When it gives up, Then its output and --json say whom it queued behind and for how long", async () => {
  const { root, env, leases } = setup();
  holdLease(leases, 3 * 60_000);
  const result = await run(root, ["check", "--heavy", "--wait", "1", "--json", "--", BUN], env);
  expect(result.code).toBe(4);
  const envelope = result.json();
  expect(envelope.error).toContain("queued behind test, pid");
  expect(envelope.error).toContain("session s-other, 3m");
  expect(envelope.data.lease.queuedBehind).toMatch(
    /^queued behind test, pid \d+, session s-other, 3m( \d+s)?, \/elsewhere\/json-envelope$/u,
  );
}, 20_000);
