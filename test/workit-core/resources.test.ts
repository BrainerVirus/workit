import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
  runScoped,
  scopePrefix,
  scopeSupport,
  staleReason,
  updateLease,
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

test("G no resources config, T one slot, test/build heavy, lint/typecheck/format light, a 30 min wait, 40% RAM and 70% of the CPUs", () => {
  const { settings, warnings } = resolveResourceSettings([], HOST);
  expect(warnings).toEqual([]);
  expect(settings).toEqual({
    slots: 1,
    heavy: ["test", "build"],
    light: ["lint", "typecheck", "format"],
    memoryMax: "13743895347",
    cpuQuota: "560%",
    waitMs: 1_800_000,
    scope: true,
  });
});

test("G machine resources, T they set every field, and a bad field keeps the earlier value", () => {
  const { settings, warnings } = resolveResourceSettings(
    [
      {
        label: "workspaces.json",
        trust: "machine",
        value: { heavy: ["test", "e2e"], slots: 3, memoryMax: "8G", cpuQuota: 4, scope: false },
      },
      {
        label: "late",
        trust: "machine",
        value: { slots: 0, memoryMax: "lots", cpuQuota: "150%", heavy: "test" },
      },
    ],
    HOST,
  );
  expect(settings).toEqual({
    slots: 3,
    heavy: ["test", "e2e"],
    light: ["lint", "typecheck", "format"],
    memoryMax: "8589934592",
    cpuQuota: "400%",
    waitMs: 1_800_000,
    scope: false,
  });
  expect(warnings).toHaveLength(4);
  expect(warnings.join("\n")).toContain("late: slots");
  // The design's weight map form names the heavy checks by its keys.
  const one = (value: unknown) =>
    resolveResourceSettings([{ label: "x", trust: "machine", value }], HOST).settings;
  expect(one({ heavy: { build: 1 } }).heavy).toEqual(["build"]);
  expect(one({ cpuQuota: "25%" }).cpuQuota).toBe("200%");
  expect(one({ memoryMax: "50%" }).memoryMax).toBe("17179869184");
});

test("G a repo .workit/checks.json, T it can only tighten the machine's limits: no slots or scope, memory and CPU only lower, heavy only added", () => {
  const repo = {
    label: ".workit/checks.json",
    trust: "repo" as const,
    value: {
      slots: 8,
      scope: false,
      heavy: ["e2e"],
      memoryMax: "90%",
      cpuQuota: "100%",
      wait: 30,
    },
  };
  // Listed before the machine source on purpose: the repo still applies last.
  const { settings, warnings } = resolveResourceSettings(
    [repo, { label: "workspaces.json", trust: "machine", value: { heavy: ["test"] } }],
    HOST,
  );
  expect(settings).toEqual({
    slots: 1,
    heavy: ["test", "e2e"],
    light: ["lint", "typecheck", "format"],
    memoryMax: "13743895347",
    cpuQuota: "560%",
    waitMs: 30_000,
    scope: true,
  });
  expect(warnings.toSorted()).toEqual([
    ".workit/checks.json: cpuQuota: a repo can only lower it",
    ".workit/checks.json: memoryMax: a repo can only lower it",
    ".workit/checks.json: scope: is machine-wide; set it in your workspaces.json, not in the repo",
    ".workit/checks.json: slots: is machine-wide; set it in your workspaces.json, not in the repo",
  ]);
  const lower = resolveResourceSettings(
    [{ ...repo, value: { memoryMax: "4G", cpuQuota: 2 } }],
    HOST,
  ).settings;
  expect([lower.memoryMax, lower.cpuQuota]).toEqual(["4294967296", "200%"]);
});

test("G light checks (#508), T the machine can make a light check heavy or a heavy one light, a repo can make one heavy but never light", () => {
  const resolve = (...sources: Array<["machine" | "repo", unknown]>) =>
    resolveResourceSettings(
      sources.map(([trust, value]) => ({ label: trust, trust, value })),
      HOST,
    );
  const machineHeavy = resolve(["machine", { heavy: ["test", "typecheck"] }]).settings;
  expect([machineHeavy.heavy, machineHeavy.light]).toEqual([
    ["test", "typecheck"],
    ["lint", "format"],
  ]);
  const machineLight = resolve(["machine", { light: ["build", "lint"] }]).settings;
  expect([machineLight.heavy, machineLight.light]).toEqual([["test"], ["build", "lint"]]);
  const repoHeavy = resolve(["repo", { heavy: ["typecheck"] }]).settings;
  expect([repoHeavy.heavy, repoHeavy.light]).toEqual([
    ["test", "build", "typecheck"],
    ["lint", "format"],
  ]);
  const repoLight = resolve(["repo", { light: ["test"] }]);
  expect(repoLight.settings.heavy).toEqual(["test", "build"]);
  expect(repoLight.warnings).toEqual([
    "repo: light: is machine-wide; set it in your workspaces.json, not in the repo",
  ]);
  expect(resolve(["machine", { wait: "45m" }]).settings.waitMs).toBe(2_700_000);
  expect(resolve(["machine", { wait: "soon" }]).warnings).toHaveLength(1);
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

// Review mv812c6d: SIGKILL overlap, non-Linux reclaim, forged WORKIT_LEASE, mutants.

test("G workit is gone but its check's process group or scope still runs, T the lease holds; once both are gone it is stale", () => {
  const lease = leaseRecord({ pid: 4242, pgid: 4343, scope: "workit-check-x-1.scope" });
  const gone = { boot: null, alive: () => false };
  expect(
    staleReason(lease, { ...gone, group: (pgid) => pgid === 4343, scope: () => false }),
  ).toBeNull();
  expect(
    staleReason(lease, {
      ...gone,
      group: () => false,
      scope: (unit) => unit === "workit-check-x-1.scope",
    }),
  ).toBeNull();
  expect(staleReason(lease, { ...gone, group: () => false, scope: () => false })).toBe(
    "holder pid 4242 is gone",
  );
});

test.skipIf(process.platform === "win32")(
  "G a real orphaned process group recorded on the lease, T a second acquirer waits until the group exits",
  async () => {
    const dir = path.join(temp(), "leases");
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      writeSlot(dir, leaseRecord({ pid: deadPid(), pgid: orphan.pid }));
      expect(await acquireLease(base(dir))).toMatchObject({ ok: false, reason: "timeout" });
    } finally {
      process.kill(-orphan.pid!, "SIGKILL");
    }
    await new Promise((resolve) => orphan.on("exit", resolve));
    const got = await acquireLease({ ...base(dir), waitMs: 2000 });
    expect(got.ok).toBe(true);
    if (got.ok) got.lease.release();
  },
);

test("G no boot id and no process start (macOS, Windows), T a boot time that moved means a reboot, and the age bound ends an unverifiable lease", () => {
  const boot = 1_760_000_000_000;
  const lease = leaseRecord({ bootTime: boot, maxAgeMs: 60_000 });
  const noProc = {
    boot: null,
    alive: () => true,
    start: () => null,
    now: Date.parse(lease.startedAt) + 1000,
  };
  expect(staleReason(lease, { ...noProc, bootTime: boot + 30_000 })).toBeNull();
  expect(staleReason(lease, { ...noProc, bootTime: boot + 3_600_000 })).toBe(
    "taken before a reboot",
  );
  expect(
    staleReason(lease, { ...noProc, bootTime: boot, now: Date.parse(lease.startedAt) + 61_000 }),
  ).toBe("older than its 60 s bound");
  // A holder whose start time verifies is never aged out.
  const verified = { ...lease, processStart: "100" };
  expect(
    staleReason(verified, {
      ...noProc,
      start: () => "100",
      bootTime: boot,
      now: Date.parse(lease.startedAt) + 61_000,
    }),
  ).toBeNull();
});

test("G a WORKIT_LEASE naming a stale lease or one held by an unrelated process, T heldLease refuses it", async () => {
  const dir = path.join(temp(), "leases");
  const stale = leaseRecord({ id: "00000000-0000-4000-8000-0000000000d1", pid: deadPid() });
  writeSlot(dir, stale);
  // Even when its pid passed the ancestor test, a dead holder is no lease to reuse.
  expect(heldLease(dir, stale.id, { ancestor: () => true })).toBeNull();
  const live = leaseRecord({ id: "00000000-0000-4000-8000-0000000000d2" });
  writeSlot(dir, live, 1);
  expect(heldLease(dir, live.id)?.id).toBe(live.id);
  expect(heldLease(dir, live.id, { ancestor: () => false })).toBeNull();
});

test.skipIf(process.platform !== "linux")(
  "G a live lease held by a process that is not an ancestor, T heldLease refuses it on Linux",
  async () => {
    const dir = path.join(temp(), "leases");
    const sibling = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const lease = leaseRecord({ id: "00000000-0000-4000-8000-0000000000d3", pid: sibling.pid! });
      writeSlot(dir, lease);
      expect(heldLease(dir, lease.id)).toBeNull();
    } finally {
      sibling.kill("SIGKILL");
    }
  },
);

test("G a slot reclaimed and retaken by another holder, T release and updateLease leave it alone", async () => {
  const dir = path.join(temp(), "leases");
  const got = await acquireLease(base(dir));
  if (!got.ok) throw new Error(got.reason);
  updateLease(got.lease, { scope: "workit-check-ab-1.scope", pgid: 777 });
  expect(JSON.parse(readFileSync(got.lease.file, "utf8"))).toMatchObject({
    id: got.lease.record.id,
    scope: "workit-check-ab-1.scope",
    pgid: 777,
  });
  const other = leaseRecord({ id: "00000000-0000-4000-8000-0000000000e1" });
  writeSlot(dir, other);
  updateLease(got.lease, { pgid: 778 });
  got.lease.release();
  expect(JSON.parse(readFileSync(got.lease.file, "utf8"))).toEqual(other);
});

test("G notice markers older than a week, T a new notice prunes them", () => {
  const state = temp();
  const env = { WORKFLOW_TOOLKIT_STATE: state };
  expect(firstNotice(env, "s-old", "no-scope")).toBe(true);
  const old = path.join(state, "notices", "no-scope-s-old");
  const week = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(old, week, week);
  expect(firstNotice(env, "s-new", "no-scope")).toBe(true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(path.join(state, "notices", "no-scope-s-new"))).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "G systemd-run fails before the command runs, T the command runs unscoped and systemd-run's line never reaches the output; a command's own failure passes through",
  async () => {
    const bin = temp();
    const failing = path.join(bin, "systemd-run-broken");
    writeFileSync(
      failing,
      "#!/bin/sh\necho 'Failed to connect to bus: No such file or directory' >&2\nexit 1\n",
    );
    const passing = path.join(bin, "systemd-run-ok");
    writeFileSync(passing, '#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(failing, 0o755);
    chmodSync(passing, 0o755);
    const cwd = temp();
    const runWith =
      (argv: string[]) =>
      (
        wrapper: readonly string[] | null,
        sinks: { onStdout: (t: string) => void; onStderr: (t: string) => void },
      ) =>
        runCheckCommand(argv, { cwd, ...sinks, ...(wrapper ? { wrapper } : {}) });
    let seen = "";
    const sinks = {
      onStdout: (t: string) => void (seen += t),
      onStderr: (t: string) => void (seen += t),
    };
    const ran = await runScoped(runWith(["sh", "-c", "echo ran"]), [failing, "--"], sinks);
    expect(ran.fallback).toBe("Failed to connect to bus: No such file or directory");
    expect([ran.result.exitCode, ran.result.log.trim(), seen.trim()]).toEqual([0, "ran", "ran"]);
    seen = "";
    const own = await runScoped(
      runWith(["sh", "-c", "echo 'Failed to parse X=1' >&2; echo second >&2; exit 2"]),
      [passing, "--"],
      sinks,
    );
    expect(own.fallback).toBeNull();
    expect(own.result.exitCode).toBe(2);
    expect(seen).toBe("Failed to parse X=1\nsecond\n");
  },
);
