// #835: `workit fanout worktree release` stops the slice's registered
// processes before the worktree goes; one this session may not stop keeps the
// worktree, named, and nothing is removed. The process table is a fake behind
// the procTree seam: nothing real is signalled.
import "@/test/shared/state-isolation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { browserDeps } from "@/packages/workit-core/src/core/browsers";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { openProcs, updateExtra } from "@/packages/workit-core/src/core/procs";
import { upsertProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-release-procs-config-");
});
afterAll(() => configHome.restore());

const savedTree = { ...procTree };
const savedBrowsers = { ...browserDeps };
const table = new Map<number, { pgid: number; start: string; alive: boolean }>();
let nextPid = 70_000;
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

let state = "";
const previousState = process.env.WORKIT_STATE_DIR;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  state = mkdtempSync(path.join(os.tmpdir(), "wk-release-procs-state-"));
  process.env.WORKIT_STATE_DIR = state;
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
afterEach(() => {
  Object.assign(procTree, savedTree);
  Object.assign(browserDeps, savedBrowsers);
  table.clear();
  process.env.WORKIT_STATE_DIR = previousState;
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(state, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const run = async (cwd: string, argv: string[], session = "lead-1") => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** A repo `app` on main with a plan of one slice `a`, its worktree created. */
const world = async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-release-procs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  const file = path.join(root, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "standard",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "ship a",
          acceptance: ["Given the app, When a runs, Then it works"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  const planned = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(planned.code, planned.stderr + planned.stdout).toBe(0);
  const created = await run(cwd, ["fanout", "worktree", "create", "a", "--json"]);
  expect(created.code, created.stderr + created.stdout).toBe(0);
  return { cwd, wt: String(created.json().data.path) };
};

let counter = 0;
const server = (cwd: string, session = "lead-1"): ProcRow => {
  const pid = (nextPid += 1);
  table.set(pid, { pgid: pid, start: `start-${pid}`, alive: true });
  const env = { ...process.env, WORKIT_STATE_DIR: state };
  const store = openProcs(env);
  try {
    const id = `prel${(counter += 1).toString().padStart(4, "0")}`;
    updateExtra(env, id, { name: `dev${counter}`, state: "running" });
    return upsertProc(store, id, () => ({
      session,
      lead: session,
      host: "claude-code",
      cmd: "bun run dev",
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

const running = (row: ProcRow) => table.get(row.pid!)?.alive === true;

test("Given a slice worktree running this session's dev server, When it is released, Then the server stops first and the release names it", async () => {
  const { cwd, wt } = await world();
  const dev = server(wt);
  const released = await run(cwd, ["fanout", "worktree", "release", "a"]);
  expect(released.code, released.stderr + released.stdout).toBe(0);
  expect(released.stdout).toContain(`stopped process ${dev.id} (bun run dev)`);
  expect(running(dev)).toBe(false);
  expect(existsSync(wt)).toBe(false);
});

test("Given a slice worktree running another session's server, When it is released, Then nothing is removed or stopped and the error names the process", async () => {
  const { cwd, wt } = await world();
  const theirs = server(wt, "someone-else");
  const refused = await run(cwd, ["fanout", "worktree", "release", "a", "--json"]);
  expect(refused.code).toBe(3);
  const error = refused.json().error;
  expect(error).toContain(`process ${theirs.id} (bun run dev) owned by session someone-else`);
  expect(error).toContain("nothing was removed");
  expect(running(theirs)).toBe(true);
  expect(existsSync(wt)).toBe(true);
});
