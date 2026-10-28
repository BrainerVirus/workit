// #433: a per-host, per-event record of hook runs, so "zero hook events" is diagnosable.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHookRuns, recordHookRun } from "@/packages/workit-core/src/hooks/hook-runs";
import { runHookProcess } from "@/packages/workit-core/src/hooks/run";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-hook-runs-"));
afterAll(() => {
  chmodSync(scratch, 0o700);
  rmSync(scratch, { recursive: true, force: true });
});
const envOf = (name: string) => ({
  WORKFLOW_TOOLKIT_STATE: path.join(scratch, name),
});

test("Given repeated runs, When recorded, Then each host and event keeps its last time and a count", () => {
  const env = envOf("count");
  recordHookRun("codex_cli", "PreToolUse", env, () => Date.parse("2026-10-27T10:00:00Z"));
  recordHookRun("codex_cli", "PreToolUse", env, () => Date.parse("2026-10-27T10:05:00Z"));
  recordHookRun("codex_cli", "SessionStart", env, () => Date.parse("2026-10-27T09:00:00Z"));
  recordHookRun("cursor", "PreToolUse", env);
  const runs = readHookRuns(env.WORKFLOW_TOOLKIT_STATE);
  const find = (host: string, event: string) =>
    runs.find((run) => run.host === host && run.event === event);
  expect(find("codex_cli", "PreToolUse")).toEqual({
    host: "codex_cli",
    event: "PreToolUse",
    at: "2026-10-27T10:05:00.000Z",
    count: 2,
  });
  expect(find("codex_cli", "SessionStart")?.count).toBe(1);
  expect(find("cursor", "PreToolUse")?.count).toBe(1);
  expect(runs).toHaveLength(3);
});

test("Given no event name, or a state dir that cannot be written, When recorded, Then nothing throws", () => {
  const env = envOf("none");
  recordHookRun("codex_cli", null, env);
  recordHookRun("codex_cli", undefined, env);
  expect(readHookRuns(env.WORKFLOW_TOOLKIT_STATE)).toEqual([]);
  // A state dir under a regular file cannot be created on any OS (`/dev/null` is
  // an ordinary, writable path on Windows).
  const blocker = path.join(scratch, "not-a-dir");
  writeFileSync(blocker, "");
  const unwritable = path.join(blocker, "state");
  recordHookRun("codex_cli", "PreToolUse", { WORKFLOW_TOOLKIT_STATE: unwritable });
  expect(readHookRuns(unwritable)).toEqual([]);
});

test("Given a Codex hook process, When it handles a SessionStart, Then the run is recorded for that surface", async () => {
  const env = { ...process.env, ...envOf("process") };
  let out = "";
  await runHookProcess(
    "codex_desktop",
    [
      JSON.stringify({
        hook_event_name: "SessionStart",
        cwd: scratch,
        session_id: "s1",
        source: "startup",
      }),
    ],
    { write: (text: string) => void (out += text) },
    { write: () => {} },
    env,
  );
  expect(out).toContain("hookSpecificOutput");
  const runs = readHookRuns(env.WORKFLOW_TOOLKIT_STATE);
  expect(runs.map((run) => [run.host, run.event, run.count])).toEqual([
    ["codex_desktop", "SessionStart", 1],
  ]);
});
