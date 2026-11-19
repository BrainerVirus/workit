// `workit lock status` and the short-first queue (#884): waiters are listed in
// serving order, shortest measured run first; each shows its own check's last
// measured run, or "no measured run" for that entry only; a network-bound
// check is shown as io, queued or running without a slot.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const MINUTE = 60_000;

const record = (root: string, id: string, check: string, startedAt: number) => ({
  id,
  pid: process.pid,
  processStart: null,
  bootId: null,
  check,
  cwd: root,
  session: "s-lead",
  startedAt: new Date(startedAt).toISOString(),
  scope: null,
});

const setup = () => {
  const root = temp("wk-lock-short-");
  spawnSync("git", ["init", "-q", "-b", "feature/short"], { cwd: root });
  const state = temp("wk-lock-short-state-");
  const config = temp("wk-lock-short-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: { scope: false } }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp("wk-lock-short-home-"),
    WORKIT_SESSION_ID: "s-lead",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  for (const key of ["CLAUDECODE", "OPENCODE", "OPENCODE_SESSION_ID"]) delete env[key];
  const leases = path.join(state, "leases");
  mkdirSync(path.join(leases, "queue"), { recursive: true });
  mkdirSync(path.join(leases, "admitted"), { recursive: true });
  return { root, env, leases };
};

const queue = (leases: string, at: number, body: Record<string, unknown>) =>
  writeFileSync(
    path.join(
      leases,
      "queue",
      `${String(at).padStart(15, "0")}-${"1".padStart(16, "0")}-q${at}.json`,
    ),
    JSON.stringify(body),
  );

const status = async (root: string, env: NodeJS.ProcessEnv, json = false) => {
  let stdout = "";
  const code = await main(["lock", "status", ...(json ? ["--json"] : [])], {
    cwd: root,
    env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, stdout };
};

test("Given a queue of a 15-minute suite, an io bench never measured and an 8-second check, When lock status runs, Then the check is listed first and each entry shows its own run", async () => {
  const { root, env, leases } = setup();
  const measured = (name: string, durationMs: number) =>
    expect(
      appendObserved(root, {
        type: "check",
        actor: actorFromEnv(env),
        name,
        result: "passed",
        timedOut: false,
        durationMs,
      }).ok,
    ).toBe(true);
  measured("test", 15 * MINUTE);
  measured("suite", 15 * MINUTE);
  const now = Date.now();
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify(record(root, "00000000-0000-4000-8000-0000000000f1", "test", now - MINUTE)),
  );
  // Each ticket carries its check's measured run from when it queued.
  queue(leases, now - 3_000, {
    ...record(root, "q1", "suite", now - 3_000),
    expectedMs: 15 * MINUTE,
  });
  queue(leases, now - 2_000, { ...record(root, "q2", "bench", now - 2_000), lane: "io" });
  queue(leases, now - 1_000, { ...record(root, "q3", "unit", now - 1_000), expectedMs: 8_000 });
  const text = await status(root, env);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("queue: 3 waiting, shortest measured run first");
  const lines = text.stdout.split("\n").filter((line) => /^ {2}\d\. /u.test(line));
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^ {2}1\. unit, .*; its last run took 8s, estimated wait ~1[34]m/u);
  expect(lines[1]).toMatch(/^ {2}2\. suite, .*; its last run took 15m, estimated wait/u);
  // Never measured: said for the bench alone, with the wait the others' runs give.
  expect(lines[2]).toMatch(/^ {2}3\. bench \(io\), .*; no measured run, estimated wait/u);
  const data = JSON.parse((await status(root, env, true)).stdout).data;
  expect(data.queue.map((holder: { check: string }) => holder.check)).toEqual([
    "unit",
    "suite",
    "bench",
  ]);
  expect(data.queue[2]).toMatchObject({ lane: "io" });
  expect(data.estimates.queue.map((item: { runMs: number | null }) => item.runMs)).toEqual([
    8_000,
    15 * MINUTE,
    null,
  ]);
});

test("Given an io check running without a slot, When lock status runs, Then it is listed as io under admitted holders", async () => {
  const { root, env, leases } = setup();
  const now = Date.now();
  writeFileSync(
    path.join(leases, "admitted", `${String(now).padStart(15, "0")}-a1.json`),
    JSON.stringify({
      ...record(root, "00000000-0000-4000-8000-0000000000a1", "bench", now - 5_000),
      kind: "io",
      lane: "io",
      units: 0,
      bytes: 1024 ** 3,
    }),
  );
  const text = await status(root, env);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("admitted (no slot): 1");
  expect(text.stdout).toMatch(/\n {2}io bench, pid \d+, 1\.0 GiB, session s-lead, 5s, /u);
});
