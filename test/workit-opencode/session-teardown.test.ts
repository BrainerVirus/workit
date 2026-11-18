// #328 on OpenCode, which has no session start or exit event (P): the first
// event the plugin's lifecycle sees reaps orphans (at most once per 10 minutes
// per user), and a deleted session's registered processes stop through a
// detached `workit stop --session <id> --reason session-end`. The spawn is a
// recorder: nothing real starts or stops.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createV2Lifecycle } from "@/packages/workit-opencode/src/v2/lifecycle";
import { teardownDeps, type SpawnRequest } from "@/packages/workit-core/src/hooks/teardown";

const savedState = process.env.WORKIT_STATE_DIR;
const savedDeps = { ...teardownDeps };
const dirs: string[] = [];
let spawned: SpawnRequest[] = [];
let root = "";

beforeEach(() => {
  const state = mkdtempSync(path.join(tmpdir(), "workit-oc-teardown-state-"));
  root = mkdtempSync(path.join(tmpdir(), "workit-oc-teardown-"));
  dirs.push(state, root);
  process.env.WORKIT_STATE_DIR = state;
  spawned = [];
  teardownDeps.spawn = (request) => {
    spawned.push(request);
    return true;
  };
  teardownDeps.now = () => Date.parse("2026-11-18T09:00:00Z");
});
afterEach(() => {
  Object.assign(teardownDeps, savedDeps);
  if (savedState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = savedState;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const verb = (request: SpawnRequest) => request.args.slice(request.args.indexOf("stop"));
const lifecycle = () => createV2Lifecycle({ root, getSession: async () => null });

test("Given OpenCode's first lifecycle event and then more, Then the orphan reap spawns once", async () => {
  const plugin = lifecycle();
  await plugin.handleEvent({ type: "session.execution.started", data: { sessionID: "ses_a" } });
  await plugin.handleEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
  // A second plugin instance (another server start) inside the interval: the stamp holds it.
  await lifecycle().handleEvent({ type: "session.idle", data: { sessionID: "ses_a" } });
  expect(spawned.map(verb)).toEqual([["stop", "--orphans", "--reason", "session-start"]]);
});

test("Given an OpenCode session is deleted, Then a detached stop for it runs as that session", async () => {
  await lifecycle().handleEvent({
    type: "session.deleted",
    data: { sessionID: "ses_gone" },
    location: { directory: root },
  });
  expect(spawned.map(verb)).toEqual([
    ["stop", "--orphans", "--reason", "session-start"],
    ["stop", "--session", "ses_gone", "--reason", "session-end"],
  ]);
  expect(spawned[1].env).toMatchObject({ WORKIT_SESSION_ID: "ses_gone", WORKIT_HOST: "opencode" });
});

test("Given a session deleted in another workspace, Then this plugin stops nothing for it", async () => {
  const elsewhere = mkdtempSync(path.join(tmpdir(), "workit-oc-teardown-other-"));
  dirs.push(elsewhere);
  await lifecycle().handleEvent({
    type: "session.deleted",
    data: { sessionID: "ses_other" },
    location: { directory: elsewhere },
  });
  expect(spawned.map(verb)).toEqual([["stop", "--orphans", "--reason", "session-start"]]);
});
