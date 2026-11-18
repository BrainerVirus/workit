// #328 on Pi: session_shutdown with reason quit runs `workit stop --session
// <pi session> --reason session-end` detached; a session that goes on (new,
// resume, fork, reload) or a supervised worker's stops nothing. session_start
// reaps orphans at most once per 10 minutes. The spawn is a recorder: nothing
// real starts or stops.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "@/packages/workit-pi/extensions/workit";
import { teardownDeps, type SpawnRequest } from "@/packages/workit-core/src/hooks/teardown";

const KEYS = ["WORKIT_STATE_DIR", "WORKIT_PI_WORKER_SESSION"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedDeps = { ...teardownDeps };
const dirs: string[] = [];
let spawned: SpawnRequest[] = [];
let clock = Date.now();

beforeEach(() => {
  const state = mkdtempSync(path.join(tmpdir(), "workit-pi-teardown-state-"));
  dirs.push(state);
  process.env.WORKIT_STATE_DIR = state;
  delete process.env.WORKIT_PI_WORKER_SESSION;
  spawned = [];
  teardownDeps.spawn = (request) => {
    spawned.push(request);
    return true;
  };
  teardownDeps.now = () => clock;
});
afterEach(() => {
  Object.assign(teardownDeps, savedDeps);
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-teardown-"));
  dirs.push(root);
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    registerTool: () => undefined,
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  };
  await extension(pi as any);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getCwd: () => root,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { confirm: async () => true, select: async () => "approved" },
  } as any;
  return {
    shutdown: (reason: string) =>
      handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx),
    start: () => handlers.get("session_start")!({ type: "session_start" }, ctx),
  };
};

const verb = (request: SpawnRequest) => request.args.slice(request.args.indexOf("stop"));

test("Given Pi quits, Then a detached stop for its session runs as that session", async () => {
  const pi = await setup();
  await pi.shutdown("quit");
  expect(spawned.map(verb)).toEqual([
    ["stop", "--session", "pi-session", "--reason", "session-end"],
  ]);
  expect(spawned[0].env).toMatchObject({ WORKIT_SESSION_ID: "pi-session", WORKIT_HOST: "pi" });
});

test.each(["new", "resume", "fork", "reload"])(
  "Given Pi's session_shutdown reason %s (the process goes on), Then nothing stops",
  async (reason) => {
    const pi = await setup();
    await pi.shutdown(reason);
    expect(spawned).toEqual([]);
  },
);

test("Given a supervised Pi worker quits, Then nothing stops (its rows belong to the lead)", async () => {
  process.env.WORKIT_PI_WORKER_SESSION = "1";
  const pi = await setup();
  await pi.shutdown("quit");
  expect(spawned).toEqual([]);
});

test("Given two Pi session starts within 10 minutes, Then the orphan reap spawns once", async () => {
  const pi = await setup();
  await pi.start();
  clock += 60_000;
  await pi.start();
  expect(spawned.map(verb)).toEqual([["stop", "--orphans", "--reason", "session-start"]]);
});
