// #328 session teardown: a host's session end runs `workit stop --session <id>
// --reason session-end` detached, a session start reaps orphans at most once
// per 10 minutes per user, and both fail open. The stop the hook hands off is
// run in-process against a fake process table (the procTree seam), so nothing
// real is signalled; one test starts a fake owned launcher for real.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  dispatchHook,
} from "@/packages/workit-core/src/hooks/index";
import {
  endSession,
  REAP_INTERVAL_MS,
  reapStamp,
  spawnDetached,
  teardownDeps,
  teardownLog,
  type SpawnRequest,
} from "@/packages/workit-core/src/hooks/teardown";
import { LAUNCHER_MARKER } from "@/packages/workit-core/src/core/cli-locate";
import { browserDeps } from "@/packages/workit-core/src/core/browsers";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { keepProc, openProcs, updateExtra } from "@/packages/workit-core/src/core/procs";
import { upsertProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { fixture } from "./hook-fixtures";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-teardown-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const ENV_KEYS = ["WORKIT_STATE_DIR", "WORKIT_INSTALL_ROOT", "WORKIT_SESSION_ID"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedDeps = { ...teardownDeps };
const savedTree = { ...procTree };
const savedBrowsers = { ...browserDeps };

const table = new Map<number, { pgid: number; start: string; alive: boolean }>();
let nextPid = 70_000;
let clock = Date.parse("2026-11-18T09:00:00Z");
let spawned: SpawnRequest[] = [];
let launcher = "";

beforeEach(() => {
  process.env.WORKIT_STATE_DIR = temp("wk-teardown-state-");
  // A fake owned launcher, so the located CLI is never the developer's own.
  const install = temp("wk-teardown-install-");
  mkdirSync(path.join(install, "bin"));
  launcher = path.join(install, "bin", "workit");
  writeFileSync(launcher, `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexit 0\n`);
  chmodSync(launcher, 0o755);
  process.env.WORKIT_INSTALL_ROOT = install;
  delete process.env.WORKIT_SESSION_ID;
  spawned = [];
  teardownDeps.spawn = (request) => {
    spawned.push(request);
    return true;
  };
  teardownDeps.now = () => clock;
  procTree.platform = "linux";
  procTree.start = (pid) => (table.get(pid)?.alive ? table.get(pid)!.start : null);
  procTree.kill = (target, signal) => {
    const members = [...table.entries()]
      .filter(([pid, proc]) => proc.alive && (target < 0 ? proc.pgid === -target : pid === target))
      .map(([, proc]) => proc);
    if (members.length === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    if (signal === 0) return;
    for (const proc of members) proc.alive = false;
  };
  procTree.table = () => null;
  procTree.sleep = async () => {};
  browserDeps.processes = () => [];
});

afterEach(() => {
  Object.assign(teardownDeps, savedDeps);
  Object.assign(procTree, savedTree);
  Object.assign(browserDeps, savedBrowsers);
  table.clear();
  for (const [key, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
const register = (session: string, cwd: string): ProcRow => {
  const pid = (nextPid += 1);
  table.set(pid, { pgid: pid, start: `start-${pid}`, alive: true });
  const store = openProcs(process.env);
  try {
    const id = `tdown${(counter += 1).toString().padStart(4, "0")}`;
    updateExtra(process.env, id, { name: `server${counter}`, state: "running" });
    return upsertProc(store, id, () => ({
      session,
      lead: session,
      host: "claude_code",
      hostPid: null,
      cmd: `fake server ${counter}`,
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
const alive = (row: ProcRow) => table.get(row.pid!)?.alive === true;

/** The `workit …` argv a spawn request runs (after the located launcher's own args). */
const verbArgs = (request: SpawnRequest): string[] =>
  request.args.slice(request.args.indexOf("stop"));

/** Run what the hook handed off, as that child would: the CLI in-process with the request's env. */
const runHandedOff = async (request: SpawnRequest): Promise<string> => {
  let out = "";
  await main(verbArgs(request), {
    cwd: request.cwd,
    env: request.env,
    stdout: (text) => void (out += text),
    stderr: (text) => void (out += text),
  });
  return out;
};

test("Given Claude Code SessionEnd for S with two servers by S and one by T, Then a detached stop for S runs and only S's servers stop", async () => {
  const cwd = temp("wk-teardown-repo-");
  const mine = [register("sess-s", cwd), register("sess-s", cwd)];
  const theirs = register("sess-t", cwd);

  const answer = dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "session-end", cwd, { session_id: "sess-s" }),
    {},
  );

  expect(answer).toMatchObject({ json: {}, exitCode: 0, error: null });
  expect(spawned).toHaveLength(1);
  const [request] = spawned;
  expect(request.command).toBe(launcher);
  expect(verbArgs(request)).toEqual(["stop", "--session", "sess-s", "--reason", "session-end"]);
  expect(request.env).toMatchObject({ WORKIT_SESSION_ID: "sess-s", WORKIT_HOST: "claude_code" });
  expect(readFileSync(teardownLog(process.env), "utf8")).toContain(
    "workit stop --session sess-s --reason session-end",
  );

  const out = await runHandedOff(request);
  expect(mine.map(alive)).toEqual([false, false]);
  expect(alive(theirs)).toBe(true);
  expect(out).toContain(`stopped (SIGTERM) ${mine[0].id}`);
  expect(out).not.toContain(theirs.id);
});

test.each([
  ["codex", codexAdapter, "codex-session-1", "codex_cli"],
  ["cursor", cursorAdapter, "cursor-conv-1", "cursor"],
] as const)(
  "Given a %s session end, Then a detached stop for its session runs and answers {}",
  (host, adapter, session, hostId) => {
    const cwd = temp("wk-teardown-repo-");
    const answer = dispatchHook(adapter, fixture(host, "session-end", cwd), {});
    expect(answer.error).toBeNull();
    expect(answer.json).toEqual({});
    expect(spawned.map(verbArgs)).toEqual([
      ["stop", "--session", session, "--reason", "session-end"],
    ]);
    expect(spawned[0].env).toMatchObject({ WORKIT_SESSION_ID: session, WORKIT_HOST: hostId });
  },
);

test.each(["clear", "resume"])(
  "Given Claude Code SessionEnd reason %s (the session goes on), Then nothing stops",
  (reason) => {
    const cwd = temp("wk-teardown-repo-");
    const answer = dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "session-end", cwd, { reason }),
      {},
    );
    expect(answer.json).toEqual({});
    expect(spawned).toEqual([]);
  },
);

test.each(["logout", "prompt_input_exit", "other"])(
  "Given Claude Code SessionEnd reason %s (the host ends), Then the stop runs",
  (reason) => {
    const cwd = temp("wk-teardown-repo-");
    dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-end", cwd, { reason }), {});
    expect(spawned).toHaveLength(1);
  },
);

test("Given a worker's session end, Then nothing is spawned, so the lead's processes keep running", () => {
  const cwd = temp("wk-teardown-repo-");
  const end = { host: "claude_code", agentId: null, reason: "other", cwd };
  expect(endSession({ ...end, session: "lead-1:child-1" })).toBe(false);
  expect(endSession({ ...end, session: "lead-1-w-abc" })).toBe(false);
  expect(endSession({ ...end, session: "lead-1", agentId: "agent-1" })).toBe(false);
  expect(
    endSession({ ...end, session: "own-1" }, { ...process.env, WORKIT_PI_WORKER_SESSION: "1" }),
  ).toBe(false);
  expect(
    endSession({ ...end, session: "own-1" }, { ...process.env, WORKIT_SESSION_ID: "lead-1:own-1" }),
  ).toBe(false);
  expect(endSession({ ...end, session: "bad id; rm -rf /" })).toBe(false);
  expect(spawned).toEqual([]);
  expect(endSession({ ...end, session: "lead-1" })).toBe(true);
  expect(spawned.map(verbArgs)).toEqual([
    ["stop", "--session", "lead-1", "--reason", "session-end"],
  ]);
});

test("Given SessionStart twice within 10 minutes, Then the orphan reap spawns once, and again after 10 minutes", () => {
  const cwd = temp("wk-teardown-repo-");
  const start = () =>
    dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-start-compact", cwd), {});
  expect(start().error).toBeNull();
  clock += REAP_INTERVAL_MS - 1;
  start();
  expect(spawned.map(verbArgs)).toEqual([["stop", "--orphans", "--reason", "session-start"]]);
  expect(Number(readFileSync(reapStamp(process.env), "utf8"))).toBe(clock - REAP_INTERVAL_MS + 1);
  clock += 1;
  start();
  expect(spawned).toHaveLength(2);
});

test("Given a keep decision and workspace cleanup keep, Then session end stops neither and its output says why", async () => {
  const root = temp("wk-teardown-ws-");
  const kept = path.join(root, "kept", "app");
  const auto = path.join(root, "auto", "app");
  mkdirSync(kept, { recursive: true });
  mkdirSync(auto, { recursive: true });
  const glob = (dir: string) => `${dir.replaceAll("\\", "/")}/**`;
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "kept", glob: glob(path.join(root, "kept")), cleanup: "keep" },
        { name: "auto", glob: glob(path.join(root, "auto")), cleanup: "auto" },
      ],
    }),
  );
  const inKeptWorkspace = register("sess-k", kept);
  const decided = register("sess-k", auto);
  const plain = register("sess-k", auto);
  const store = openProcs(process.env);
  try {
    keepProc(store, decided.id, "decision-1");
  } finally {
    store.close();
  }

  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "session-end", auto, { session_id: "sess-k" }),
    {},
  );
  expect(spawned).toHaveLength(1);
  const out = await runHandedOff(spawned[0]);

  expect([inKeptWorkspace, decided, plain].map(alive)).toEqual([true, true, false]);
  expect(out).toContain(`skipped ${inKeptWorkspace.id}: kept: workspace cleanup keep`);
  expect(out).toContain(`skipped ${decided.id}: kept (decision-1)`);
});

test("Given the hook cannot spawn the CLI, Then session end and start answer fail-open and no reap stamp is written", () => {
  const cwd = temp("wk-teardown-repo-");
  // Not executable: the spawn fails.
  chmodSync(launcher, 0o644);
  teardownDeps.spawn = spawnDetached;
  const ended = dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-end", cwd), {});
  expect(ended).toMatchObject({ json: {}, exitCode: 0, error: null });
  const started = dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "session-start-compact", cwd),
    {},
  );
  expect(started.error).toBeNull();
  expect(existsSync(reapStamp(process.env))).toBe(false);

  teardownDeps.spawn = () => {
    throw new Error("spawn exploded");
  };
  expect(
    dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-end", cwd), {}),
  ).toMatchObject({ json: {}, exitCode: 0, error: null });
  expect(
    dispatchHook(claudeCodeAdapter, fixture("claude-code", "session-start-compact", cwd), {}).error,
  ).toBeNull();
  expect(existsSync(reapStamp(process.env))).toBe(false);
});

test("Given a test run, Then the default spawner never starts a CLI", () => {
  const request: SpawnRequest = {
    command: launcher,
    args: ["stop", "--orphans"],
    env: { ...process.env, WORKIT_TEST_RUN: "1" },
    cwd: os.tmpdir(),
    log: null,
  };
  expect(savedDeps.spawn(request)).toBe(false);
});

test("Given a real owned launcher, When a session ends, Then it runs detached as that session and its output lands in the teardown log", async () => {
  const cwd = temp("wk-teardown-repo-");
  const out = path.join(temp("wk-teardown-out-"), "argv.json");
  writeFileSync(
    launcher,
    `#!${process.execPath}\n// ${LAUNCHER_MARKER}\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), session: process.env.WORKIT_SESSION_ID }));\n` +
      `console.log("fake stop ran");\n`,
  );
  chmodSync(launcher, 0o755);
  teardownDeps.spawn = spawnDetached;
  dispatchHook(
    claudeCodeAdapter,
    fixture("claude-code", "session-end", cwd, { session_id: "sess-real" }),
    {},
  );
  const deadline = Date.now() + 10_000;
  while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(25);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
    argv: ["stop", "--session", "sess-real", "--reason", "session-end"],
    session: "sess-real",
  });
  const log = teardownLog(process.env);
  while (!readFileSync(log, "utf8").includes("fake stop ran") && Date.now() < deadline)
    await Bun.sleep(25);
  expect(readFileSync(log, "utf8")).toContain("fake stop ran");
});
