// A lease waiter is never woken by its own ticket write: on macOS fs.watch can
// report that write after the first pause starts, and the settle it caused
// pushed a 30 min wait to 30050 ms. Watch events here are fired by hand, so
// the outcome does not depend on when the platform delivers them.
import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  leaseWake,
  type AcquireOptions,
  type Clock,
} from "@/packages/workit-core/src/core/resources";

type Listener = (event: string, name: string | null) => void;

const dirs: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const leasesDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-own-wake-"));
  dirs.push(dir);
  return path.join(dir, "leases");
};

/** fs.watch replaced by a silent watcher whose listeners the test fires. */
const fakeWatch = (): ((name: string) => void) => {
  const listeners: Listener[] = [];
  const spy = spyOn(fs, "watch").mockImplementation(((
    _target: string,
    _options: unknown,
    listener: Listener,
  ) => {
    listeners.push(listener);
    return Object.assign(new EventEmitter(), { close: () => undefined });
  }) as unknown as typeof fs.watch);
  restores.push(() => spy.mockRestore());
  return (name) => {
    for (const listener of listeners) listener("rename", name);
  };
};

/** Simulated time that runs `during` at the start of every sleep, before it ends. */
const fakeClock = (during: (ms: number) => void): Clock & { at: () => number } => {
  // The real time: staleness ages a ticket against real now, not this clock.
  let now = Date.now();
  return {
    now: () => now,
    at: () => now,
    sleep: async (ms) => {
      during(ms);
      now += ms;
      await Promise.resolve();
    },
  };
};

const TICKET = "000001700000000-0000000000000001-own.json";

test("Given a waiter's own ticket reported by fs.watch during its pause, When it waits, Then it takes no settle sleep", async () => {
  const fire = fakeWatch();
  const clock = fakeClock(() => fire(TICKET));
  const wake = leaseWake(leasesDir(), clock, TICKET);
  const from = clock.at();
  await wake.pause(1_000);
  await wake.pause(1_000);
  wake.close();
  expect(clock.at() - from).toBe(2_000);
});

test("Given another waiter's ticket or a slot file changes during a pause, When it waits, Then it still wakes and settles", async () => {
  for (const other of ["000001700000000-0000000000000002-other.json", "slot-0.json"]) {
    const fire = fakeWatch();
    const clock = fakeClock(() => fire(other));
    const wake = leaseWake(leasesDir(), clock, TICKET);
    const from = clock.at();
    await wake.pause(1_000);
    wake.close();
    expect(clock.at() - from).toBe(1_050);
    for (const restore of restores.splice(0)) restore();
  }
});

test("Given a held slot and fs.watch reporting the waiter's own ticket on every poll, When it waits out a 3 s limit, Then waitedMs is exactly the limit", async () => {
  const dir = leasesDir();
  const fire = fakeWatch();
  const options = (overrides: Partial<AcquireOptions>): AcquireOptions => ({
    dir,
    slots: 1,
    check: "test",
    cwd: "/repo/mine",
    session: "s-mine",
    waitMs: 3_000,
    pollMs: 1_000,
    probe: { alive: () => true, boot: null },
    ...overrides,
  });
  const holder = await acquireLease(options({ check: "suite", session: "s-suite" }));
  if (!holder.ok) throw new Error(holder.reason);
  const queue = path.join(dir, "queue");
  // Reported once per poll, not per settle: each poll then ends 50 ms late, so 3050 before the fix.
  const clock = fakeClock((ms) => {
    if (ms > 50) for (const name of fs.readdirSync(queue)) fire(name);
  });
  const got = await acquireLease(options({ clock }));
  expect(got).toMatchObject({ ok: false, reason: "timeout", waitedMs: 3_000 });
  holder.lease.release();
});
