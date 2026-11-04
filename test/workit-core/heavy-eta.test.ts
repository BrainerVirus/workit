import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeEstimate,
  estimateWait,
  ledgerDurations,
  measuredDurations,
  remainingNote,
} from "@/packages/workit-core/src/core/heavy-eta";
import type { LeaseHolder } from "@/packages/workit-core/src/core/resources";
import { actorFromEnv, appendObserved } from "@/packages/workit-core/src/ledger";

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
