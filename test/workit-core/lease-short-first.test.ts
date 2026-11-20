// Issue #884: short checks no longer wait behind full suites. The queue serves
// the shortest measured run first, also within one session, and a waiter
// queued past the aging bound goes ahead of newer shorter ones; a check whose
// last measured run is under 30 s, or a network-bound one, runs without a
// slot while the memory budget and the pressure gate allow; a check never
// measured is queued and granted as before.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  admittedHolders,
  DEFAULT_AGING_MS,
  describeHolder,
  fairOrder,
  leaseQueue,
  measuredRss,
  servingOrder,
  SHORT_CHECK_MS,
  type AcquireOptions,
  type Budget,
  type LeaseHolder,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";
import { startHeartbeat } from "@/packages/workit-core/src/core/heavy-lease";
import { readPressure } from "@/packages/workit-core/src/core/pressure";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leases = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-short-first-"));
  dirs.push(dir);
  return path.join(dir, "leases");
};
const until = async (condition: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const GIB = 1024 ** 3;
const MINUTE = 60_000;
const ALIVE = { alive: () => true, boot: null } as const;

/** `resources.slots: 2` with a memory budget that fits every charge here. */
const slots = (overrides: Partial<Budget> = {}): Budget => ({
  mode: "slots",
  units: 2,
  memoryBytes: 64 * GIB,
  reserveBytes: 6 * GIB,
  reserveSource: "automatic",
  weights: {},
  defaultBytes: GIB,
  agingMs: DEFAULT_AGING_MS,
  pressureGate: true,
  pressure: null,
  ...overrides,
});

const options = (dir: string, overrides: Partial<AcquireOptions> = {}): AcquireOptions => ({
  dir,
  slots: 2,
  budget: slots(),
  check: "suite",
  cwd: "/repo/mine",
  session: "s-lead",
  waitMs: 10_000,
  pollMs: 10,
  probe: ALIVE,
  watch: false,
  ...overrides,
});

const queued = (dir: string) => leaseQueue(dir, ALIVE).map((entry) => entry.holder.check);

/** Two slots held by full suites. */
const fullSuites = async (dir: string, budget = slots()) => {
  const held = await Promise.all(
    [1, 2].map((n) => acquireLease(options(dir, { budget, pid: 910_000 + n }))),
  );
  return held.map((got) => {
    if (!got.ok) throw new Error(got.reason);
    return got.lease;
  });
};

const waiter = (check: string, at: number, expectedMs: number | null, session = "s-lead") => ({
  holder: { pid: 1, check, cwd: "/repo", session, startedAt: new Date(at).toISOString() },
  record: (expectedMs === null ? {} : { expectedMs }) as LeaseRecord,
});

const order = (
  waiting: ReturnType<typeof waiter>[],
  now: number,
  holders: LeaseHolder[] = [],
): string[] =>
  servingOrder(waiting, holders, [], now, DEFAULT_AGING_MS).map((entry) => entry.holder.check);

test("Given a 15-minute suite queued before an 8-second check in one session, Then the check is served first", () => {
  const t0 = Date.parse("2026-11-19T10:00:00Z");
  expect(
    order([waiter("test", t0, 15 * MINUTE), waiter("unit", t0 + 1_000, 8_000)], t0 + 2_000),
  ).toEqual(["unit", "test"]);
});

test("Given long jobs repeatedly overtaken by short ones, When a long job has waited past the aging bound, Then it is served ahead of newer short jobs", () => {
  const t0 = Date.parse("2026-11-19T10:00:00Z");
  const waiting = [
    waiter("suite", t0, 15 * MINUTE),
    waiter("e2e", t0 + 10_000, 20 * MINUTE),
    waiter("unit-a", t0 + MINUTE, 40_000),
    waiter("unit-b", t0 + 4 * MINUTE, 40_000),
  ];
  // Just under the bound the short jobs still overtake.
  expect(order(waiting, t0 + DEFAULT_AGING_MS - 1)).toEqual(["unit-a", "unit-b", "suite", "e2e"]);
  // At the bound the suite goes first; e2e, queued 10 s later, is not aged yet.
  expect(order(waiting, t0 + DEFAULT_AGING_MS)).toEqual(["suite", "unit-a", "unit-b", "e2e"]);
  // Both aged: in arrival order, ahead of every newer short job.
  expect(order(waiting, t0 + DEFAULT_AGING_MS + 10_000)).toEqual([
    "suite",
    "e2e",
    "unit-a",
    "unit-b",
  ]);
});

test("Given waiters never measured, Then they keep today's round-robin order and a measured short check goes ahead of them", () => {
  const t0 = Date.parse("2026-11-19T10:00:00Z");
  const waiting = [
    waiter("a1", t0, null, "s-a"),
    waiter("a2", t0 + 1, null, "s-a"),
    waiter("b1", t0 + 2, null, "s-b"),
  ];
  expect(order(waiting, t0 + 10)).toEqual(
    fairOrder(waiting, []).map((entry) => entry.holder.check),
  );
  expect(order(waiting, t0 + 10)).toEqual(["a1", "b1", "a2"]);
  expect(order([...waiting, waiter("unit", t0 + 3, 8_000, "s-a")], t0 + 10)[0]).toBe("unit");
});

test("Given 2 slots held by full suites and a 15-minute suite queued, When an 8-second check asks, Then it runs at once without a slot", async () => {
  const dir = leases();
  const held = await fullSuites(dir);
  const suite = acquireLease(options(dir, { pid: 920_001, expectedMs: 15 * MINUTE }));
  await until(() => queued(dir).length === 1);
  const unit = await acquireLease(
    options(dir, { pid: 920_002, check: "unit", expectedMs: 8_000, waitMs: 0 }),
  );
  expect(unit.ok).toBe(true);
  if (!unit.ok) return;
  expect(unit.lease.slot).toBeNull();
  expect(unit.lease.admitted).toBe("short");
  expect(unit.lease.waitedMs).toBe(0);
  const [entry] = admittedHolders(dir, ALIVE);
  expect(entry.record).toMatchObject({ kind: "short", check: "unit", units: 0, bytes: GIB });
  // The suite still waits for a slot; the check took none.
  expect(queued(dir)).toEqual(["suite"]);
  unit.lease.release();
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
  held[0].release();
  const got = await suite;
  expect(got.ok && got.lease.slot).toBe(0);
  if (got.ok) got.lease.release();
  held[1].release();
});

test("Given the memory budget full and a 15-minute suite queued, When a slot frees, Then a later 8-second check runs first (without a slot once memory allows) and a later 40-second check takes the slot ahead of the suite", async () => {
  const dir = leases();
  // Two holders at 1 GiB each fill a 2 GiB budget: no room to run without a slot.
  const budget = slots({ memoryBytes: 2 * GIB });
  const held = await fullSuites(dir, budget);
  const granted: string[] = [];
  const ask = (check: string, pid: number, expectedMs: number) => {
    const got = acquireLease(options(dir, { budget, pid, check, expectedMs }));
    void got.then((result) => result.ok && granted.push(check));
    return got;
  };
  const suite = ask("suite", 930_001, 15 * MINUTE);
  await until(() => queued(dir).length === 1);
  const mid = ask("mid", 930_002, 40_000);
  await until(() => queued(dir).length === 2);
  const unit = ask("unit", 930_003, 8_000);
  await until(() => queued(dir).length === 3);
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
  held[0].release();
  const [short, slot] = await Promise.all([unit, mid]);
  expect(granted).toEqual(["unit", "mid"]);
  expect(short.ok && short.lease.admitted).toBe("short");
  expect(slot.ok && slot.lease.slot).toBe(0);
  expect(queued(dir)).toEqual(["suite"]);
  if (short.ok) short.lease.release();
  if (slot.ok) slot.lease.release();
  const last = await suite;
  expect(granted).toEqual(["unit", "mid", "suite"]);
  if (last.ok) last.lease.release();
  held[1].release();
});

/** A queued waiter's ticket, as another process wrote it. */
const ticket = (dir: string, at: number, record: Partial<LeaseRecord>) => {
  mkdirSync(path.join(dir, "queue"), { recursive: true });
  writeFileSync(
    path.join(dir, "queue", `${String(at).padStart(15, "0")}-${"0".repeat(16)}-t${at}.json`),
    JSON.stringify({
      id: `00000000-0000-4000-8000-${String(at % 1e12).padStart(12, "0")}`,
      pid: 940_001,
      processStart: null,
      bootId: null,
      check: "suite",
      cwd: "/repo/other",
      session: "s-lead",
      startedAt: new Date(at).toISOString(),
      scope: null,
      slots: 1,
      ...record,
    }),
  );
};

test("Given a 15-minute suite queued, When a 40-second check asks on an injected clock, Then it passes the suite until the suite has waited the aging bound", async () => {
  const now = Date.now();
  const clock = { now: () => now, sleep: async () => {} };
  const ask = (dir: string) =>
    acquireLease(
      options(dir, {
        slots: 1,
        budget: slots({ units: 1 }),
        check: "unit",
        expectedMs: 40_000,
        clock,
        waitMs: 0,
      }),
    );
  const fresh = leases();
  ticket(fresh, now - MINUTE, { expectedMs: 15 * MINUTE });
  const passed = await ask(fresh);
  expect(passed.ok && passed.lease.slot).toBe(0);
  if (passed.ok) passed.lease.release();
  const aged = leases();
  ticket(aged, now - DEFAULT_AGING_MS, { expectedMs: 15 * MINUTE });
  const held = await ask(aged);
  expect(held).toMatchObject({ ok: false, reason: "timeout", position: 2 });
});

test("Given every slot held, When a network-bound check asks, Then it starts without a slot and is shown as io; never measured, it still does", async () => {
  const dir = leases();
  const held = await fullSuites(dir);
  const bench = await acquireLease(options(dir, { check: "bench", io: true, waitMs: 0 }));
  expect(bench.ok).toBe(true);
  if (!bench.ok) return;
  expect(bench.lease).toMatchObject({ slot: null, admitted: "io" });
  const [entry] = admittedHolders(dir, ALIVE);
  expect(entry.record).toMatchObject({ kind: "io", lane: "io", units: 0 });
  expect(describeHolder({ ...entry.record, lane: undefined })).toMatch(
    /^io bench, pid \d+, 1\.0 GiB, session s-lead/u,
  );
  bench.lease.release();
  for (const lease of held) lease.release();
});

test("Given the pressure gate critical, When a short or io check asks, Then it is held back like any check", async () => {
  const dir = leases();
  const budget = slots({
    pressureMaxWaitMs: 10 * MINUTE,
    pressure: () => readPressure({ platform: "darwin", loadavg: () => [20, 10, 5], cpus: () => 4 }),
  });
  for (const extra of [{ expectedMs: 8_000 }, { io: true }]) {
    const got = await acquireLease(options(dir, { budget, check: "unit", waitMs: 0, ...extra }));
    expect(got).toMatchObject({ ok: false, reason: "timeout" });
  }
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
  expect(existsSync(path.join(dir, "admitted"))).toBe(false);
});

test("Given every slot held and memory left only under the reserve, When a short check asks, Then it waits instead of running without a slot", async () => {
  const dir = leases();
  const budget = slots({ memoryBytes: 2 * GIB });
  const held = await fullSuites(dir, budget);
  const got = await acquireLease(
    options(dir, { budget, check: "unit", expectedMs: SHORT_CHECK_MS - 1, waitMs: 0 }),
  );
  expect(got).toMatchObject({ ok: false, reason: "timeout" });
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
  for (const lease of held) lease.release();
});

test("Given a check with no measured run, Then it is queued with every slot held and takes a slot when one is free, as today", async () => {
  const dir = leases();
  const held = await fullSuites(dir);
  const busy = await acquireLease(options(dir, { check: "unit", expectedMs: null, waitMs: 0 }));
  expect(busy).toMatchObject({ ok: false, reason: "timeout" });
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
  held[1].release();
  const got = await acquireLease(options(dir, { check: "unit", expectedMs: null, waitMs: 0 }));
  expect(got.ok && got.lease.slot).toBe(1);
  expect(got.ok && got.lease.admitted).toBeUndefined();
  // A check measured at the threshold or over it is not short.
  const over = await acquireLease(
    options(dir, { check: "suite-b", expectedMs: SHORT_CHECK_MS, waitMs: 0, pid: 950_001 }),
  );
  expect(over).toMatchObject({ ok: false, reason: "timeout" });
  if (got.ok) got.lease.release();
  held[0].release();
});

test("Given a check run without a slot, When its heartbeat stops, Then its peak RSS is kept in the lease dir for its next charge", async () => {
  const dir = leases();
  const got = await acquireLease(options(dir, { check: "unit", expectedMs: 8_000 }));
  if (!got.ok) throw new Error(got.reason);
  expect(got.lease.slot).toBeNull();
  const beat = startHeartbeat(got.lease, { rss: () => 3 * GIB, rssEveryMs: 5, cpu: () => null });
  await new Promise((resolve) => setTimeout(resolve, 40));
  beat.stop();
  expect(measuredRss(dir, "unit", "/repo/mine")).toBe(3 * GIB);
  expect(existsSync(path.join(dir, "admitted", "rss.json"))).toBe(false);
  got.lease.release();
});
