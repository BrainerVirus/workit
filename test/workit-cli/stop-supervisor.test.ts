// #328 ruling C, the Windows stop path: `workit stop` asks the supervisor that
// holds the child (a stop request file it polls), and with the supervisor gone
// it reports only and signals nothing. Driven here with the real supervisor on
// POSIX (`stopVia: "supervisor"`): the same channel, minus taskkill.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { runDeps } from "@/packages/workit-cli/src/verbs/run";
import { procsDeps, readExtra, stopRequestFile } from "@/packages/workit-core/src/core/procs";
import { openThreadsStore } from "@/packages/workit-core/src/store/threads/store";
import { readLedger } from "@/packages/workit-core/src/ledger";

const BUN = process.execPath;
const MAIN = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
const dirs: string[] = [];
const groups: number[] = [];
const saved = { ...runDeps };
const savedProcs = { ...procsDeps };

beforeAll(() => {
  runDeps.supervisor = () => [BUN, MAIN, "run"];
  runDeps.startBoundMs = 8_000;
  runDeps.hostPid = () => null;
  procsDeps.graceMs = 800;
  procsDeps.stopVia = "supervisor";
});
afterAll(() => {
  Object.assign(runDeps, saved);
  Object.assign(procsDeps, savedProcs);
});
afterEach(() => {
  for (const pid of groups.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const setup = () => {
  const root = temp("wk-stopsup-");
  spawnSync("git", ["init", "-q", "-b", "feature/stop"], { cwd: root });
  const config = temp("wk-stopsup-config-");
  writeFileSync(
    path.join(config, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "here", glob: "**", resources: { scope: false } }] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKIT_SESSION_ID: "s-stop",
    WORKIT_HOST: "claude-code",
    WORKIT_WORKSPACE_ROOT: "",
    WORKIT_STATE_DIR: temp("wk-stopsup-state-"),
    WORKIT_CONFIG_DIR: config,
    WORKIT_LEASE: "",
  };
  const server = path.join(root, "serve.sh");
  writeFileSync(
    server,
    `#!/bin/sh\nsh -c 'trap "" TERM; while :; do sleep 1; done' &\necho "on http://localhost:4600"\nwhile :; do sleep 1; done\n`,
  );
  chmodSync(server, 0o755);
  return { root, env, server };
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
  return { code, stdout, stderr };
};

const start = async (root: string, env: NodeJS.ProcessEnv, server: string) => {
  const result = await run(root, ["run", "--bg", "--json", "--", server], env);
  const data = JSON.parse(result.stdout).data as { id: string; pid: number };
  groups.push(data.pid);
  return data;
};

const alive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

const endedRow = (env: NodeJS.ProcessEnv, id: string) => {
  const store = openThreadsStore({ env });
  try {
    return store.db.get("SELECT ended_at, end_reason FROM procs WHERE id = $id", { id });
  } finally {
    store.close();
  }
};

test("Given a live supervisor, When `workit stop <id>` goes through the stop channel, Then the supervisor ends the whole tree (the SIGTERM-ignoring child after the grace) and the stop is recorded", async () => {
  const { root, env, server } = setup();
  const { id, pid } = await start(root, env, server);
  const stopped = await run(root, ["stop", id, "--reason", "delivered"], env);
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain(`stopped (SIGKILL) ${id}`);
  expect(alive(-pid)).toBe(false);
  expect(existsSync(stopRequestFile(env, id))).toBe(false);
  expect(endedRow(env, id)).toMatchObject({ end_reason: "delivered" });
  expect(readExtra(env, id)).toMatchObject({ state: "exited", stopSignal: "SIGKILL" });
  const ledger = readLedger(root);
  if (!ledger.ok) throw new Error(ledger.error);
  expect(ledger.value.rows.find((row) => row.type === "proc.stopped")).toMatchObject({
    proc: id,
    signal: "SIGKILL",
  });
}, 30_000);

test("Given the supervisor is gone, When `workit stop <id>` runs, Then it reports only: nothing is signalled and the row stays", async () => {
  const { root, env, server } = setup();
  const { id, pid } = await start(root, env, server);
  const supervisor = readExtra(env, id)?.supervisorPid;
  if (!supervisor) throw new Error("no supervisor recorded");
  process.kill(supervisor, "SIGKILL");
  for (let tries = 0; alive(supervisor) && tries < 100; tries += 1) await Bun.sleep(20);
  const refused = await run(root, ["stop", id], env);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain(`not stopped ${id}: its supervisor is gone`);
  expect(alive(pid)).toBe(true);
  expect(endedRow(env, id)).toMatchObject({ ended_at: null });
}, 30_000);
