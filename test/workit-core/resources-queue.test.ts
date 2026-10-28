// Issue #508: the heavy-check lease queues its waiters first come, first
// served, prints a periodic status line while they wait, and a waiter that
// dies gives up its place.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  leaseQueue,
  parseWait,
  type AcquireOptions,
  type LeaseRecord,
  type QueueStatus,
} from "@/packages/workit-core/src/core/resources";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leasesDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-queue-"));
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

/** A pid that is certainly gone: a child that already exited. */
const deadPid = (): number =>
  Number(
    spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
      encoding: "utf8",
    }).stdout.trim(),
  );

/** Waiters in one process stand for several: fake pids count as alive. */
const ALIVE = { alive: () => true, boot: null } as const;

const options = (dir: string, overrides: Partial<AcquireOptions> = {}): AcquireOptions => ({
  dir,
  slots: 1,
  check: "test",
  cwd: "/repo/mine",
  session: "s-mine",
  waitMs: 10_000,
  pollMs: 10,
  probe: ALIVE,
  ...overrides,
});

const queueFiles = (dir: string): string[] => {
  try {
    return readdirSync(path.join(dir, "queue"));
  } catch {
    return [];
  }
};

test("G a held lease and two queued heavy checks, W the holder releases, T they run in arrival order even when the later one polls faster", async () => {
  const dir = leasesDir();
  const holder = await acquireLease(options(dir, { check: "suite" }));
  if (!holder.ok) throw new Error(holder.reason);
  const order: string[] = [];
  const first = acquireLease(options(dir, { check: "first", pid: 900_001, pollMs: 150 }));
  void first.then(() => order.push("first"));
  await until(() => queueFiles(dir).length === 1);
  const second = acquireLease(options(dir, { check: "second", pid: 900_002, pollMs: 2 }));
  void second.then(() => order.push("second"));
  await until(() => queueFiles(dir).length === 2);
  holder.lease.release();
  const one = await first;
  if (!one.ok) throw new Error(one.reason);
  await sleep(80);
  // The later, faster waiter never jumps the queue.
  expect(order).toEqual(["first"]);
  one.lease.release();
  const two = await second;
  if (!two.ok) throw new Error(two.reason);
  expect(order).toEqual(["first", "second"]);
  two.lease.release();
  expect(queueFiles(dir)).toEqual([]);
});

const ticket = (dir: string, name: string, record: Partial<LeaseRecord>) => {
  mkdirSync(path.join(dir, "queue"), { recursive: true });
  writeFileSync(
    path.join(dir, "queue", name),
    JSON.stringify({
      id: "00000000-0000-4000-8000-0000000000aa",
      processStart: null,
      bootId: null,
      check: "test",
      cwd: "/repo/dead",
      session: null,
      startedAt: new Date().toISOString(),
      scope: null,
      ...record,
    }),
  );
};

test("G a waiter ahead in the queue that died, T the next waiter takes its place and the dead ticket is removed", async () => {
  const dir = leasesDir();
  const dead = deadPid();
  ticket(dir, "000000000000001-0000000000000000-dead.json", { pid: dead });
  const got = await acquireLease(
    options(dir, {
      waitMs: 2_000,
      probe: { alive: (pid) => pid !== dead, boot: null },
    }),
  );
  expect(got.ok).toBe(true);
  if (got.ok) got.lease.release();
  expect(queueFiles(dir)).toEqual([]);
});

test("G a live waiter ahead in the queue, T a newcomer waits behind it even with the slot free", async () => {
  const dir = leasesDir();
  ticket(dir, "000000000000001-0000000000000000-ahead.json", {
    pid: process.pid,
  });
  const statuses: QueueStatus[] = [];
  const got = await acquireLease(
    options(dir, { waitMs: 100, onStatus: (status) => statuses.push(status) }),
  );
  expect(got).toMatchObject({ ok: false, reason: "timeout" });
  expect(statuses[0]).toMatchObject({ position: 2, ahead: 1 });
  // Its own ticket is gone with it; the live one stays.
  expect(queueFiles(dir)).toEqual(["000000000000001-0000000000000000-ahead.json"]);
});

test("G a held lease and a fake clock, W a check waits out a 30 min wait, T it prints a status line every 30 s naming the holder, position and elapsed time, then times out", async () => {
  const dir = leasesDir();
  const holder = await acquireLease(options(dir, { check: "suite", cwd: "/repo/suite" }));
  if (!holder.ok) throw new Error(holder.reason);
  let now = Date.parse("2026-10-28T10:00:00Z");
  const statuses: QueueStatus[] = [];
  const got = await acquireLease(
    options(dir, {
      waitMs: 30 * 60_000,
      pollMs: 1_000,
      statusEveryMs: 30_000,
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          await Promise.resolve();
        },
      },
      onStatus: (status) => statuses.push(status),
    }),
  );
  expect(got).toMatchObject({
    ok: false,
    reason: "timeout",
    waitedMs: 30 * 60_000,
  });
  expect(statuses.length).toBe(60);
  expect(statuses[0]).toMatchObject({
    position: 1,
    ahead: 0,
    waitedMs: 0,
    holders: [{ check: "suite", cwd: "/repo/suite" }],
  });
  expect(statuses[1].waitedMs).toBe(30_000);
  expect(queueFiles(dir)).toEqual([]);
  holder.lease.release();
});

test("G --no-wait (a zero wait), T a busy lease answers at once and leaves no ticket behind", async () => {
  const dir = leasesDir();
  const holder = await acquireLease(options(dir));
  if (!holder.ok) throw new Error(holder.reason);
  const started = Date.now();
  expect(await acquireLease(options(dir, { waitMs: 0 }))).toMatchObject({
    ok: false,
    reason: "timeout",
  });
  expect(Date.now() - started).toBeLessThan(500);
  expect(queueFiles(dir)).toEqual([]);
  holder.lease.release();
  expect(existsSync(holder.lease.file)).toBe(false);
});

test("G queue tickets, T leaseQueue lists the live waiters in arrival order and marks a dead one stale", () => {
  const dir = leasesDir();
  const dead = deadPid();
  ticket(dir, "000000000000002-0000000000000000-b.json", {
    pid: process.pid,
    check: "second",
  });
  ticket(dir, "000000000000001-0000000000000000-a.json", {
    pid: dead,
    check: "first",
  });
  const queue = leaseQueue(dir, { alive: (pid) => pid !== dead, boot: null });
  expect(queue.map((entry) => [entry.holder.check, entry.stale !== null])).toEqual([
    ["first", true],
    ["second", false],
  ]);
});

test("G wait durations, T seconds, s/m/h suffixes parse and junk does not", () => {
  expect(parseWait("90")).toBe(90_000);
  expect(parseWait("90s")).toBe(90_000);
  expect(parseWait("30m")).toBe(1_800_000);
  expect(parseWait("1.5h")).toBe(5_400_000);
  expect(parseWait("0")).toBe(0);
  expect(parseWait("-1")).toBeNull();
  expect(parseWait("soon")).toBeNull();
  expect(parseWait("")).toBeNull();
});

// POSIX only: on Windows child.kill("SIGTERM") hard-terminates without running
// signal handlers (exit code null). A killed waiter's ticket is reaped there by
// the next waiter's waitersAhead() instead.
test.skipIf(process.platform === "win32")(
  "G a queued waiter, W it gets SIGTERM, T it removes its ticket and exits 143",
  async () => {
    const dir = leasesDir();
    const holder = await acquireLease(options(dir, { check: "suite" }));
    if (!holder.ok) throw new Error(holder.reason);
    const module = path.resolve(
      import.meta.dir,
      "../../packages/workit-core/src/core/resources.ts",
    );
    const script = `const { acquireLease } = await import(${JSON.stringify(module)});
await acquireLease({ dir: ${JSON.stringify(dir)}, slots: 1, check: "waiter", cwd: "/w", session: null, waitMs: 60000, pollMs: 20, probe: { alive: () => true, boot: null } });
process.exit(0);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    await until(() => queueFiles(dir).length === 1, 15_000);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(queueFiles(dir)).toEqual([]);
    holder.lease.release();
  },
  30_000,
);
