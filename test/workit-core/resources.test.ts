import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheckCommand } from "@/packages/workit-core/src/checks";
import {
  acquireLease,
  firstNotice,
  heldLease,
  resolveResourceSettings,
  scopePrefix,
  scopeSupport,
  staleReason,
  type LeaseRecord,
} from "@/packages/workit-core/src/core/resources";

// Issue #282 slice 1: the machine lease and the systemd scope for heavy checks.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix = "wk-res-") => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const HOST = { totalMemBytes: 34_359_738_368, cpus: 8 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pid that is certainly gone: a child that already exited. */
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  });
  return Number(child.stdout.trim());
};

const leaseRecord = (overrides: Partial<LeaseRecord> = {}): LeaseRecord => ({
  id: "00000000-0000-4000-8000-000000000001",
  pid: process.pid,
  processStart: null,
  bootId: null,
  check: "test",
  cwd: "/repo/other",
  session: "s-other",
  startedAt: new Date().toISOString(),
  scope: null,
  ...overrides,
});
const writeSlot = (dir: string, record: LeaseRecord | string, slot = 0) => {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `slot-${slot}.json`);
  writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
  return file;
};
const base = (dir: string) => ({
  dir,
  slots: 1,
  check: "test",
  cwd: "/repo/mine",
  session: "s-mine",
  waitMs: 0,
  pollMs: 20,
});

test("G no resources config, T one slot, test/build/typecheck heavy, 40% RAM and 70% of the CPUs", () => {
  const { settings, warnings } = resolveResourceSettings([], HOST);
  expect(warnings).toEqual([]);
  expect(settings).toEqual({
    slots: 1,
    heavy: ["test", "build", "typecheck"],
    memoryMax: "13743895347",
    cpuQuota: "560%",
    waitMs: 600_000,
    scope: true,
  });
});

test("G repo then workspace resources, T the workspace wins field by field and a bad field keeps the earlier value", () => {
  const { settings, warnings } = resolveResourceSettings(
    [
      {
        label: "workit.checks.json",
        value: { heavy: ["test", "e2e"], slots: 2, memoryMax: "50%", cpuQuota: "25%", wait: 30 },
      },
      { label: "workspaces.json", value: { slots: 3, memoryMax: "8G", cpuQuota: 4, scope: false } },
      { label: "late", value: { slots: 0, memoryMax: "lots", cpuQuota: "150%", heavy: "test" } },
    ],
    HOST,
  );
  expect(settings).toEqual({
    slots: 3,
    heavy: ["test", "e2e"],
    memoryMax: "8G",
    cpuQuota: "400%",
    waitMs: 30_000,
    scope: false,
  });
  expect(warnings).toHaveLength(4);
  expect(warnings.join("\n")).toContain("late: slots");
  // The design's weight map form names the heavy checks by its keys.
  expect(
    resolveResourceSettings([{ label: "x", value: { heavy: { build: 1 } } }], HOST).settings.heavy,
  ).toEqual(["build"]);
  expect(
    resolveResourceSettings([{ label: "x", value: { cpuQuota: "25%" } }], HOST).settings.cpuQuota,
  ).toBe("200%");
});

test("G a free slot, T acquire writes the holder, a second acquire times out naming it, release frees the slot", async () => {
  const dir = path.join(temp(), "leases");
  const first = await acquireLease(base(dir));
  if (!first.ok) throw new Error(first.reason);
  const stored = JSON.parse(readFileSync(first.lease.file, "utf8"));
  expect(stored).toMatchObject({
    pid: process.pid,
    check: "test",
    cwd: "/repo/mine",
    session: "s-mine",
  });
  const second = await acquireLease({ ...base(dir), cwd: "/repo/two" });
  expect(second).toMatchObject({
    ok: false,
    reason: "timeout",
    holders: [{ pid: process.pid, check: "test", cwd: "/repo/mine" }],
  });
  first.lease.release();
  expect(existsSync(first.lease.file)).toBe(false);
  const third = await acquireLease(base(dir));
  expect(third.ok).toBe(true);
  if (third.ok) third.lease.release();
});

test("G one slot held, W a second acquirer waits, T it gets the slot once the holder releases and reports the wait", async () => {
  const dir = path.join(temp(), "leases");
  const first = await acquireLease(base(dir));
  if (!first.ok) throw new Error(first.reason);
  const seen: string[] = [];
  const pending = acquireLease({
    ...base(dir),
    cwd: "/repo/two",
    waitMs: 5000,
    onWait: (holders) => seen.push(...holders.map((holder) => holder.cwd)),
  });
  await sleep(200);
  first.lease.release();
  const second = await pending;
  if (!second.ok) throw new Error(second.reason);
  expect(seen).toEqual(["/repo/mine"]);
  expect(second.lease.waitedMs).toBeGreaterThanOrEqual(150);
  expect(second.lease.waitedOn[0]).toMatchObject({ cwd: "/repo/mine", check: "test" });
  second.lease.release();
});

test("G two slots, T two holders run at once and a third waits", async () => {
  const dir = path.join(temp(), "leases");
  const one = await acquireLease({ ...base(dir), slots: 2 });
  const two = await acquireLease({ ...base(dir), slots: 2 });
  const three = await acquireLease({ ...base(dir), slots: 2 });
  expect([one.ok, two.ok, three.ok]).toEqual([true, true, false]);
  if (one.ok) one.lease.release();
  if (two.ok) two.lease.release();
});

test("G a lease whose holder pid is dead, T the next acquirer reclaims it", async () => {
  const dir = path.join(temp(), "leases");
  const pid = deadPid();
  writeSlot(dir, leaseRecord({ pid }));
  const got = await acquireLease(base(dir));
  if (!got.ok) throw new Error(got.reason);
  expect(got.lease.reclaimed).toEqual([
    expect.objectContaining({ pid, cwd: "/repo/other", reason: `holder pid ${pid} is gone` }),
  ]);
  got.lease.release();
});

test("G a live pid but another boot id, T the lease is stale; the same boot id holds", async () => {
  const dir = path.join(temp(), "leases");
  writeSlot(dir, leaseRecord({ bootId: "boot-before" }));
  const held = await acquireLease({ ...base(dir), probe: { boot: "boot-before" } });
  expect(held).toMatchObject({ ok: false, reason: "timeout" });
  const got = await acquireLease({ ...base(dir), probe: { boot: "boot-now" } });
  if (!got.ok) throw new Error(got.reason);
  expect(got.lease.reclaimed[0].reason).toBe("taken before a reboot");
  got.lease.release();
});

test("G a recycled pid (start time differs), T the lease is stale", () => {
  const lease = leaseRecord({ processStart: "100" });
  expect(staleReason(lease, { boot: null, alive: () => true, start: () => "100" })).toBeNull();
  expect(staleReason(lease, { boot: null, alive: () => true, start: () => "999" })).toBe(
    `pid ${process.pid} now belongs to another process`,
  );
});

test("G an unreadable slot file, T it holds while fresh and is reclaimed once old", async () => {
  const dir = path.join(temp(), "leases");
  const file = writeSlot(dir, "{");
  expect(await acquireLease(base(dir))).toMatchObject({ ok: false, reason: "timeout" });
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const got = await acquireLease(base(dir));
  expect(got.ok).toBe(true);
  if (got.ok) got.lease.release();
});

test("G an outer run's WORKIT_LEASE, T heldLease finds it only while it is held in that dir", async () => {
  const dir = path.join(temp(), "leases");
  const got = await acquireLease(base(dir));
  if (!got.ok) throw new Error(got.reason);
  expect(heldLease(dir, got.lease.record.id)?.cwd).toBe("/repo/mine");
  expect(heldLease(path.join(temp(), "leases"), got.lease.record.id)).toBeNull();
  expect(heldLease(dir, "00000000-0000-4000-8000-00000000ffff")).toBeNull();
  got.lease.release();
  expect(heldLease(dir, got.lease.record.id)).toBeNull();
});

test("scope support: no systemd off Linux, without systemd-run, without a user manager, without delegation", () => {
  const bin = temp();
  const runtime = temp();
  writeFileSync(path.join(bin, "systemd-run"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "systemd-run"), 0o755);
  mkdirSync(path.join(runtime, "systemd"));
  const env = { PATH: bin, XDG_RUNTIME_DIR: runtime };
  expect(scopeSupport(env, "darwin")).toEqual({ ok: false, reason: "no systemd scopes on darwin" });
  expect(scopeSupport({ ...env, PATH: temp() }, "linux")).toEqual({
    ok: false,
    reason: "systemd-run is not on PATH",
  });
  expect(scopeSupport(env, "linux", () => "cpu memory")).toEqual({
    ok: false,
    reason: "no user systemd manager is running",
  });
  writeFileSync(path.join(runtime, "systemd", "private"), "");
  expect(scopeSupport(env, "linux", () => null)).toEqual({
    ok: false,
    reason: "cgroup v2 is not mounted for the user manager",
  });
  expect(scopeSupport(env, "linux", () => "cpu pids\n")).toEqual({
    ok: false,
    reason: "the user manager is not delegated memory",
  });
  expect(scopeSupport(env, "linux", () => "cpu memory pids\n")).toEqual({ ok: true });
});

test("G a session told once, T the no-scope notice does not repeat for it but does for another session", () => {
  const env = { WORKFLOW_TOOLKIT_STATE: temp() };
  expect(firstNotice(env, "s-1", "no-scope")).toBe(true);
  expect(firstNotice(env, "s-1", "no-scope")).toBe(false);
  expect(firstNotice(env, "s-2", "no-scope")).toBe(true);
});

/** Does a scope actually start here? (The skip guard for the real systemd path.) */
const probe = scopePrefix(`workit-probe-${process.pid}`, { memoryMax: "1G", cpuQuota: "50%" });
const userSystemd =
  process.platform === "linux" &&
  scopeSupport(process.env).ok &&
  spawnSync(probe[0], [...probe.slice(1), "true"], { stdio: "ignore", timeout: 10_000 }).status ===
    0;

test.skipIf(!userSystemd)(
  "G a delegated user systemd, T the command runs in its own scope with MemoryMax and CPUQuota applied",
  async () => {
    const unit = `workit-check-test-${process.pid}-${Date.now()}`;
    const result = await runCheckCommand(
      [
        "sh",
        "-c",
        'cg=$(cut -d: -f3 /proc/self/cgroup); echo "$cg"; cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/cpu.max"; exit 3',
      ],
      {
        cwd: temp(),
        wrapper: scopePrefix(unit, { memoryMax: "1073741824", cpuQuota: "50%" }),
      },
    );
    expect(result.exitCode).toBe(3);
    const lines = result.log.trim().split("\n");
    expect(lines[0]).toEndWith(`/${unit}.scope`);
    expect(lines.slice(1)).toEqual(["1073741824", "50000 100000"]);
    // A --shell command runs through /bin/sh inside the scope.
    const shell = await runCheckCommand(["cut -d: -f3 /proc/self/cgroup"], {
      cwd: temp(),
      shell: true,
      wrapper: scopePrefix(`${unit}-sh`, { memoryMax: "1G", cpuQuota: "50%" }),
    });
    expect(shell.log.trim()).toEndWith(`/${unit}-sh.scope`);
  },
  20_000,
);
