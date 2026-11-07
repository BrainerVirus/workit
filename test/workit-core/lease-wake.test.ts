// A queued heavy check takes a slot within seconds once it frees: a holder
// SIGKILLed with its check releases nothing, so the poll bounds the wait; a
// normal release wakes the waiter at once; and a waiter ahead whose own
// workspace allows fewer slots does not hold back one that can use the slot.
import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cancelWaiters } from "@/packages/workit-core/src/core/heavy-lease";
import {
  acquireLease,
  bootId,
  processStart,
  slotLeft,
  type AcquireOptions,
  type AcquireResult,
  type Clock,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leasesDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-wake-"));
  dirs.push(dir);
  const leases = path.join(dir, "leases");
  mkdirSync(leases, { recursive: true });
  return leases;
};

/** Simulated time: each sleep moves it forward and yields one macrotask. */
const fakeClock = (): Clock & { at: () => number } => {
  let now = Date.parse("2026-11-07T18:00:00Z");
  return {
    now: () => now,
    at: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        now += ms;
        setTimeout(resolve, 0);
      }),
  };
};

const holderRecord = (pid: number, overrides: Partial<LeaseRecord> = {}): LeaseRecord => ({
  id: `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
  pid,
  processStart: processStart(pid),
  bootId: bootId(),
  pgid: null,
  pgidStart: null,
  maxAgeMs: null,
  check: "test",
  cwd: "/repo/holder",
  session: `s-holder-${pid}`,
  startedAt: new Date().toISOString(),
  scope: null,
  heartbeatAt: new Date().toISOString(),
  maxHoldMs: null,
  ...overrides,
});

const hold = (dir: string, slot: number, record: LeaseRecord) =>
  writeFileSync(path.join(dir, `slot-${slot}.json`), `${JSON.stringify(record)}\n`);

/** A live process to hold a slot, and a way to kill it outright. */
const holderProcess = async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    pid: child.pid as number,
    kill: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
};

/** A waiter's options; a null clock is the real one. */
const waiter = (
  dir: string,
  clock: Clock | null,
  overrides: Partial<AcquireOptions>,
): AcquireOptions => ({
  dir,
  slots: 1,
  check: "test",
  cwd: "/repo/waiter",
  session: "s-waiter",
  // Simulated: long enough that only the slot ends the wait.
  waitMs: 36_000_000,
  ownerPid: null,
  statusEveryMs: 3_600_000,
  ...(clock ? { clock } : {}),
  ...overrides,
});

const queued = (dir: string) => {
  try {
    return readdirSync(path.join(dir, "queue")).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

const until = async (condition: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const release = (result: AcquireResult) => {
  if (result.ok) result.lease.release();
};

test("Given a slot held by a process that is then SIGKILLed and 2 waiters queued, When the holder dies, Then the first waiter takes the slot within 5 s of polling", async () => {
  const dir = leasesDir();
  const clock = fakeClock();
  const holder = await holderProcess();
  hold(dir, 0, holderRecord(holder.pid));
  let firstAt: number | null = null;
  const first = acquireLease(waiter(dir, clock, { check: "first", session: "s-first" })).then(
    (result) => {
      firstAt = clock.at();
      return result;
    },
  );
  await until(() => queued(dir) === 1);
  const second = acquireLease(waiter(dir, clock, { check: "second", session: "s-second" }));
  await until(() => queued(dir) === 2);
  await holder.kill();
  const diedAt = clock.at();
  const got = await first;
  expect(got.ok).toBe(true);
  expect((firstAt ?? Infinity) - diedAt).toBeLessThanOrEqual(5_000);
  release(got);
  expect((await second).ok).toBe(true);
}, 20_000);

test("Given a waiter ahead whose workspace allows one slot, When the holder of slot 1 is SIGKILLed, Then a two-slot waiter behind it takes slot 1 within 5 s of polling", async () => {
  const dir = leasesDir();
  const clock = fakeClock();
  hold(dir, 0, holderRecord(process.pid, { processStart: null, session: "s-busy" }));
  const holder = await holderProcess();
  hold(dir, 1, holderRecord(holder.pid));
  const narrow = acquireLease(
    waiter(dir, clock, { slots: 1, check: "narrow", session: "s-narrow" }),
  );
  await until(() => queued(dir) === 1);
  let wideAt: number | null = null;
  const wide = acquireLease(
    waiter(dir, clock, { slots: 2, check: "wide", session: "s-wide" }),
  ).then((result) => {
    wideAt = clock.at();
    return result;
  });
  await until(() => queued(dir) === 2);
  await holder.kill();
  const diedAt = clock.at();
  const got = await wide;
  expect(got.ok && got.lease.slot).toBe(1);
  expect((wideAt ?? Infinity) - diedAt).toBeLessThanOrEqual(5_000);
  release(got);
  cancelWaiters(dir, { session: "s-narrow" }, "test");
  expect(await narrow).toMatchObject({ ok: false, reason: "cancelled" });
}, 20_000);

test("Given a slot freed by a normal release, When waiters are queued, Then the head waiter takes it without waiting out its poll", async () => {
  const dir = leasesDir();
  const holding = await acquireLease(waiter(dir, null, { check: "holder", session: "s-h" }));
  if (!holding.ok) throw new Error("the holder did not get the free slot");
  const began = Date.now();
  const head = acquireLease(
    waiter(dir, null, { check: "head", session: "s-head", waitMs: 60_000, pollMs: 30_000 }),
  );
  await until(() => queued(dir) === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  holding.lease.release();
  const got = await Promise.race([
    head,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);
  expect(got?.ok).toBe(true);
  expect(Date.now() - began).toBeLessThan(1_500);
  if (got) release(got);
  else release(await head);
});

test("Given waiters with different slot counts, When slots free, Then each waiter ahead takes the lowest free slot it may use", () => {
  // One count for all: fewer waiters ahead than free slots.
  expect(slotLeft(new Set([0]), [], 2)).toBe(true);
  expect(slotLeft(new Set([0]), [{ slots: 2 }], 2)).toBe(false);
  // A one-slot waiter ahead cannot use slot 1.
  expect(slotLeft(new Set([0]), [{ slots: 1 }], 2)).toBe(true);
  expect(slotLeft(new Set([0]), [{ slots: 1 }], 1)).toBe(false);
  // It takes slot 0 when that frees, leaving slot 1 to the next.
  expect(slotLeft(new Set(), [{ slots: 1 }], 2)).toBe(true);
  expect(slotLeft(new Set(), [{ slots: 1 }, { slots: 2 }], 2)).toBe(false);
  // An older ticket records no count: it may take any slot.
  expect(slotLeft(new Set([0]), [{ slots: null }], 2)).toBe(false);
});
