// #328 core: stopProcesses, reapOrphans and processesWithin over registry rows
// the test writes itself, for processes the test started (rulings 1, 3, 4, B, C).
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openProcs,
  procsDeps,
  processesWithin,
  reapOrphans,
  stopProcesses,
  updateExtra,
} from "@/packages/workit-core/src/core/procs";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { readProc, upsertProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";
import { readLedger } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
const groups: number[] = [];
const savedDocker = procsDeps.docker;
afterEach(() => {
  procsDeps.docker = savedDocker;
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

const world = () => {
  const repo = temp("wk-procs-");
  spawnSync("git", ["init", "-q", "-b", "feature/procs"], { cwd: repo });
  const env: NodeJS.ProcessEnv = { ...process.env, WORKIT_STATE_DIR: temp("wk-procs-state-") };
  return { repo, env };
};

const sleeper = () => {
  const child = spawn("sh", ["-c", "while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  groups.push(child.pid!);
  return child.pid!;
};

const alive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

let counter = 0;
const register = (env: NodeJS.ProcessEnv, fields: Partial<ProcRow> & { cwd: string }): ProcRow => {
  const store = openProcs(env);
  try {
    const pid = fields.pid === undefined ? sleeper() : fields.pid;
    const id = `ptest${(counter += 1).toString().padStart(4, "0")}`;
    updateExtra(env, id, { name: `n${counter}`, state: "running" });
    return upsertProc(store, id, () => ({
      session: "s-owner",
      lead: "s-owner",
      host: "claude-code",
      hostPid: process.pid,
      cmd: "fake server",
      kind: "server",
      startedAt: new Date().toISOString(),
      pid,
      pgid: pid,
      pidStart: pid === null ? null : procTree.start(pid),
      ...fields,
    }));
  } finally {
    store.close();
  }
};

const context = (env: NodeJS.ProcessEnv, caller: string | null = "s-owner") => ({
  env,
  actor: { host: "claude-code", session: caller, agentId: null },
  caller,
  graceMs: 500,
});

const row = (env: NodeJS.ProcessEnv, id: string) => {
  const store = openProcs(env);
  try {
    return readProc(store, id);
  } finally {
    store.close();
  }
};

test("Given a row marked keep, When stopProcesses runs with a session filter, Then it skips it saying why; named by id, it stops", async () => {
  const { repo, env } = world();
  const kept = register(env, { cwd: repo, keep: true, keepRef: "decision mvkeep01" });
  const plain = register(env, { cwd: repo });
  const bySession = await stopProcesses({ session: "s-owner" }, "session-end", context(env));
  expect(bySession.skipped).toEqual([
    {
      id: kept.id,
      cmd: "fake server",
      reason: `kept (decision mvkeep01): only \`workit stop ${kept.id}\` stops it`,
    },
  ]);
  expect(bySession.stopped.map((entry) => entry.id)).toEqual([plain.id]);
  expect(alive(kept.pid!)).toBe(true);
  expect(alive(-plain.pid!)).toBe(false);
  expect(row(env, plain.id)?.endReason).toBe("session-end");

  const byId = await stopProcesses({ ids: [kept.id] }, "stopped by workit stop", context(env));
  expect(byId.stopped.map((entry) => entry.id)).toEqual([kept.id]);
  expect(alive(-kept.pid!)).toBe(false);
});

test("Given a row started from a terminal (no host session), When a session or directory stop runs, Then only its id stops it", async () => {
  const { repo, env } = world();
  const terminal = register(env, { cwd: repo, host: null, hostPid: null });
  const within = await stopProcesses({ within: repo }, "delivered", context(env));
  expect(within.stopped).toEqual([]);
  expect(within.skipped[0].reason).toContain("started outside an agent session");
  const orphans = await reapOrphans(context(env, null));
  expect(orphans.stopped).toEqual([]);
  expect(alive(terminal.pid!)).toBe(true);
  const byId = await stopProcesses({ ids: [terminal.id] }, "by hand", context(env, null));
  expect(byId.stopped.map((entry) => entry.id)).toEqual([terminal.id]);
});

test("Given rows in and outside a checkout, When processesWithin and stopProcesses --within run, Then only the ones inside are listed and stopped", async () => {
  const { repo, env } = world();
  const elsewhere = temp("wk-procs-other-");
  const inside = register(env, { cwd: path.join(repo, "web") });
  const outside = register(env, { cwd: elsewhere });
  const store = openProcs(env);
  try {
    expect(processesWithin(store, repo).map((entry) => entry.id)).toEqual([inside.id]);
  } finally {
    store.close();
  }
  const report = await stopProcesses({ within: repo }, "delivered", context(env));
  expect(report.stopped.map((entry) => entry.id)).toEqual([inside.id]);
  expect(alive(outside.pid!)).toBe(true);
});

test("Given orphans by a gone host pid and by a reused host pid, a live owner and an unknown owner, When reapOrphans runs, Then it stops only the proven orphans and records each", async () => {
  const { repo, env } = world();
  const gone = spawn("true");
  await new Promise((resolve) => gone.once("exit", resolve));
  const deadOwner = register(env, { cwd: repo, hostPid: gone.pid! });
  const reusedOwner = register(env, { cwd: repo, hostPid: process.pid });
  updateExtra(env, reusedOwner.id, { hostPidStart: "an-older-process" });
  const liveOwner = register(env, { cwd: repo, hostPid: process.pid });
  updateExtra(env, liveOwner.id, { hostPidStart: procTree.start(process.pid) });
  const unknown = register(env, { cwd: repo, hostPid: null });

  const dry = await reapOrphans({ ...context(env, null), apply: false });
  expect(dry.orphans.map((entry) => entry.id).toSorted()).toEqual(
    [deadOwner.id, reusedOwner.id].toSorted(),
  );
  expect(dry.unknown.map((entry) => entry.id)).toEqual([unknown.id]);
  expect(dry.stopped).toEqual([]);
  expect(alive(deadOwner.pid!)).toBe(true);

  const applied = await reapOrphans(context(env, null));
  expect(applied.stopped.map((entry) => entry.id).toSorted()).toEqual(
    [deadOwner.id, reusedOwner.id].toSorted(),
  );
  expect(alive(liveOwner.pid!)).toBe(true);
  expect(alive(unknown.pid!)).toBe(true);
  expect(row(env, reusedOwner.id)?.endReason).toContain("now belongs to another process");
  const ledger = readLedger(repo);
  if (!ledger.ok) throw new Error(ledger.error);
  const stopped = ledger.value.rows.filter((entry) => entry.type === "proc.stopped");
  expect(stopped).toHaveLength(2);
});

test("Given a row whose leader pid now belongs to another process, When it is stopped, Then nothing is signalled and the row ends", async () => {
  const { repo, env } = world();
  const stranger = sleeper();
  const reused = register(env, { cwd: repo, pid: stranger, pgid: stranger, pidStart: "not-it" });
  const report = await stopProcesses({ session: "s-owner" }, "session-end", context(env));
  expect(report.stopped).toEqual([]);
  expect(alive(stranger)).toBe(true);
  expect(row(env, reused.id)?.endReason).toBe("found gone (pid reused)");
});

test("Given a docker row, When it is stopped, Then exactly its recorded containers get `docker stop` and nothing is removed", async () => {
  const { repo, env } = world();
  const calls: string[][] = [];
  procsDeps.docker = (args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  const docker = register(env, {
    cwd: repo,
    kind: "docker",
    cmd: "docker run -d nginx",
    pid: null,
    pgid: null,
  });
  updateExtra(env, docker.id, { containers: ["c0ffee01", "c0ffee02"] });
  const report = await stopProcesses({ ids: [docker.id] }, "done", context(env));
  expect(calls).toEqual([["stop", "c0ffee01", "c0ffee02"]]);
  expect(report.stopped[0]).toMatchObject({ id: docker.id, containers: ["c0ffee01", "c0ffee02"] });
  expect(calls.flat().some((word) => /^(?:down|rm|prune|-v)$/u.test(word))).toBe(false);
});

test("Given an agent caller, When it stops by session another family's rows, Then they are skipped as owned by another session", async () => {
  const { repo, env } = world();
  const theirs = register(env, { cwd: repo, session: "s-other", lead: "s-other" });
  const report = await stopProcesses({ ids: [theirs.id] }, "x", context(env, "s-owner:agent1"));
  expect(report.skipped[0].reason).toContain("owned by session s-other");
  expect(alive(theirs.pid!)).toBe(true);
  // A worker of the owner's lead may stop the lead's rows.
  const mine = register(env, { cwd: repo });
  const worker = await stopProcesses({ ids: [mine.id] }, "x", context(env, "s-owner:agent1"));
  expect(worker.stopped.map((entry) => entry.id)).toEqual([mine.id]);
});
