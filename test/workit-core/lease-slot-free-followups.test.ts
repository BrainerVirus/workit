// Issue #926: follow-ups to running short and network-bound checks without a
// slot (#884). An aged waiter that does not fit memory holds the line against
// slot-free admission; the next admission prunes an admitted entry whose
// holder is gone and reaps a hung slot-free check; a hung one shows stuck and
// `workit lock reap` frees it; wait estimates count no slot for a slot-free
// waiter; and every verb resolving resources reads a check's own `heavy`.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateWait } from "@/packages/workit-core/src/core/heavy-eta";
import { reapStuck } from "@/packages/workit-core/src/core/heavy-lease";
import {
  acquireLease,
  admit,
  admittedDir,
  admittedHolders,
  DEFAULT_AGING_MS,
  DEFAULT_MAX_HOLD_MS,
  leaseQueue,
  repoResources,
  resolveResourceSettings,
  type AcquireOptions,
  type Budget,
  type Clock,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leases = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-slot-free-"));
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
const DEAD = 999_901;
const PROBE = { alive: (pid: number) => pid !== DEAD, boot: null } as const;

/** A 4 GiB memory budget: the suite holds 3 GiB of it, the big suite needs 2 GiB, an io check 512 MiB. */
const memory = (): Budget => ({
  mode: "memory",
  units: 64,
  memoryBytes: 4 * GIB,
  reserveBytes: 2 * GIB,
  reserveSource: "configured",
  weights: { suite: { bytes: 3 * GIB }, big: { bytes: 2 * GIB } },
  defaultBytes: GIB / 2,
  agingMs: DEFAULT_AGING_MS,
  pressureGate: false,
  pressure: null,
});

const options = (dir: string, overrides: Partial<AcquireOptions> = {}): AcquireOptions => ({
  dir,
  slots: 64,
  budget: memory(),
  check: "suite",
  cwd: "/repo/mine",
  session: "s-lead",
  waitMs: 30 * MINUTE,
  pollMs: 10,
  probe: PROBE,
  watch: false,
  ...overrides,
});

/** A clock `behindMs` in the past, so a waiter's ticket looks queued that long. */
const behind = (behindMs: number): Clock => ({
  now: () => Date.now() - behindMs,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const held = async (dir: string, overrides: Partial<AcquireOptions> = {}) => {
  const got = await acquireLease(options(dir, overrides));
  if (!got.ok) throw new Error(got.reason);
  return got.lease;
};

/** An admitted entry written as a holder left it. */
const admittedEntry = (dir: string, fields: Partial<LeaseRecord>): string => {
  const id = `00000000-0000-4000-8000-${String(fields.pid ?? 1).padStart(12, "0")}`;
  const startedAt = fields.startedAt ?? new Date().toISOString();
  const record: LeaseRecord = {
    id,
    pid: 1,
    processStart: null,
    bootId: null,
    bootTime: null,
    check: "unit",
    cwd: "/repo/other",
    session: "s-other",
    startedAt,
    scope: null,
    heartbeatAt: startedAt,
    units: 0,
    bytes: GIB / 2,
    ...fields,
  };
  mkdirSync(admittedDir(dir), { recursive: true });
  const file = path.join(
    admittedDir(dir),
    `${String(Date.parse(startedAt)).padStart(15, "0")}-${id}.json`,
  );
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("Given an aged waiter that does not fit memory, When an io check asks, Then it is not admitted slot-free", async () => {
  const dir = leases();
  const suite = await held(dir, { pid: 940_001 });
  const big = acquireLease(
    options(dir, { pid: 940_002, check: "big", clock: behind(DEFAULT_AGING_MS + MINUTE) }),
  );
  await until(() => leaseQueue(dir, PROBE).length === 1);
  const io = await acquireLease(
    options(dir, { pid: 940_003, check: "fetch", io: true, waitMs: 0 }),
  );
  expect(io.ok).toBe(false);
  expect(!io.ok && io.reason).toBe("timeout");
  expect(admittedHolders(dir, PROBE)).toEqual([]);
  suite.release();
  const got = await big;
  expect(got.ok && got.lease.record.check).toBe("big");
  if (got.ok) got.lease.release();
});

test("Given a waiter that does not fit memory but is not aged yet, When an io check asks, Then it still runs at once without a slot", async () => {
  const dir = leases();
  const suite = await held(dir, { pid: 941_001 });
  const big = acquireLease(options(dir, { pid: 941_002, check: "big", waitMs: 2_000 }));
  await until(() => leaseQueue(dir, PROBE).length === 1);
  const io = await acquireLease(
    options(dir, { pid: 941_003, check: "fetch", io: true, waitMs: 0 }),
  );
  expect(io.ok && io.lease.admitted).toBe("io");
  if (io.ok) io.lease.release();
  suite.release();
  const got = await big;
  if (got.ok) got.lease.release();
});

test("Given a stale admitted entry from a killed check, When a short check is admitted, Then the admission prunes it", async () => {
  const dir = leases();
  const file = admittedEntry(dir, { pid: DEAD, kind: "short", check: "killed" });
  expect(admittedHolders(dir, PROBE)[0].stale).toContain(`pid ${DEAD} is gone`);
  const unit = await acquireLease(
    options(dir, { pid: 942_001, check: "unit", expectedMs: 8_000, waitMs: 0 }),
  );
  expect(unit.ok && unit.lease.admitted).toBe("short");
  expect(existsSync(file)).toBe(false);
  expect(unit.ok && unit.lease.reclaimed.map((item) => item.check)).toEqual(["killed"]);
  if (unit.ok) unit.lease.release();
});

test("Given a stale admitted entry, When a weighted check takes a slot, Then it prunes the entry too", async () => {
  const dir = leases();
  const file = admittedEntry(dir, { pid: DEAD, kind: "io", check: "killed" });
  const suite = await held(dir, { pid: 943_001 });
  expect(existsSync(file)).toBe(false);
  expect(suite.reclaimed.map((item) => item.check)).toEqual(["killed"]);
  suite.release();
});

test("Given a slot-free check silent past its hold limit, Then it is reported stuck and `lock reap` frees its memory; a dev server never is", async () => {
  const dir = leases();
  const old = ago(DEFAULT_MAX_HOLD_MS + MINUTE);
  const hung = admittedEntry(dir, {
    pid: 944_001,
    kind: "io",
    check: "fetch",
    startedAt: old,
    heartbeatAt: old,
  });
  const server = admittedEntry(dir, {
    pid: 944_002,
    kind: "server",
    check: "vite",
    startedAt: old,
  });
  const entries = admittedHolders(dir, PROBE);
  expect(entries.find((entry) => entry.file === hung)?.stuck).toContain("past its 15m limit");
  expect(entries.find((entry) => entry.file === server)?.stuck).toBeNull();
  const reaped = reapStuck(dir, 1, DEFAULT_MAX_HOLD_MS, { probe: PROBE });
  expect(reaped).toMatchObject([{ pid: 944_001, check: "fetch", slot: null, admitted: "io" }]);
  expect(existsSync(hung)).toBe(false);
  expect(existsSync(server)).toBe(true);
});

test("Given a slot-free check hung past its auto-reap bound, When the next check is admitted, Then it is reaped and its memory freed", async () => {
  const dir = leases();
  const old = ago(4 * DEFAULT_MAX_HOLD_MS);
  // It holds 3.5 GiB of the 4 GiB budget: nothing else fits beside it.
  const hung = admittedEntry(dir, {
    pid: 945_001,
    kind: "short",
    check: "unit",
    startedAt: old,
    heartbeatAt: old,
    bytes: 3.5 * GIB,
  });
  const suite = await held(dir, { pid: 945_002, waitMs: 0 });
  expect(existsSync(hung)).toBe(false);
  expect(suite.reclaimed).toMatchObject([{ check: "unit", reaped: true }]);
  expect(suite.reclaimed[0].reason).toContain("stuck");
  suite.release();
});

test("Given short and io waiters ahead, Then estimateWait counts no slot for them", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  const at = new Date(now).toISOString();
  const holder = (check: string, lane?: "io") => ({
    pid: 1,
    check,
    cwd: "/repo",
    session: null,
    startedAt: at,
    ...(lane ? { lane } : {}),
  });
  const runs: Record<string, number> = { suite: 10 * MINUTE, unit: 8_000, e2e: 5 * MINUTE };
  const estimate = estimateWait({
    slots: 1,
    holders: [holder("suite")],
    ahead: [holder("unit"), holder("fetch", "io"), holder("e2e")],
    durationOf: ({ check }) => runs[check] ?? null,
    now,
  });
  // The io waiter is never measured, yet it does not make the estimate unknown.
  expect(estimate).toEqual({ ms: 15 * MINUTE });
});

test("Given checks configured with their own heavy, Then the repo's resolved settings list the heavy one and not the io one", () => {
  const config = {
    resources: { heavy: ["test"] },
    checks: [
      { name: "e2e", heavy: true as const },
      { name: "fetch", heavy: "io" as const },
      { name: "lint" },
    ],
  };
  expect(repoResources(config)).toEqual({ heavy: ["test", "e2e"] });
  expect(repoResources({ checks: config.checks })).toEqual({ heavy: ["e2e"] });
  expect(repoResources({ resources: { heavy: { test: {} } }, checks: config.checks })).toEqual({
    heavy: ["test", "e2e"],
  });
  // A malformed block is left for its own warning; no own heavy leaves it as is.
  expect(repoResources({ resources: "nope", checks: config.checks })).toBe("nope");
  expect(repoResources({ resources: { slots: 2 }, checks: [{ name: "lint" }] })).toEqual({
    slots: 2,
  });
  const { settings } = resolveResourceSettings([
    { label: "checks.json", trust: "repo", value: repoResources(config) },
  ]);
  expect(settings.heavy).toContain("e2e");
  expect(settings.heavy).not.toContain("fetch");
});

test("Given a longer configured maxHold, When a dev server is admitted, Then a slot-free check past the default auto-reap bound but within its own is kept", () => {
  const dir = leases();
  const old = ago(4 * DEFAULT_MAX_HOLD_MS);
  const quiet = admittedEntry(dir, { pid: 946_001, kind: "io", startedAt: old, heartbeatAt: old });
  const server = (maxHoldMs?: number) =>
    admit({
      dir,
      kind: "server",
      label: "vite",
      rssBytes: GIB / 2,
      cwd: "/repo/mine",
      session: "s-lead",
      pid: 946_002,
      budget: memory(),
      probe: PROBE,
      ...(maxHoldMs === undefined ? {} : { maxHoldMs }),
    });
  const long = server(2 * 60 * MINUTE);
  expect(long.ok).toBe(true);
  expect(existsSync(quiet)).toBe(true);
  if (long.ok) long.admission.release();
  // The default 15 min bound reaps it: past 3x that and silent.
  const short = server();
  expect(short.ok).toBe(true);
  expect(existsSync(quiet)).toBe(false);
  if (short.ok) short.admission.release();
});

test("Given an aged waiter blocked by slots, not memory, When an io check asks, Then it still runs without a slot (deliberately: it takes no slot)", async () => {
  const dir = leases();
  const slotsBudget: Budget = { ...memory(), mode: "slots", units: 1, weights: {} };
  const suite = await held(dir, { pid: 947_001, slots: 1, budget: slotsBudget });
  const aged = acquireLease(
    options(dir, {
      pid: 947_002,
      slots: 1,
      budget: slotsBudget,
      check: "big",
      clock: behind(DEFAULT_AGING_MS + MINUTE),
    }),
  );
  await until(() => leaseQueue(dir, PROBE).length === 1);
  const io = await acquireLease(
    options(dir, {
      pid: 947_003,
      slots: 1,
      budget: slotsBudget,
      check: "fetch",
      io: true,
      waitMs: 0,
    }),
  );
  expect(io.ok && io.lease.admitted).toBe("io");
  if (io.ok) io.lease.release();
  suite.release();
  const got = await aged;
  if (got.ok) got.lease.release();
});

test("Given an aged waiter blocked by units while its memory fits, When an io check asks, Then it still runs without a slot", async () => {
  const dir = leases();
  // One unit: the suite holds it; the waiter needs 512 MiB of the 3.5 GiB left, so only units block it.
  const units: Budget = {
    ...memory(),
    mode: "default",
    units: 1,
    weights: { suite: { bytes: GIB / 2 } },
  };
  const suite = await held(dir, { pid: 948_001, slots: 1, budget: units });
  const aged = acquireLease(
    options(dir, {
      pid: 948_002,
      slots: 1,
      budget: units,
      check: "big",
      clock: behind(DEFAULT_AGING_MS + MINUTE),
    }),
  );
  await until(() => leaseQueue(dir, PROBE).length === 1);
  const io = await acquireLease(
    options(dir, { pid: 948_003, slots: 1, budget: units, check: "fetch", io: true, waitMs: 0 }),
  );
  expect(io.ok && io.lease.admitted).toBe("io");
  if (io.ok) io.lease.release();
  suite.release();
  const got = await aged;
  if (got.ok) got.lease.release();
});
