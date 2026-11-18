// #835: workspace `cleanup: keep` holds registered processes at every
// automatic stop (a directory or session stop, the orphan reap), saying so;
// naming the id still stops one. heldWithin lists what a delivery-end stop
// would leave running without stopping anything. The process table is a fake
// behind the procTree seam: nothing real is signalled.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserDeps } from "@/packages/workit-core/src/core/browsers";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import {
  heldWithin,
  openProcs,
  reapOrphans,
  stopProcesses,
  updateExtra,
} from "@/packages/workit-core/src/core/procs";
import { workspaceCleanup } from "@/packages/workit-core/src/core/workspaces";
import { upsertProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-procs-keep-config-");
});
afterAll(() => configHome.restore());

const savedTree = { ...procTree };
const savedBrowsers = { ...browserDeps };
const table = new Map<number, { pgid: number; start: string; alive: boolean }>();
let nextPid = 60_000;
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
beforeEach(() => {
  procTree.platform = "linux";
  procTree.start = (pid) => (table.get(pid)?.alive ? table.get(pid)!.start : null);
  procTree.kill = (target, signal) => {
    const members = [...table.entries()]
      .filter(([pid, proc]) => proc.alive && (target < 0 ? proc.pgid === -target : pid === target))
      .map(([, proc]) => proc);
    if (members.length === 0) throw esrch();
    if (signal === 0) return;
    for (const proc of members) proc.alive = false;
  };
  procTree.table = () => null;
  procTree.sleep = async () => {};
  browserDeps.processes = () => [];
});

const dirs: string[] = [];
afterEach(() => {
  Object.assign(procTree, savedTree);
  Object.assign(browserDeps, savedBrowsers);
  table.clear();
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Two project dirs, `kept` under a workspace with `cleanup: keep` (set on the enclosing entry). */
const world = () => {
  const root = temp("wk-procs-keep-");
  const kept = path.join(root, "kept", "app");
  const auto = path.join(root, "auto", "app");
  const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "outer", glob: glob(path.join(root, "kept")), cleanup: "keep" },
        { name: "inner", glob: glob(kept) },
        { name: "other", glob: glob(path.join(root, "auto")), cleanup: "auto" },
        { name: "typo", glob: glob(path.join(root, "typo")), cleanup: "sometimes" },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, WORKIT_STATE_DIR: temp("wk-procs-keep-state-") };
  return { kept, auto, typo: path.join(root, "typo", "app"), env };
};

let counter = 0;
const register = (env: NodeJS.ProcessEnv, cwd: string, hostPid: number | null = null): ProcRow => {
  const pid = (nextPid += 1);
  table.set(pid, { pgid: pid, start: `start-${pid}`, alive: true });
  const store = openProcs(env);
  try {
    const id = `pkeep${(counter += 1).toString().padStart(4, "0")}`;
    updateExtra(env, id, { name: `n${counter}`, state: "running" });
    return upsertProc(store, id, () => ({
      session: "s-owner",
      lead: "s-owner",
      host: "claude-code",
      hostPid,
      cmd: "fake server",
      kind: "server",
      startedAt: new Date().toISOString(),
      pid,
      pgid: pid,
      pidStart: `start-${pid}`,
      cwd,
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

const alive = (row: ProcRow) => table.get(row.pid!)?.alive === true;

test("Given workspace cleanup keep on an enclosing entry, Then the nested workspace inherits it; an unknown value reads as keep and is named", async () => {
  const { kept, auto, typo, env } = world();
  expect(workspaceCleanup(kept)).toEqual({ mode: "keep", from: "outer" });
  expect(workspaceCleanup(auto)).toEqual({ mode: "auto", from: "other" });
  expect(workspaceCleanup(typo)).toEqual({ mode: "keep", from: "typo", invalid: "sometimes" });
  const held = register(env, typo);
  const report = await stopProcesses({ within: typo }, "delivered", context(env));
  expect(report.stopped).toEqual([]);
  expect(report.skipped[0]?.reason).toContain(
    'kept: workspace cleanup keep (typo), read from the unknown value "sometimes"',
  );
  expect(alive(held)).toBe(true);
});

test("Given a row in a cleanup keep workspace, When a directory stop runs, Then it keeps running with the reason and heldWithin lists it; by id it stops", async () => {
  const { kept, auto, env } = world();
  const held = register(env, kept);
  const plain = register(env, auto);
  expect(heldWithin(kept, { env, caller: "s-owner" })).toEqual([
    {
      id: held.id,
      cmd: "fake server",
      reason: `kept: workspace cleanup keep (outer): only \`workit stop ${held.id}\` stops it`,
    },
  ]);
  expect(heldWithin(auto, { env, caller: "s-owner" })).toEqual([]);
  expect(alive(held)).toBe(true);

  const within = await stopProcesses({ within: kept }, "delivered", context(env));
  expect(within.stopped).toEqual([]);
  expect(within.skipped.map((entry) => entry.id)).toEqual([held.id]);
  expect(alive(held)).toBe(true);

  const bySession = await stopProcesses({ session: "s-owner" }, "session-end", context(env));
  expect(bySession.stopped.map((entry) => entry.id)).toEqual([plain.id]);
  expect(alive(held)).toBe(true);

  const byId = await stopProcesses({ ids: [held.id] }, "by hand", context(env));
  expect(byId.stopped.map((entry) => entry.id)).toEqual([held.id]);
  expect(alive(held)).toBe(false);
});

test("Given an orphan in a cleanup keep workspace, When orphans are reaped, Then it is reported kept and left running", async () => {
  const { kept, auto, env } = world();
  // A host pid that is not running: the owner is gone.
  const orphan = register(env, kept, 59_999);
  const other = register(env, auto, 59_999);
  const report = await reapOrphans(context(env, null));
  expect(report.skipped).toEqual([
    {
      id: orphan.id,
      cmd: "fake server",
      reason: "orphan, but kept: workspace cleanup keep (outer)",
    },
  ]);
  expect(report.stopped.map((entry) => entry.id)).toEqual([other.id]);
  expect(alive(orphan)).toBe(true);
});

test("Given rows under a nested worktree, When the outer checkout is listed or stopped with except, Then they are left out", async () => {
  const { auto, env } = world();
  const nested = path.join(auto, ".claude", "worktrees", "agent-1");
  const inner = register(env, nested);
  const outer = register(env, auto);
  const report = await stopProcesses({ within: auto, except: [nested] }, "delivered", context(env));
  expect(report.stopped.map((entry) => entry.id)).toEqual([outer.id]);
  expect(alive(inner)).toBe(true);
});
