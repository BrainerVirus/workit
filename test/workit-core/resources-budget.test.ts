// Issue #326: the weighted heavy-check budget. `resources.slots` alone keeps
// today's count; a budget weighs each check (units, and memory in bytes of
// measured peak RSS), a small waiter backfills ahead of a big one until the
// big one has waited past the aging bound, the pressure gate holds checks
// back over its critical line, and `admit` is the accounting call a dev
// server's registry makes: it fits or is refused at once, never queued.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  admit,
  admittedHolders,
  checkCharge,
  describeHolder,
  fitsBudget,
  recordPeakRss,
  resolveResourceSettings,
  type AcquireOptions,
  type Budget,
  type LeaseHolder,
  type QueueStatus,
} from "@/packages/workit-core/src/core/resources";
import { readPressure } from "@/packages/workit-core/src/core/pressure";
import { describeEstimate, estimateWait } from "@/packages/workit-core/src/core/heavy-eta";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-budget-"));
  dirs.push(dir);
  return dir;
};
const leases = () => path.join(temp(), "leases");
const until = async (condition: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const GIB = 1024 ** 3;
const HOST = { totalMemBytes: 32 * GIB, cpus: 8 };
const ALIVE = { alive: () => true, boot: null } as const;

const units = (overrides: Partial<Budget> = {}): Budget => ({
  mode: "units",
  units: 3,
  memoryBytes: 1024 * GIB,
  reserveBytes: 0,
  reserveSource: "automatic",
  weights: { suite: { units: 2 }, lint: { units: 1 } },
  defaultBytes: 1,
  agingMs: 60_000,
  pressureGate: true,
  pressure: null,
  ...overrides,
});

const options = (dir: string, overrides: Partial<AcquireOptions> = {}): AcquireOptions => ({
  dir,
  slots: 3,
  check: "suite",
  cwd: "/repo/mine",
  session: "s-mine",
  waitMs: 10_000,
  pollMs: 10,
  probe: ALIVE,
  watch: false,
  ...overrides,
});

const queued = (dir: string) => {
  try {
    return readdirSync(path.join(dir, "queue")).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

const machine = (value: unknown) => ({
  label: "workspaces.json",
  trust: "machine" as const,
  value,
});
const repo = (value: unknown) => ({ label: ".workit/checks.json", trust: "repo" as const, value });

test("Given nothing configured, Then one check at a time and the automatic reserve: a quarter of RAM, 2-6 GiB, kept from the memory budget", () => {
  const { budget, warnings } = resolveResourceSettings([], HOST);
  expect(warnings).toEqual([]);
  expect(budget).toMatchObject({
    mode: "default",
    units: 1,
    reserveBytes: 6 * GIB,
    reserveSource: "automatic",
    memoryBytes: 26 * GIB,
    defaultBytes: Math.floor(32 * GIB * 0.4),
  });
  expect(
    resolveResourceSettings([], { totalMemBytes: 16 * GIB, cpus: 4 }).budget.reserveBytes,
  ).toBe(4 * GIB);
  expect(resolveResourceSettings([], { totalMemBytes: 4 * GIB, cpus: 2 }).budget.reserveBytes).toBe(
    2 * GIB,
  );
});

test("Given resources.slots: 2 and no new keys, Then two weight-1 checks run and a third queues, exactly as today", async () => {
  const { settings, budget } = resolveResourceSettings([machine({ slots: 2 })], HOST);
  expect(settings.slots).toBe(2);
  expect(budget).toMatchObject({ mode: "slots", units: 2 });
  const dir = leases();
  const run = (check: string) => acquireLease(options(dir, { slots: 2, check, budget, waitMs: 0 }));
  const one = await run("suite");
  const two = await run("suite");
  const three = await run("lint");
  expect(one.ok && two.ok).toBe(true);
  expect(three).toMatchObject({ ok: false, reason: "timeout" });
  // A counted lease records no weight: an older CLI reads it as before.
  expect(one.ok && one.lease.record.units).toBeUndefined();
});

test("Given a units budget, a memory budget, a reserve and weights, Then each resolves; the memory budget lets up to 64 checks hold at once", () => {
  const counted = resolveResourceSettings(
    [machine({ budget: 3, weights: { suite: 2, e2e: "6G" } })],
    HOST,
  );
  expect(counted.warnings).toEqual([]);
  expect(counted.settings.slots).toBe(3);
  expect(counted.budget).toMatchObject({
    mode: "units",
    units: 3,
    weights: { suite: { units: 2 }, e2e: { bytes: 6 * GIB } },
  });
  const sized = resolveResourceSettings([machine({ budget: "24G", reserve: "4G" })], HOST);
  expect(sized.settings.slots).toBe(64);
  expect(sized.budget).toMatchObject({
    mode: "memory",
    memoryBytes: 24 * GIB,
    reserveBytes: 4 * GIB,
    reserveSource: "configured",
  });
  const reserved = resolveResourceSettings([machine({ reserve: "25%" })], HOST).budget;
  expect(reserved).toMatchObject({ mode: "default", memoryBytes: 24 * GIB });
  const bad = resolveResourceSettings(
    [machine({ budget: "lots", weights: { suite: 0 }, pressure: "no" })],
    HOST,
  );
  expect(bad.warnings).toEqual([
    'workspaces.json: budget: must be a number of units (1-1024) or a memory size ("24G", "60%")',
    "workspaces.json: pressure: must be true or false",
    "workspaces.json: weights.suite: a units weight must be a whole number 1-64",
  ]);
  expect(bad.budget.mode).toBe("default");
});

test("Given checks.json trying to raise budget, lower the reserve or a weight, or turn the gate off, Then it is ignored with the machine-only warning; tightening is kept", () => {
  const { budget, warnings } = resolveResourceSettings(
    [
      machine({ budget: 3, weights: { suite: 2 } }),
      repo({ budget: 8, reserve: "1G", weights: { suite: 1 }, pressure: false }),
    ],
    HOST,
  );
  expect(budget).toMatchObject({
    units: 3,
    reserveBytes: 6 * GIB,
    weights: { suite: { units: 2 } },
    pressureGate: true,
  });
  const machineOnly = "is machine-wide; set it in your workspaces.json, not in the repo";
  expect(warnings).toEqual([
    `.workit/checks.json: budget: ${machineOnly}`,
    `.workit/checks.json: pressure: ${machineOnly}`,
    `.workit/checks.json: reserve: ${machineOnly}`,
    `.workit/checks.json: weights.suite: ${machineOnly}`,
  ]);
  const tighter = resolveResourceSettings(
    [machine({ budget: 3 }), repo({ budget: 2, reserve: "8G", weights: { suite: 3 } })],
    HOST,
  );
  expect(tighter.warnings).toEqual([]);
  expect(tighter.budget).toMatchObject({
    units: 2,
    reserveBytes: 8 * GIB,
    weights: { suite: { units: 3 } },
  });
  // With no machine budget a repo cannot introduce one.
  expect(resolveResourceSettings([repo({ budget: 2 })], HOST).warnings).toEqual([
    `.workit/checks.json: budget: ${machineOnly}`,
  ]);
});

test("Given a budget of 3 held by a weight-2 suite, When a weight-2 suite and then a weight-1 lint arrive, Then the lint backfills and the suite waits with one line naming every holder", async () => {
  const dir = leases();
  const budget = units();
  const holder = await acquireLease(options(dir, { budget, session: "s-a" }));
  expect(holder.ok).toBe(true);
  const statuses: QueueStatus[] = [];
  const suite = acquireLease(
    options(dir, {
      budget,
      session: "s-b",
      statusEveryMs: 20,
      onStatus: (status) => statuses.push(status),
    }),
  );
  await until(() => queued(dir) === 1);
  const lint = await acquireLease(options(dir, { budget, check: "lint", session: "s-c" }));
  expect(lint.ok).toBe(true);
  expect(lint.ok && lint.lease.waitedMs).toBe(0);
  expect(lint.ok && lint.lease.record).toMatchObject({ units: 1 });
  await until(() => statuses.some((status) => status.holders.length === 2));
  const line = statuses
    .at(-1)!
    .holders.map((item) => describeHolder(item))
    .join("; ");
  expect(line).toContain("suite, pid");
  expect(line).toContain("lint, pid");
  if (holder.ok) holder.lease.release();
  const got = await suite;
  expect(got.ok).toBe(true);
  if (got.ok) got.lease.release();
  if (lint.ok) lint.lease.release();
});

test("Given a big suite queued past the aging bound, When a small lint arrives that would fit, Then it does not backfill: it runs only once the holder frees room for the suite too", async () => {
  const dir = leases();
  const budget = units({ agingMs: 0 });
  const holder = await acquireLease(options(dir, { budget, session: "s-a" }));
  expect(holder.ok).toBe(true);
  const order: string[] = [];
  const suite = acquireLease(options(dir, { budget, session: "s-b" })).then((got) => {
    order.push("suite");
    return got;
  });
  await until(() => queued(dir) === 1);
  const lint = acquireLease(options(dir, { budget, check: "lint", session: "s-c" })).then((got) => {
    order.push("lint");
    return got;
  });
  await until(() => queued(dir) === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(order).toEqual([]);
  // Without aging the lint would have backfilled at once (the test above).
  if (holder.ok) holder.lease.release();
  const first = await suite;
  const second = await lint;
  expect(order.toSorted()).toEqual(["lint", "suite"]);
  expect(first.ok && second.ok).toBe(true);
  expect(second.ok && second.lease.waitedMs).toBeGreaterThanOrEqual(100);
  for (const got of [first, second]) if (got.ok) got.lease.release();
});

test("Given a units budget of 3, When three weight-1 checks ask, Then all run whatever their memory charge: a units budget counts, it does not weigh memory", async () => {
  const dir = leases();
  const budget = units({ memoryBytes: 1, defaultBytes: GIB });
  const held = [];
  for (const session of ["s-a", "s-b", "s-c"])
    held.push(await acquireLease(options(dir, { budget, check: "lint", session, waitMs: 0 })));
  expect(held.map((got) => got.ok)).toEqual([true, true, true]);
  const fourth = await acquireLease(options(dir, { budget, check: "lint", waitMs: 0 }));
  expect(fourth).toMatchObject({ ok: false, reason: "timeout" });
  for (const got of held) if (got.ok) got.lease.release();
});

test("fitsBudget: backfill passes a waiter that does not fit; an aged one holds the line; a charge over the budget runs alone", () => {
  const budget = { units: 3, memoryBytes: 10, agingMs: 100 };
  const used = { units: 2, bytes: 0 };
  const big = { charge: { units: 2, bytes: 1 }, waitedMs: 50 };
  expect(fitsBudget(budget, used, [big], { units: 1, bytes: 1 })).toBe(true);
  expect(fitsBudget(budget, used, [{ ...big, waitedMs: 100 }], { units: 1, bytes: 1 })).toBe(false);
  expect(fitsBudget(budget, { units: 0, bytes: 0 }, [], { units: 1, bytes: 99 })).toBe(true);
  expect(fitsBudget(budget, { units: 0, bytes: 1 }, [], { units: 1, bytes: 99 })).toBe(false);
  // Units only (memory false) ignores bytes.
  expect(fitsBudget(budget, { units: 0, bytes: 9 }, [], { units: 1, bytes: 5 }, false)).toBe(true);
});

test("Given a fake /proc/pressure above the critical line, When a heavy check asks with budget free, Then it waits and the wait line names the memory pressure", async () => {
  const dir = leases();
  const psi = temp();
  writeFileSync(path.join(psi, "memory"), "some avg10=35.20 avg60=20.00 avg300=5.00 total=1\n");
  writeFileSync(path.join(psi, "cpu"), "some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n");
  const budget = units({ pressure: () => readPressure({ platform: "linux", psiDir: psi }) });
  const statuses: QueueStatus[] = [];
  const got = await acquireLease(
    options(dir, { budget, waitMs: 150, onStatus: (status) => statuses.push(status) }),
  );
  expect(got).toMatchObject({ ok: false, reason: "timeout" });
  const named = (holders: LeaseHolder[]) => holders.map((item) => describeHolder(item)).join("; ");
  expect(named(statuses[0].holders)).toBe(
    "memory pressure: PSI some avg10 35.2% (critical at 10%)",
  );
  if (!got.ok && got.reason === "timeout") expect(named(got.holders)).toContain("memory pressure");
  // The pressure drops: the same check runs.
  writeFileSync(path.join(psi, "memory"), "some avg10=0.10 avg60=0.10 avg300=0.10 total=1\n");
  const after = await acquireLease(options(dir, { budget, waitMs: 0 }));
  expect(after.ok).toBe(true);
  if (after.ok) after.lease.release();
});

test("Given load that never drops, When a check waits on pressure alone, Then its first wait line names it and it runs once pressure has held it its maximum", async () => {
  const dir = leases();
  const budget = units({
    pressureMaxWaitMs: 80,
    pressure: () => readPressure({ platform: "darwin", loadavg: () => [20, 10, 5], cpus: () => 4 }),
  });
  const statuses: QueueStatus[] = [];
  const got = await acquireLease(
    options(dir, { budget, waitMs: 10_000, onStatus: (status) => statuses.push(status) }),
  );
  expect(got.ok).toBe(true);
  expect(got.ok && got.lease.waitedMs).toBeGreaterThanOrEqual(80);
  expect(statuses[0].first).toBe(true);
  expect(describeHolder(statuses[0].holders[0])).toBe(
    "CPU pressure: 1-minute load 5 per CPU (critical at 2)",
  );
  if (got.ok) got.lease.release();
});

test("Given the pressure gate releases on a later clock read than the loop's start, When the lease is granted, Then waitedMs counts the whole wait (never under the pressure maximum)", async () => {
  // Fake clock: the pressure probe itself takes 20 ms after its first read, so
  // the gate's clock read lands well after the loop top (a slow probe under load).
  let now = 0;
  let reads = 0;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const budget = units({
    pressureMaxWaitMs: 80,
    pressure: () => {
      reads += 1;
      if (reads > 1) now += 20;
      return readPressure({ platform: "darwin", loadavg: () => [20, 10, 5], cpus: () => 4 });
    },
  });
  const got = await acquireLease(options(leases(), { budget, clock, waitMs: 10_000 }));
  expect(got.ok).toBe(true);
  expect(got.ok && got.lease.waitedMs).toBeGreaterThanOrEqual(80);
  if (got.ok) got.lease.release();
});

test("Given a wait held by the pressure gate and a server, When it is estimated, Then only checks count: no 'never measured' for the gate", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const at = new Date(now).toISOString();
  const estimate = estimateWait({
    slots: 1,
    holders: [
      { pid: 0, check: "CPU pressure: …", cwd: "", session: null, startedAt: at, kind: "pressure" },
      { pid: 7, check: "vite", cwd: "/w", session: null, startedAt: at, kind: "server" },
      { pid: 8, check: "test", cwd: "/w", session: null, startedAt: at },
    ],
    ahead: [],
    durationOf: ({ check }) => (check === "test" ? 60_000 : null),
    now,
  });
  expect(describeEstimate(estimate)).toBe("estimated wait ~1m (last measured runs)");
});

test("Given CPU over the load line on a machine without PSI, When a check asks, Then the wait names CPU pressure", async () => {
  const budget = units({
    pressure: () => readPressure({ platform: "darwin", loadavg: () => [20, 10, 5], cpus: () => 4 }),
  });
  const got = await acquireLease(options(leases(), { budget, waitMs: 0 }));
  expect(got).toMatchObject({ ok: false, reason: "timeout" });
  if (!got.ok && got.reason === "timeout")
    expect(describeHolder(got.holders[0])).toBe(
      "CPU pressure: 1-minute load 5 per CPU (critical at 2)",
    );
});

const memory = (overrides: Partial<Budget> = {}): Budget =>
  units({ mode: "memory", units: 64, memoryBytes: 4 * GIB, defaultBytes: GIB, ...overrides });

test("admit reserves a weight for a non-check holder and releases it; it never takes a slot or a ticket", () => {
  const dir = leases();
  const got = admit({
    dir,
    kind: "server",
    label: "vite",
    rssBytes: GIB,
    cwd: "/repo/web",
    session: "s-web",
    ref: "srv-1",
    budget: memory(),
    probe: ALIVE,
  });
  expect(got.ok).toBe(true);
  const [entry] = admittedHolders(dir, ALIVE);
  expect(entry.record).toMatchObject({ kind: "server", check: "vite", units: 0, bytes: GIB });
  expect(readdirSync(dir).filter((name) => name.startsWith("slot-"))).toEqual([]);
  expect(existsSync(path.join(dir, "queue"))).toBe(false);
  if (got.ok) {
    got.admission.update(2 * GIB);
    expect(admittedHolders(dir, ALIVE)[0].record.bytes).toBe(2 * GIB);
    got.admission.release();
  }
  expect(admittedHolders(dir, ALIVE)).toEqual([]);
});

test("Given the memory budget is full, When admit is called for a server start, Then it is refused at once naming the holders and the unblock, and queues nothing", async () => {
  const dir = leases();
  const budget = memory();
  const check = await acquireLease(options(dir, { budget, slots: 64, check: "test" }));
  expect(check.ok).toBe(true);
  const first = admit({
    dir,
    kind: "server",
    label: "vite",
    rssBytes: 2 * GIB,
    cwd: "/repo/web",
    session: "s-web",
    ref: "srv-1",
    budget,
    probe: ALIVE,
  });
  expect(first.ok).toBe(true);
  const second = admit({
    dir,
    kind: "server",
    label: "storybook",
    rssBytes: 2 * GIB,
    cwd: "/repo/ui",
    session: "s-ui",
    budget,
    probe: ALIVE,
  });
  // admit is synchronous: a refusal comes back at once, never a wait.
  expect(second).not.toBeInstanceOf(Promise);
  expect(second).toMatchObject({ ok: false, reason: "budget" });
  if (!second.ok) {
    expect(second.line).toContain("storybook not started: it needs 2.0 GiB");
    expect(second.line).toContain("held by test, pid");
    expect(second.line).toContain("server vite (srv-1), pid");
    expect(second.unblock).toBe(
      'workit stop srv-1, or start it with --no-lease --reason "<why>" (recorded in the ledger)',
    );
  }
  expect(admittedHolders(dir, ALIVE)).toHaveLength(1);
  expect(existsSync(path.join(dir, "queue")) && queued(dir)).toBeFalsy();
  if (check.ok) check.lease.release();
  if (first.ok) first.admission.release();
});

test("Given critical pressure, When admit is called, Then it is refused at once naming the pressure", () => {
  const budget = memory({
    pressure: () => readPressure({ platform: "darwin", loadavg: () => [40, 1, 1], cpus: () => 8 }),
  });
  const got = admit({
    dir: leases(),
    kind: "server",
    label: "vite",
    rssBytes: 1,
    cwd: "/repo/web",
    session: null,
    budget,
  });
  expect(got).toMatchObject({ ok: false, reason: "pressure" });
  if (!got.ok)
    expect(got.line).toBe(
      "vite not started: CPU pressure: 1-minute load 5 per CPU (critical at 2)",
    );
});

test("Given only resources.slots configured and a running dev server registered, When a check asks for a lease, Then the server takes no slot", async () => {
  const dir = leases();
  const { budget } = resolveResourceSettings([machine({ slots: 1 })], HOST);
  const server = admit({
    dir,
    kind: "server",
    label: "vite",
    rssBytes: 20 * GIB,
    cwd: "/repo/web",
    session: "s-web",
    budget,
    probe: ALIVE,
  });
  expect(server.ok).toBe(true);
  const got = await acquireLease(options(dir, { slots: 1, check: "test", budget, waitMs: 0 }));
  expect(got.ok).toBe(true);
  expect(got.ok && got.lease.slot).toBe(0);
  if (got.ok) got.lease.release();
  if (server.ok) server.admission.release();
});

test("Given a memory budget a server fills, When a check asks, Then it waits and its wait line names the server", async () => {
  const dir = leases();
  const budget = memory({ defaultBytes: 2 * GIB });
  const server = admit({
    dir,
    kind: "server",
    label: "vite",
    rssBytes: 3 * GIB,
    cwd: "/repo/web",
    session: "s-web",
    ref: "srv-9",
    budget,
    probe: ALIVE,
  });
  expect(server.ok).toBe(true);
  const got = await acquireLease(options(dir, { slots: 64, check: "test", budget, waitMs: 0 }));
  expect(got).toMatchObject({ ok: false, reason: "timeout" });
  if (!got.ok && got.reason === "timeout")
    expect(got.holders.map((item) => describeHolder(item)).join("; ")).toMatch(
      /^server vite \(srv-9\), pid \d+, 3\.0 GiB, session s-web, /u,
    );
  if (server.ok) server.admission.release();
});

test("Given a check's measured peak RSS, Then it is charged that instead of its MemoryMax; a configured size weight wins", () => {
  const dir = leases();
  mkdirSync(dir, { recursive: true });
  const budget = memory({ weights: { e2e: { bytes: 3 * GIB } } });
  expect(checkCharge(budget, dir, "test", "/repo/a")).toEqual({ units: 1, bytes: GIB });
  recordPeakRss(dir, "test", "/repo/a", 512 * 1024 ** 2);
  expect(checkCharge(budget, dir, "test", "/repo/a")).toEqual({ units: 1, bytes: 512 * 1024 ** 2 });
  expect(checkCharge(budget, dir, "test", "/repo/b").bytes).toBe(GIB);
  recordPeakRss(dir, "e2e", "/repo/a", GIB);
  expect(checkCharge(budget, dir, "e2e", "/repo/a").bytes).toBe(3 * GIB);
});
