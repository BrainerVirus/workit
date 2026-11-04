import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ETA_TAIL_BYTES,
  describeEstimate,
  estimateWait,
  holdLimit,
  ledgerDurations,
  measuredDurations,
  remainingNote,
} from "@/packages/workit-core/src/core/heavy-eta";
import {
  DEFAULT_MAX_HOLD_MS,
  autoReapReason,
  stuckReason,
  type LeaseHolder,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";
import { actorFromEnv, appendObserved, ledgerPath } from "@/packages/workit-core/src/ledger";

const ledgerPathOf = (root: string): string => {
  const file = ledgerPath(root);
  if (!file.ok) throw new Error(file.error);
  return file.value;
};

// #326: wait estimates for the heavy-check lease from measured durations.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-04T12:00:00Z");
const holder = (check: string, startedAgoMs = 0): LeaseHolder => ({
  pid: 1,
  check,
  cwd: "/repo",
  session: null,
  startedAt: new Date(NOW - startedAgoMs).toISOString(),
});
const MIN = 60_000;
const table: Record<string, number> = { test: 14 * MIN, packaging: 3 * MIN, build: 2 * MIN };
const durationOf = ({ check }: { check: string }) => table[check] ?? null;

test("G one slot held 4m into a 14m suite, T the next waiter waits ~10m; behind a 3m packaging run, ~13m", () => {
  const base = { slots: 1, holders: [holder("test", 4 * MIN)], durationOf, now: NOW };
  expect(estimateWait({ ...base, ahead: [] })).toEqual({ ms: 10 * MIN });
  expect(estimateWait({ ...base, ahead: [holder("packaging")] })).toEqual({ ms: 13 * MIN });
});

test("G two slots, T a waiter takes whichever frees first, and a free slot means no wait", () => {
  const holders = [holder("test", 1 * MIN), holder("packaging", 1 * MIN)];
  expect(estimateWait({ slots: 2, holders, ahead: [], durationOf, now: NOW })).toEqual({
    ms: 2 * MIN,
  });
  // packaging's slot (free at 2m) goes to the build ahead (until 4m); then the suite's at 13m vs 4m.
  expect(
    estimateWait({ slots: 2, holders, ahead: [holder("build")], durationOf, now: NOW }),
  ).toEqual({ ms: 4 * MIN });
  expect(
    estimateWait({ slots: 2, holders: [holder("test")], ahead: [], durationOf, now: NOW }),
  ).toEqual({ ms: 0 });
});

test("G a holder past its last measured run, T it frees any moment; G an unmeasured check, T no estimate naming it", () => {
  expect(
    estimateWait({
      slots: 1,
      holders: [holder("build", 5 * MIN)],
      ahead: [],
      durationOf,
      now: NOW,
    }),
  ).toEqual({ ms: 0 });
  const unknown = estimateWait({
    slots: 1,
    holders: [holder("lint-all")],
    ahead: [holder("e2e")],
    durationOf,
    now: NOW,
  });
  expect(unknown).toEqual({ ms: null, unmeasured: ["lint-all", "e2e"] });
  expect(describeEstimate(unknown)).toBe("no wait estimate yet (no measured run of lint-all, e2e)");
  expect(describeEstimate({ ms: 10 * MIN })).toBe("estimated wait ~10m (last measured runs)");
  expect(remainingNote(holder("test", 4 * MIN), durationOf, NOW)).toBe("~10m left");
  expect(remainingNote(holder("build", 5 * MIN), durationOf, NOW)).toBe("past its last 2m run");
  expect(remainingNote(holder("e2e"), durationOf, NOW)).toBeNull();
});

test("G ledger check rows, T the last passed run of each check counts, a later failure or timeout does not, an ad-hoc run is keyed by its argv", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-eta-"));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/eta"], { cwd: root });
  const actor = actorFromEnv({});
  const row = (fields: Record<string, unknown>) =>
    expect(appendObserved(root, { type: "check", actor, timedOut: false, ...fields }).ok).toBe(
      true,
    );
  row({ name: "test", result: "passed", durationMs: 100 });
  row({ name: "test", result: "passed", durationMs: 200 });
  row({ name: "test", result: "failed", durationMs: 5 });
  row({ name: "test", result: "failed", durationMs: 9_000, timedOut: true });
  row({ name: "build", result: "failed", durationMs: 50 });
  row({ name: null, argv: ["bun", "test", "a.ts"], result: "passed", durationMs: 70 });
  const durations = measuredDurations(root);
  expect(durations.get("test")).toBe(200);
  expect(durations.get("build")).toBe(50);
  expect(durations.get("bun test a.ts")).toBe(70);
  let reads = 0;
  const lookup = ledgerDurations((cwd) => {
    reads += 1;
    return measuredDurations(cwd);
  });
  expect(lookup({ check: "test", cwd: root })).toBe(200);
  expect(lookup({ check: "nope", cwd: root })).toBeNull();
  expect(reads).toBe(1);
  expect(measuredDurations(path.join(root, "missing")).size).toBe(0);
});

test("G a ledger longer than the read window, T measuredDurations reads only its tail: an early row is not read", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-eta-tail-"));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/eta"], { cwd: root });
  const actor = actorFromEnv({});
  const row = (fields: Record<string, unknown>) =>
    expect(
      appendObserved(root, { type: "check", actor, timedOut: false, result: "passed", ...fields })
        .ok,
    ).toBe(true);
  row({ name: "early", durationMs: 100 });
  for (let i = 0; i < 40; i += 1) row({ name: "test", durationMs: 1_000 + i });
  const tail = 4 * 1024;
  expect(statSync(ledgerPathOf(root)).size).toBeGreaterThan(tail);
  const bounded = measuredDurations(root, tail);
  expect(bounded.get("test")).toBe(1_039);
  expect(bounded.has("early")).toBe(false);
  // The default window is bounded too, and holds this whole small ledger.
  expect(ETA_TAIL_BYTES).toBeLessThanOrEqual(1024 * 1024);
  expect(measuredDurations(root).get("early")).toBe(100);
});

test("G a check measured at 25m, W it has held a slot 20m, T it is not stuck; G no history, T the 15m limit applies", () => {
  const lease = (holdMs: number, heldMs: number): LeaseRecord => ({
    id: "l",
    pid: 1,
    processStart: null,
    bootId: null,
    check: "test",
    cwd: "/repo",
    session: null,
    startedAt: new Date(NOW - heldMs).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    scope: null,
    maxHoldMs: holdMs,
  });
  const measured = holdLimit(25 * MIN);
  expect(measured).toBe(37.5 * MIN);
  expect(stuckReason(lease(measured, 20 * MIN), DEFAULT_MAX_HOLD_MS, NOW)).toBeNull();
  expect(stuckReason(lease(measured, 40 * MIN), DEFAULT_MAX_HOLD_MS, NOW)).toContain(
    "37m 30s limit",
  );
  const unmeasured = holdLimit(null);
  expect(unmeasured).toBe(15 * MIN);
  expect(stuckReason(lease(unmeasured, 20 * MIN), DEFAULT_MAX_HOLD_MS, NOW)).toContain(
    "past its 15m limit",
  );
  // A short measured run never lowers the configured limit; a configured one is the floor.
  expect(holdLimit(2 * MIN)).toBe(15 * MIN);
  expect(holdLimit(25 * MIN, 45 * MIN)).toBe(45 * MIN);
  // Auto-reap keeps its 3x factor on the derived limit: silent 100m, held 100m < 112.5m.
  const silent = { ...lease(measured, 100 * MIN), heartbeatAt: null };
  expect(autoReapReason(silent, DEFAULT_MAX_HOLD_MS, NOW)).toBeNull();
  const longer = { ...lease(measured, 115 * MIN), heartbeatAt: null };
  expect(autoReapReason(longer, DEFAULT_MAX_HOLD_MS, NOW)).toContain("3x its 37m 30s limit");
});
