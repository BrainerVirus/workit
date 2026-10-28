// workit doctor `hook_runs` (#433): the last SessionStart and PreToolUse each host ran.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { recordHookRun } from "@/packages/workit-core/src/hooks/hook-runs";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-hook-runs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

const runsRow = (stateDir: string): DoctorCheck =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd: scratch,
    configDir: path.join(scratch, "config"),
    stateDir,
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
    scopeProbe: () => ({
      effective: false,
      supported: false,
      reason: "test",
      delegate: null,
    }),
  }).checks.find((check) => check.id === "hook_runs")!;

test("Given no recorded hook run, When doctor runs, Then hook_runs is information that says counting starts with this version", () => {
  const row = runsRow(path.join(scratch, "empty"));
  expect(row.status).toBe("info");
  expect(row.detail).toContain("no host hook run recorded yet");
});

test("Given Codex ran PreToolUse but never SessionStart, When doctor runs, Then hook_runs shows each host's last events", () => {
  const state = path.join(scratch, "runs");
  const env = { WORKFLOW_TOOLKIT_STATE: state };
  const minutes = (n: number) => () => Date.now() - n * 60_000;
  recordHookRun("codex_cli", "PreToolUse", env, minutes(5));
  recordHookRun("codex_cli", "PreToolUse", env, minutes(3));
  recordHookRun("cursor", "SessionStart", env, minutes(90));
  const row = runsRow(state);
  expect(row.status).toBe("pass");
  expect(row.detail).toContain("codex_cli: SessionStart never, PreToolUse 3 min ago (2)");
  expect(row.detail).toContain("cursor: SessionStart 2 h ago (1), PreToolUse never");
});
