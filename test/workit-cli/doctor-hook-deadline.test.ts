// workit doctor `hook_deadline` (issue #309): a count of the hooks that
// answered the minimal skip result past their own deadline in the last day.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  countHookSkips,
  runDoctor,
  type DoctorCheck,
} from "@/packages/workit-cli/src/admin/doctor";
import { recordHookSkip, type HookSkip } from "@/packages/workit-core/src/hooks/deadline";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-hook-deadline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

const HOUR = 60 * 60 * 1000;
const row = (agoMs: number, outcome: HookSkip["outcome"]): HookSkip => ({
  at: new Date(Date.now() - agoMs).toISOString(),
  host: "claude_code",
  event: "context.turn",
  outcome,
  stage: "dispatch",
  elapsedMs: 8_400,
});

const deadlineRow = (stateDir: string): DoctorCheck =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd: scratch,
    configDir: path.join(scratch, "config"),
    stateDir,
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
    scopeProbe: () => ({ effective: false, supported: false, reason: "test", delegate: null }),
  }).checks.find((check) => check.id === "hook_deadline")!;

test("Given hook skips in the last day, When doctor runs, Then hook_deadline warns with their count and leaves out older ones", () => {
  const state = path.join(scratch, "skips");
  recordHookSkip(row(2 * HOUR, "skip"), state);
  recordHookSkip(row(3 * HOUR, "skip"), state);
  recordHookSkip(row(4 * HOUR, "late"), state);
  recordHookSkip(row(30 * HOUR, "skip"), state);
  const check = deadlineRow(state);
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("2 hooks skipped past the hook deadline in the last day");
  expect(check.detail).toContain("1 answered past it in full");
  expect(check.fix).toContain("workit check");
});

test("Given only late answers in the last day, When doctor runs, Then hook_deadline is information", () => {
  const state = path.join(scratch, "late");
  recordHookSkip(row(HOUR, "late"), state);
  const check = deadlineRow(state);
  expect(check.status).toBe("info");
  expect(check.detail).toContain("no hook skipped in the last day; 1 answered past it in full");
});

test("Given no recorded skips, When doctor runs, Then hook_deadline passes", () => {
  const check = deadlineRow(path.join(scratch, "none"));
  expect(check).toEqual({
    id: "hook_deadline",
    status: "pass",
    detail: "no hook passed its deadline in the last day",
  });
});

test("Given skips written by the hook, When doctor counts them since a time, Then older rows and torn lines are left out", () => {
  const state = path.join(scratch, "count");
  const at = (iso: string, outcome: HookSkip["outcome"]): HookSkip => ({
    ...row(0, outcome),
    at: iso,
  });
  recordHookSkip(at("2026-10-20T10:00:00Z", "skip"), state);
  recordHookSkip(at("2026-10-21T09:00:00Z", "skip"), state);
  recordHookSkip(at("2026-10-21T09:30:00Z", "late"), state);
  appendFileSync(path.join(state, "hook-skips.jsonl"), '{"at":"2026-10-21T09:40:00Z","outc\n');
  expect(countHookSkips(state, Date.parse("2026-10-20T12:00:00Z"))).toEqual({ skip: 1, late: 1 });
});

test("Given no state dir, When doctor counts skips, Then the count is zero", () => {
  expect(countHookSkips(path.join(scratch, "no-such-state-dir"), 0)).toEqual({ skip: 0, late: 0 });
});
