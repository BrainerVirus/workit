// Issue #608: a stuck holder is marked and can be reaped, a waiter whose
// owner ended leaves the queue, `workit lock cancel` ends a wait cleanly, and
// the queue serves sessions round-robin.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelWaiters,
  pruneLease,
  reapStuck,
  startHeartbeat,
} from "@/packages/workit-core/src/core/heavy-lease";
import {
  acquireLease,
  autoReapReason,
  leaseSlots,
  resolveResourceSettings,
  stuckReason,
  type AcquireOptions,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leasesDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-hygiene-"));
  dirs.push(dir);
  return path.join(dir, "leases");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
};
const deadPid = (): number =>
  Number(
    spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    }).stdout.trim(),
  );

const ALIVE = { alive: () => true, boot: null } as const;
const MIN = 60_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const options = (dir: string, overrides: Partial<AcquireOptions> = {}): AcquireOptions => ({
  dir,
  slots: 1,
  check: "test",
  cwd: "/repo/mine",
  session: "s-mine",
  waitMs: 10_000,
  pollMs: 5,
  probe: ALIVE,
  ...overrides,
});

const lease = (overrides: Partial<LeaseRecord> = {}): LeaseRecord => ({
  id: "00000000-0000-4000-8000-0000000000e1",
  pid: process.pid,
  processStart: null,
  bootId: null,
  check: "test",
  cwd: "/repo/held",
  session: "s-held",
  startedAt: ago(MIN),
  scope: null,
  ...overrides,
});

const writeSlot = (dir: string, record: LeaseRecord, slot = 0) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `slot-${slot}.json`), JSON.stringify(record));
};

const writeTicket = (dir: string, name: string, record: Partial<LeaseRecord>) => {
  mkdirSync(path.join(dir, "queue"), { recursive: true });
  writeFileSync(path.join(dir, "queue", name), JSON.stringify(lease(record)));
};

const queueFiles = (dir: string): string[] => {
  try {
    return readdirSync(path.join(dir, "queue"));
  } catch {
    return [];
  }
};

test("G a holder past its max hold or silent for 5 min, T it is stuck with its age; a fresh one, or an older lease without a heartbeat under the limit, is not", () => {
  expect(stuckReason(lease({ startedAt: ago(16 * MIN) }), 15 * MIN, NOW)).toBe(
    "held 16m, past its 15m limit",
  );
  expect(stuckReason(lease({ heartbeatAt: ago(6 * MIN) }), 15 * MIN, NOW)).toBeNull();
  expect(
    stuckReason(lease({ startedAt: ago(7 * MIN), heartbeatAt: ago(6 * MIN) }), 15 * MIN, NOW),
  ).toBe("no heartbeat for 6m");
  expect(stuckReason(lease({ startedAt: ago(10 * MIN) }), 15 * MIN, NOW)).toBeNull();
  // The holder's own limit wins over the reader's.
  expect(stuckReason(lease({ startedAt: ago(3 * MIN), maxHoldMs: 2 * MIN }), 15 * MIN, NOW)).toBe(
    "held 3m, past its 2m limit",
  );
});

test("G a holder past 3x its max hold, T the next acquirer reclaims it only while it is silent", () => {
  const silent = lease({ startedAt: ago(50 * MIN), heartbeatAt: ago(20 * MIN) });
  const busy = lease({ startedAt: ago(50 * MIN), heartbeatAt: ago(MIN) });
  expect(autoReapReason(silent, 15 * MIN, NOW)).toContain("stuck: held 50m");
  expect(autoReapReason(busy, 15 * MIN, NOW)).toBeNull();
  expect(autoReapReason(lease({ startedAt: ago(40 * MIN) }), 15 * MIN, NOW)).toBeNull();
});

test("G a silent holder past its auto-reap bound, W a check acquires, T it takes the slot and reports the holder as reaped", async () => {
  const dir = leasesDir();
  writeSlot(dir, lease({ startedAt: new Date(Date.now() - 50 * MIN).toISOString() }));
  const got = await acquireLease(options(dir, { maxHoldMs: 15 * MIN, waitMs: 0 }));
  if (!got.ok) throw new Error(got.reason);
  expect(got.lease.reclaimed).toEqual([
    expect.objectContaining({ pid: process.pid, session: "s-held", reaped: true }),
  ]);
  got.lease.release();
});

test("G resources.maxHold, T the machine sets it and a repo can only lower it", () => {
  const settings = (sources: Parameters<typeof resolveResourceSettings>[0]) =>
    resolveResourceSettings(sources);
  expect(settings([]).settings.maxHoldMs).toBeUndefined();
  expect(
    settings([{ label: "m", trust: "machine", value: { maxHold: "30m" } }]).settings.maxHoldMs,
  ).toBe(30 * MIN);
  const raised = settings([{ label: "r", trust: "repo", value: { maxHold: "1h" } }]);
  expect(raised.settings.maxHoldMs).toBeUndefined();
  expect(raised.warnings.join()).toContain("a repo can only lower it");
  expect(
    settings([{ label: "r", trust: "repo", value: { maxHold: 300 } }]).settings.maxHoldMs,
  ).toBe(5 * MIN);
  expect(
    settings([{ label: "m", trust: "machine", value: { maxHold: "soon" } }]).warnings.join(),
  ).toContain("maxHold");
});

test("G a stuck holder, W lock status reads the slots, T it is marked stuck?, and reap frees only it", () => {
  const dir = leasesDir();
  writeSlot(dir, lease({ startedAt: new Date(Date.now() - 20 * MIN).toISOString() }), 0);
  writeSlot(dir, lease({ id: "00000000-0000-4000-8000-0000000000e2", pid: 4242 }), 1);
  const probe = { alive: () => true, boot: null };
  const slots = leaseSlots(dir, 2, probe, 15 * MIN);
  expect(slots[0].stuck).toContain("past its 15m limit");
  expect(slots[0].holder?.stuck).toContain("past its 15m limit");
  expect(slots[1].stuck).toBeNull();
  expect(reapStuck(dir, 2, 15 * MIN, { target: { pid: 4242 }, probe })).toEqual([]);
  const reaped = reapStuck(dir, 2, 15 * MIN, { probe });
  expect(reaped).toEqual([
    expect.objectContaining({ slot: 0, pid: process.pid, session: "s-held", check: "test" }),
  ]);
  expect(existsSync(path.join(dir, "slot-0.json"))).toBe(false);
  expect(existsSync(path.join(dir, "slot-1.json"))).toBe(true);
});

test("G a waiter whose owner ended and a holder whose process died, W the queue is next read, T the waiter is dropped and the slot freed", () => {
  const dir = leasesDir();
  const dead = deadPid();
  writeSlot(dir, lease({ pid: dead }));
  writeTicket(dir, "000000000000001-0000000000000000-orphan.json", { ownerPid: dead });
  writeTicket(dir, "000000000000002-0000000000000000-alive.json", {
    id: "00000000-0000-4000-8000-0000000000e3",
    ownerPid: process.pid,
  });
  const pruned = pruneLease(dir, 1);
  expect(pruned.map((item) => [item.kind, item.reason])).toEqual([
    ["slot", `holder pid ${dead} is gone`],
    ["waiter", `owner pid ${dead} is gone`],
  ]);
  expect(existsSync(path.join(dir, "slot-0.json"))).toBe(false);
  expect(queueFiles(dir)).toEqual(["000000000000002-0000000000000000-alive.json"]);
});

test("G a queued waiter whose owner process ends, W it polls, T it leaves the queue cancelled", async () => {
  const dir = leasesDir();
  writeSlot(dir, lease());
  const dead = deadPid();
  const got = await acquireLease(
    options(dir, { ownerPid: dead, probe: { alive: (pid) => pid !== dead, boot: null } }),
  );
  expect(got).toMatchObject({ ok: false, reason: "cancelled", by: `owner pid ${dead} is gone` });
  expect(queueFiles(dir)).toEqual([]);
});

test("G my queued waiter, W lock cancel names my session, T it leaves the queue at once and the wait ends cancelled", async () => {
  const dir = leasesDir();
  writeSlot(dir, lease());
  const waiting = acquireLease(options(dir, { session: "s-cancel-me", pollMs: 20 }));
  await until(() => queueFiles(dir).length === 1);
  const cancelled = cancelWaiters(
    dir,
    { session: "s-cancel-me" },
    "workit lock cancel s-cancel-me",
  );
  expect(cancelled).toEqual([expect.objectContaining({ session: "s-cancel-me", how: "marker" })]);
  expect(queueFiles(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
  expect(await waiting).toMatchObject({
    ok: false,
    reason: "cancelled",
    by: "workit lock cancel s-cancel-me",
  });
  expect(queueFiles(dir)).toEqual([]);
});

test("G an older waiter that reads no cancel marker, W lock cancel names its pid, T it is sent SIGTERM", () => {
  const dir = leasesDir();
  writeTicket(dir, "000000000000001-0000000000000000-old.json", { pid: 31337, session: "s-old" });
  const signalled: number[] = [];
  const cancelled = cancelWaiters(dir, { pid: 31337 }, "test", {
    alive: () => true,
    boot: null,
    signal: (pid) => {
      signalled.push(pid);
      return true;
    },
  });
  expect(cancelled).toEqual([expect.objectContaining({ pid: 31337, how: "signal" })]);
  expect(signalled).toEqual([31337]);
});

test("G session A with three queued jobs and session B with one, W slots free up, T B's job is served before A's second", async () => {
  const dir = leasesDir();
  const holder = await acquireLease(options(dir, { check: "holder", session: "s-other" }));
  if (!holder.ok) throw new Error(holder.reason);
  const order: string[] = [];
  const queue = async (check: string, session: string, pid: number) => {
    const waiter = acquireLease(options(dir, { check, session, pid }));
    const count = queueFiles(dir).length;
    await until(() => queueFiles(dir).length === count + 1);
    return waiter.then((got) => {
      order.push(check);
      return got;
    });
  };
  const waiters = [
    await queue("a1", "s-a", 900_101),
    await queue("a2", "s-a", 900_102),
    await queue("a3", "s-a", 900_103),
    await queue("b1", "s-b", 900_201),
  ];
  holder.lease.release();
  for (let served = 0; served < waiters.length; served += 1) {
    await until(() => order.length === served + 1);
    const got = await waiters[["a1", "a2", "a3", "b1"].indexOf(order[served])];
    if (!got.ok) throw new Error(got.reason);
    got.lease.release();
  }
  expect(order).toEqual(["a1", "b1", "a2", "a3"]);
});

test("G a held lease, W its check prints or its group uses CPU, T the heartbeat is refreshed; silent, it is not", async () => {
  const dir = leasesDir();
  const got = await acquireLease(options(dir));
  if (!got.ok) throw new Error(got.reason);
  const read = () => (JSON.parse(readFileSync(got.lease.file, "utf8")) as LeaseRecord).heartbeatAt;
  const first = read();
  expect(first).toBe(got.lease.record.startedAt);
  let ticks = 10;
  let clock = Date.parse(first ?? "") + 1000;
  const beat = startHeartbeat(got.lease, { everyMs: 10, cpu: () => ticks, now: () => clock });
  await sleep(40);
  expect(read()).toBe(first);
  ticks = 20;
  clock += 1000;
  await until(() => read() !== first, 1000);
  const second = read();
  clock += 1000;
  beat.touch();
  await until(() => read() !== second, 1000);
  beat.stop();
  got.lease.release();
});
