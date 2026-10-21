// Host resources for heavy checks (issue #282, slice 1): a machine-wide lease
// serializes heavy `workit check` runs across every agent and worktree, and on
// Linux with a delegated user systemd each heavy run gets its own
// `systemd-run --user --scope` with MemoryMax and CPUQuota, so parallel agents
// cannot push the desktop session into systemd-oomd.
//
// The lease is a set of slot files, `<state>/leases/slot-<n>.json`, created
// with O_EXCL: holding one is holding the lease. A slot is held while its
// workit process runs or, after workit is killed, while the check's process
// group or scope still has processes. It is stale, and reclaimed by the next
// acquirer under a short mkdir guard, once those are gone, after a reboot, or
// (where the holder cannot be identified) past its age bound.
//
// Settings: built-in defaults (derived from total RAM and CPUs), then
// `resources` in the matching workspaces.json entry (the machine owner's
// word), then `resources` in workit.checks.json, which can only tighten them.
// Only the CLI imports this module; hooks never do.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailLines, type CheckRun } from "../checks";
import { stateDir } from "./heavy";

export { stateDir };

/** Named checks that take the lease when nothing is configured. */
export const DEFAULT_HEAVY_CHECKS = ["test", "build", "typecheck"];
const DEFAULT_SLOTS = 1;
const DEFAULT_WAIT_S = 600;
const DEFAULT_MEMORY_SHARE = 0.4;
const DEFAULT_CPU_SHARE = 0.7;
const MAX_SLOTS = 64;
/** A slot file nobody could parse is a writer mid-create; after this it is debris. */
const UNREADABLE_TTL_MS = 30_000;
/** A reclaim guard lives for microseconds; one older than this was abandoned. */
const GUARD_TTL_MS = 30_000;

export type ResourceSettings = {
  /** How many heavy checks may run at once on this machine. */
  slots: number;
  /** Named checks that are heavy. */
  heavy: string[];
  /** systemd MemoryMax for a heavy check's scope, in bytes. */
  memoryMax: string;
  /** systemd CPUQuota for a heavy check's scope (percent of one CPU). */
  cpuQuota: string;
  /** How long a heavy check waits for the lease before giving up. */
  waitMs: number;
  /** False turns the systemd scope off (the lease still applies). */
  scope: boolean;
};

export type HostShape = { totalMemBytes: number; cpus: number };

export const hostShape = (): HostShape => ({
  totalMemBytes: os.totalmem(),
  cpus: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SIZE = /^(\d+(?:\.\d+)?)([KMGT]?)$/iu;
const PERCENT = /^(\d+(?:\.\d+)?)%$/u;
const UNITS: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** "40%" of total RAM, or a size ("8G", "8589934592"), as MemoryMax bytes. */
function memoryValue(value: unknown, host: HostShape): number | Error {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const percent = PERCENT.exec(text.trim());
  if (percent) {
    const share = Number(percent[1]);
    if (share <= 0 || share > 100) return new Error(`memoryMax ${text} must be 1-100%`);
    return Math.floor((host.totalMemBytes * share) / 100);
  }
  const size = SIZE.exec(text.trim());
  if (size && Number(size[1]) > 0)
    return Math.floor(Number(size[1]) * UNITS[size[2].toUpperCase()]);
  return new Error(`memoryMax must be a percent of RAM ("40%") or a size ("8G"), got ${text}`);
}

/** "70%" of the whole machine, or a CPU count (4 → 400), as CPUQuota percent of one CPU. */
function cpuValue(value: unknown, host: HostShape): number | Error {
  if (typeof value === "number" && value > 0) return Math.round(value * 100);
  const percent = typeof value === "string" ? PERCENT.exec(value.trim()) : null;
  if (percent) {
    const share = Number(percent[1]);
    if (share <= 0 || share > 100) return new Error(`cpuQuota ${percent[0]} must be 1-100%`);
    return Math.max(1, Math.round(host.cpus * share));
  }
  return new Error(
    `cpuQuota must be a percent of the machine ("70%") or a CPU count, got ${String(value)}`,
  );
}

/**
 * Where a `resources` block comes from. `machine` (the user's workspaces.json)
 * sets anything. `repo` (a committed workit.checks.json) can only tighten: it
 * adds heavy checks, lowers memoryMax and cpuQuota, and sets its own wait; it
 * cannot raise the machine's slots or turn the scope off.
 */
export type ResourceSource = { label: string; trust: "machine" | "repo"; value: unknown };

/**
 * Merge `resources` blocks over the defaults, machine sources before repo
 * ones. Lenient: an invalid or refused field is reported and the earlier
 * value kept, so a typo never turns the lease off.
 */
export function resolveResourceSettings(
  sources: ResourceSource[],
  host: HostShape = hostShape(),
): { settings: ResourceSettings; warnings: string[] } {
  let memory = Math.floor(host.totalMemBytes * DEFAULT_MEMORY_SHARE);
  let cpu = Math.max(1, Math.round(host.cpus * DEFAULT_CPU_SHARE * 100));
  const settings: ResourceSettings = {
    slots: DEFAULT_SLOTS,
    heavy: [...DEFAULT_HEAVY_CHECKS],
    memoryMax: "",
    cpuQuota: "",
    waitMs: DEFAULT_WAIT_S * 1000,
    scope: true,
  };
  const warnings: string[] = [];
  const ordered = [
    ...sources.filter((source) => source.trust === "machine"),
    ...sources.filter((source) => source.trust === "repo"),
  ];
  for (const { label, trust, value } of ordered) {
    if (value === undefined || value === null) continue;
    if (!isRecord(value)) {
      warnings.push(`${label}: resources must be an object`);
      continue;
    }
    const repo = trust === "repo";
    const warn = (field: string, message: string) =>
      warnings.push(`${label}: ${field}: ${message}`);
    const machineOnly = (field: string) =>
      warn(field, "is machine-wide; set it in your workspaces.json, not in the repo");
    if (value.slots !== undefined) {
      const slots = value.slots;
      if (repo) machineOnly("slots");
      else if (
        typeof slots === "number" &&
        Number.isInteger(slots) &&
        slots >= 1 &&
        slots <= MAX_SLOTS
      )
        settings.slots = slots;
      else warn("slots", `must be an integer 1-${MAX_SLOTS}`);
    }
    if (value.scope !== undefined) {
      if (repo) machineOnly("scope");
      else if (typeof value.scope === "boolean") settings.scope = value.scope;
      else warn("scope", "must be true or false");
    }
    if (value.heavy !== undefined) {
      const heavy = isRecord(value.heavy) ? Object.keys(value.heavy) : value.heavy;
      if (!Array.isArray(heavy) || !heavy.every((item) => typeof item === "string"))
        warn("heavy", "must be a list of check names");
      // A repo adds heavy checks; it never makes the machine's heavy ones light.
      else settings.heavy = repo ? [...new Set([...settings.heavy, ...heavy])] : heavy;
    }
    if (value.memoryMax !== undefined) {
      const next = memoryValue(value.memoryMax, host);
      if (next instanceof Error) warn("memoryMax", next.message);
      else if (repo && next > memory) warn("memoryMax", "a repo can only lower it");
      else memory = next;
    }
    if (value.cpuQuota !== undefined) {
      const next = cpuValue(value.cpuQuota, host);
      if (next instanceof Error) warn("cpuQuota", next.message);
      else if (repo && next > cpu) warn("cpuQuota", "a repo can only lower it");
      else cpu = next;
    }
    if (value.wait !== undefined) {
      if (typeof value.wait === "number" && value.wait >= 0) settings.waitMs = value.wait * 1000;
      else warn("wait", "must be a number of seconds");
    }
  }
  settings.memoryMax = String(memory);
  settings.cpuQuota = `${cpu}%`;
  return { settings, warnings };
}

// ---------------------------------------------------------------------------
// the machine lease

export const leaseDir = (env: NodeJS.ProcessEnv): string => path.join(stateDir(env), "leases");

export type LeaseRecord = {
  id: string;
  /** The workit process that took the lease. */
  pid: number;
  /** Field 22 of /proc/<pid>/stat, so a recycled pid does not keep a lease alive. */
  processStart: string | null;
  /** The kernel boot id (Linux). */
  bootId: string | null;
  /** Boot time in ms, where there is no boot id (macOS, Windows). */
  bootTime?: number | null;
  /** The check's process group: it outlives a SIGKILLed workit. */
  pgid?: number | null;
  /** Past this age a lease whose holder cannot be identified (no processStart) is stale. */
  maxAgeMs?: number | null;
  check: string;
  cwd: string;
  session: string | null;
  startedAt: string;
  /** The check's systemd scope unit; it holds the lease while it has processes. */
  scope: string | null;
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The kernel boot id (Linux), so a lease from before a reboot is stale. */
export const bootId = (): string | null =>
  readText("/proc/sys/kernel/random/boot_id")?.trim() || null;

/** When the machine booted (ms), for platforms without a boot id. */
const bootTime = (): number => Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000;
/** Clock steps and uptime rounding move the computed boot time; a reboot moves it far more. */
const BOOT_SLACK_MS = 120_000;

/** The fields of /proc/<pid>/stat after the comm, so a comm with spaces cannot shift them. */
const statFields = (pid: number): string[] | null => {
  const stat = readText(`/proc/${pid}/stat`);
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ") : null;
};

/** Start time of `pid` (Linux). */
export const processStart = (pid: number): string | null => statFields(pid)?.[19] ?? null;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Does process group `pgid` still have members? (Windows: is the process alive.) */
const groupAlive = (pgid: number): boolean =>
  process.platform === "win32" ? pidAlive(pgid) : pidAlive(-pgid);

const SCOPE_UNIT = /^[\w.@-]+\.scope$/u;

/** Does the user scope `unit` still hold processes? */
function scopeBusy(unit: string): boolean {
  if (process.platform !== "linux" || !SCOPE_UNIT.test(unit)) return false;
  const uid = process.getuid?.() ?? 0;
  const manager = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
  return [`${manager}/app.slice/${unit}`, `${manager}/${unit}`].some(
    (dir) => (readText(`${dir}/cgroup.procs`) ?? "").trim() !== "",
  );
}

/**
 * Is `pid` this process or one of its ancestors? Walks the ppid chain on
 * Linux; elsewhere there is no cheap chain, so it answers true.
 */
function isAncestor(pid: number): boolean {
  if (process.platform !== "linux") return true;
  let current = process.pid;
  for (let step = 0; step < 128 && current > 1; step += 1) {
    if (current === pid) return true;
    const ppid = Number(statFields(current)?.[1]);
    if (!Number.isInteger(ppid) || ppid <= 0) return false;
    current = ppid;
  }
  return current === pid;
}

const parseLease = (text: string | null): LeaseRecord | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && typeof value.id === "string" && typeof value.pid === "number"
      ? (value as LeaseRecord)
      : null;
  } catch {
    return null;
  }
};

export type LeaseProbe = {
  alive?: (pid: number) => boolean;
  boot?: string | null;
  bootTime?: number | null;
  start?: (pid: number) => string | null;
  group?: (pgid: number) => boolean;
  scope?: (unit: string) => boolean;
  now?: number;
};

/**
 * Why `lease` no longer holds anything, or null while it does. It holds while
 * its workit process runs, or, once that is gone (a SIGKILL), while the
 * check's process group or scope still has processes. A lease from before a
 * reboot, or one past its age bound whose holder cannot be identified, is
 * stale either way.
 */
export function staleReason(lease: LeaseRecord, probe: LeaseProbe = {}): string | null {
  const boot = probe.boot === undefined ? bootId() : probe.boot;
  if (lease.bootId && boot) {
    if (lease.bootId !== boot) return "taken before a reboot";
  } else if (typeof lease.bootTime === "number") {
    const now = probe.bootTime === undefined ? bootTime() : probe.bootTime;
    if (now !== null && Math.abs(now - lease.bootTime) > BOOT_SLACK_MS)
      return "taken before a reboot";
  }
  const start = lease.processStart ? (probe.start ?? processStart)(lease.pid) : null;
  const age = (probe.now ?? Date.now()) - Date.parse(lease.startedAt);
  if (!start && typeof lease.maxAgeMs === "number" && age > lease.maxAgeMs)
    return `older than its ${Math.round(lease.maxAgeMs / 1000)} s bound`;
  const holder = !(probe.alive ?? pidAlive)(lease.pid)
    ? `holder pid ${lease.pid} is gone`
    : start && start !== lease.processStart
      ? `pid ${lease.pid} now belongs to another process`
      : null;
  if (!holder) return null;
  // workit is gone, but the check it started may still run.
  if (typeof lease.pgid === "number" && lease.pgid > 0 && (probe.group ?? groupAlive)(lease.pgid))
    return null;
  if (lease.scope && (probe.scope ?? scopeBusy)(lease.scope)) return null;
  return holder;
}

export type LeaseHolder = Pick<LeaseRecord, "pid" | "check" | "cwd" | "session" | "startedAt">;

const holderOf = (lease: LeaseRecord): LeaseHolder => ({
  pid: lease.pid,
  check: lease.check,
  cwd: lease.cwd,
  session: lease.session,
  startedAt: lease.startedAt,
});

/** Remove a stale slot under a mkdir guard, re-checking it inside so a fresh holder is never removed. */
function reclaim(file: string, stale: (lease: LeaseRecord | null, ageMs: number) => boolean) {
  const guard = `${file}.reclaim`;
  try {
    fs.mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_TTL_MS)
        fs.rmSync(guard, { force: true, recursive: true });
    } catch {
      // Gone already.
    }
    return false;
  }
  try {
    let ageMs = 0;
    try {
      ageMs = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      return true;
    }
    if (!stale(parseLease(readText(file)), ageMs)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } finally {
    fs.rmSync(guard, { force: true, recursive: true });
  }
}

export type HeldLease = {
  record: LeaseRecord;
  slot: number;
  file: string;
  /** Holders seen while waiting (empty when the lease was free). */
  waitedOn: LeaseHolder[];
  waitedMs: number;
  /** Stale leases reclaimed on the way, with the reason. */
  reclaimed: Array<LeaseHolder & { reason: string }>;
  release: () => void;
};

export type AcquireOptions = {
  dir: string;
  slots: number;
  check: string;
  cwd: string;
  session: string | null;
  waitMs: number;
  pollMs?: number;
  /** The age bound recorded on the lease (see LeaseRecord.maxAgeMs). */
  maxAgeMs?: number;
  /** Called once, when the first attempt finds every slot held. */
  onWait?: (holders: LeaseHolder[]) => void;
  /** Overrides for tests. */
  probe?: LeaseProbe;
  pid?: number;
};

export type AcquireResult =
  | { ok: true; lease: HeldLease }
  | { ok: false; reason: "timeout"; holders: LeaseHolder[]; waitedMs: number }
  | { ok: false; reason: "unavailable"; error: string };

/** One pass over the slots: the slot taken, or the live holders. */
function tryOnce(
  options: AcquireOptions,
  record: LeaseRecord,
  reclaimed: HeldLease["reclaimed"],
): { slot: number; file: string } | { holders: LeaseHolder[] } {
  const holders: LeaseHolder[] = [];
  const text = `${JSON.stringify(record)}\n`;
  for (let slot = 0; slot < options.slots; slot += 1) {
    const file = path.join(options.dir, `slot-${slot}.json`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeSync(fd, text);
        } finally {
          fs.closeSync(fd);
        }
        return { slot, file };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const lease = parseLease(readText(file));
      let reason: string | null = null;
      const removed = reclaim(file, (current, ageMs) => {
        reason = current
          ? staleReason(current, options.probe)
          : ageMs > UNREADABLE_TTL_MS
            ? "unreadable"
            : null;
        return reason !== null;
      });
      if (removed) {
        if (lease && reason) reclaimed.push({ ...holderOf(lease), reason });
        continue;
      }
      if (lease) holders.push(holderOf(lease));
      break;
    }
  }
  return { holders };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove `file` only while it still holds lease `id`: a reclaimed and retaken slot is someone else's. */
function removeOwn(file: string, id: string): void {
  if (parseLease(readText(file))?.id === id) fs.rmSync(file, { force: true });
}

/**
 * Take one of `slots` machine-wide lease slots, waiting (polling every
 * `pollMs`) up to `waitMs` for a live holder to finish. The returned lease is
 * released by `release()`, and on process exit as a backstop.
 */
export async function acquireLease(options: AcquireOptions): Promise<AcquireResult> {
  const pid = options.pid ?? process.pid;
  const boot = bootId();
  const record: LeaseRecord = {
    id: randomUUID(),
    pid,
    processStart: processStart(pid),
    bootId: boot,
    bootTime: boot ? null : bootTime(),
    pgid: null,
    maxAgeMs: options.maxAgeMs ?? null,
    check: options.check,
    cwd: options.cwd,
    session: options.session,
    startedAt: new Date().toISOString(),
    scope: null,
  };
  try {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "unavailable", error: (error as Error).message };
  }
  const started = Date.now();
  const reclaimed: HeldLease["reclaimed"] = [];
  let waitedOn: LeaseHolder[] = [];
  for (;;) {
    let outcome: ReturnType<typeof tryOnce>;
    try {
      outcome = tryOnce(options, record, reclaimed);
    } catch (error) {
      return { ok: false, reason: "unavailable", error: (error as Error).message };
    }
    if ("slot" in outcome) {
      const { file, slot } = outcome;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        removeOwn(file, record.id);
      };
      process.on("exit", release);
      return {
        ok: true,
        lease: {
          record,
          slot,
          file,
          waitedOn,
          waitedMs: waitedOn.length ? Date.now() - started : 0,
          reclaimed,
          release,
        },
      };
    }
    const waited = Date.now() - started;
    if (!waitedOn.length) {
      waitedOn = outcome.holders;
      options.onWait?.(outcome.holders);
    }
    if (waited >= options.waitMs)
      return { ok: false, reason: "timeout", holders: outcome.holders, waitedMs: waited };
    await sleep(Math.min(options.pollMs ?? 2000, Math.max(1, options.waitMs - waited)));
  }
}

/**
 * Record the check's scope unit or process group on a held lease, so the lease
 * stays held while they run, even if workit itself is killed. Never writes
 * over a slot that is no longer this lease's.
 */
export function updateLease(lease: HeldLease, patch: Pick<Partial<LeaseRecord>, "scope" | "pgid">) {
  Object.assign(lease.record, patch);
  try {
    if (parseLease(readText(lease.file))?.id !== lease.record.id) return;
    const temp = `${lease.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(lease.record)}\n`, { mode: 0o600 });
    fs.renameSync(temp, lease.file);
  } catch {
    // The lease still holds; only the note is missing.
  }
}

/**
 * The lease an outer heavy check passed down as WORKIT_LEASE, when it is held
 * in `dir` by this process or one of its ancestors. A nested heavy check
 * reuses it instead of queueing behind its own parent; a leaked or forged id
 * from an unrelated process is ignored.
 */
export function heldLease(
  dir: string,
  id: string | undefined,
  options: { probe?: LeaseProbe; ancestor?: (pid: number) => boolean } = {},
): LeaseRecord | null {
  if (!id || !/^[0-9a-f-]{36}$/u.test(id)) return null;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^slot-\d+\.json$/u.test(name)) continue;
    const lease = parseLease(readText(path.join(dir, name)));
    if (
      lease?.id === id &&
      !staleReason(lease, options.probe) &&
      (options.ancestor ?? isAncestor)(lease.pid)
    )
      return lease;
  }
  return null;
}
/** "test, pid 123, 1m 40s, /repo/wt" for a waiting or timeout message. */
export function describeHolder(holder: LeaseHolder, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(holder.startedAt)) / 1000));
  const age = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return `${holder.check}, pid ${holder.pid}${holder.session ? `, session ${holder.session}` : ""}, ${age}, ${holder.cwd}`;
}

// ---------------------------------------------------------------------------
// the systemd user scope

export type ScopeSupport = { ok: true } | { ok: false; reason: string };

const onPath = (command: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

/**
 * Can heavy checks run in their own `systemd-run --user --scope`? Needs Linux,
 * `systemd-run` on PATH, a running user manager, and the memory and cpu
 * controllers delegated to it (cgroup v2).
 */
export function scopeSupport(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  read: (file: string) => string | null = readText,
): ScopeSupport {
  if (platform !== "linux") return { ok: false, reason: `no systemd scopes on ${platform}` };
  if (!onPath("systemd-run", env)) return { ok: false, reason: "systemd-run is not on PATH" };
  const uid = process.getuid?.() ?? 0;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!fs.existsSync(path.join(runtime, "systemd", "private")))
    return { ok: false, reason: "no user systemd manager is running" };
  const controllers = read(
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
  );
  if (controllers === null)
    return { ok: false, reason: "cgroup v2 is not mounted for the user manager" };
  const missing = ["memory", "cpu"].filter((name) => !controllers.split(/\s+/u).includes(name));
  if (missing.length)
    return { ok: false, reason: `the user manager is not delegated ${missing.join(" and ")}` };
  return { ok: true };
}

/** The `systemd-run` prefix that runs a command in its own limited scope. */
export function scopePrefix(
  unit: string,
  settings: Pick<ResourceSettings, "memoryMax" | "cpuQuota">,
) {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    "-p",
    `MemoryMax=${settings.memoryMax}`,
    "-p",
    `CPUQuota=${settings.cpuQuota}`,
    "--",
  ];
}

/** systemd-run's own failure before it ran the command (bus, unit, property). */
const SCOPE_START_FAILURE =
  /^Failed to (?:connect to bus|create bus connection|start transient scope unit|parse \S+?=)/u;

type Sinks = { onStdout: (text: string) => void; onStderr: (text: string) => void };

/**
 * Run a command in its scope, and plainly when systemd-run itself failed
 * before the command ran (one "Failed to …" line, non-zero exit). The scoped
 * attempt's first stderr line is held back until it is known not to be that
 * failure, so the caller never sees systemd-run's line on a fallback.
 * `fallback` is that line when the command ran unscoped.
 */
export async function runScoped(
  run: (wrapper: readonly string[] | null, sinks: Sinks) => Promise<CheckRun>,
  wrapper: readonly string[] | null,
  sinks: Sinks,
): Promise<{ result: CheckRun; fallback: string | null }> {
  if (!wrapper) return { result: await run(null, sinks), fallback: null };
  let state = "deciding" as "deciding" | "passing" | "held";
  let firstLine = "";
  const held: Array<[keyof Sinks, string]> = [];
  const flush = () => {
    state = "passing";
    for (const [sink, text] of held.splice(0)) sinks[sink](text);
  };
  const result = await run(wrapper, {
    onStdout: (text) => {
      if (state === "passing") return sinks.onStdout(text);
      held.push(["onStdout", text]);
      // systemd-run writes only to stderr: stdout means the command runs.
      if (state === "deciding") flush();
    },
    onStderr: (text) => {
      if (state === "passing") return sinks.onStderr(text);
      held.push(["onStderr", text]);
      if (state === "held") return;
      firstLine += text;
      const newline = firstLine.indexOf("\n");
      if (newline < 0 && firstLine.length < 4096) return;
      if (SCOPE_START_FAILURE.test(firstLine.slice(0, newline < 0 ? undefined : newline)))
        state = "held";
      else flush();
    },
  });
  const lines = tailLines(result.log, 2);
  if (
    state !== "passing" &&
    result.exitCode !== 0 &&
    lines.length === 1 &&
    SCOPE_START_FAILURE.test(lines[0])
  )
    return { result: await run(null, sinks), fallback: lines[0] };
  flush();
  return { result, fallback: null };
}

/** Notice markers older than this are pruned. */
const NOTICE_TTL_MS = 7 * 86_400_000;

/**
 * Should the "no scope" notice print? Once per session: a marker under the
 * state dir records that this session was told. Markers older than a week
 * are pruned when a new one is written.
 */
export function firstNotice(
  env: NodeJS.ProcessEnv,
  session: string | null,
  key: string,
  now = Date.now(),
): boolean {
  const id = (session ?? `ppid-${process.ppid}`).replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  const dir = path.join(stateDir(env), "notices");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${key}-${id}`), `${new Date(now).toISOString()}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EEXIST";
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > NOTICE_TTL_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // Pruning is best effort.
  }
  return true;
}

export type SlotState = {
  slot: number;
  /** The lease in this slot, or null when it is free. */
  holder: LeaseHolder | null;
  /** Why the lease in it no longer holds (the next acquirer reclaims it). */
  stale: string | null;
};

/** What each of `slots` lease slots holds right now. Read-only: nothing is reclaimed. */
export function leaseSlots(dir: string, slots: number, probe: LeaseProbe = {}): SlotState[] {
  const states: SlotState[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const lease = parseLease(readText(path.join(dir, `slot-${slot}.json`)));
    states.push({
      slot,
      holder: lease ? holderOf(lease) : null,
      stale: lease ? staleReason(lease, probe) : null,
    });
  }
  return states;
}

export type ScopeProbe =
  | { effective: true; memoryMax: string; cpuMax: string; delegate: string | null }
  | { effective: false; supported: boolean; reason: string; delegate: string | null };

const PROBE_MEMORY = "268435456";
const PROBE_CPU = "50%";
const PROBE_SCRIPT =
  'cg=$(sed -n "s/^0:://p" /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max" "/sys/fs/cgroup$cg/cpu.max"';

/** `Delegate=` and `DelegateControllers=` of the user manager's unit, as systemd reports them. */
function userManagerDelegate(env: NodeJS.ProcessEnv): string | null {
  const uid = process.getuid?.() ?? 0;
  const shown = spawnSync(
    "systemctl",
    ["show", `user@${uid}.service`, "-p", "Delegate", "-p", "DelegateControllers"],
    { env, encoding: "utf8", timeout: 5000 },
  );
  const text = shown.status === 0 ? shown.stdout.trim().split(/\n/u).join(", ") : "";
  return text || null;
}

/**
 * Do heavy-check scopes really get their limits here? Starts a throwaway
 * scope the way a heavy check does (MemoryMax 256 MiB, CPUQuota 50%) and
 * reads the limits back from its own cgroup, so a manager that accepts the
 * properties but cannot apply them (no delegation) is told apart.
 */
export function probeScope(env: NodeJS.ProcessEnv = process.env): ScopeProbe {
  const support = scopeSupport(env);
  const delegate = process.platform === "linux" ? userManagerDelegate(env) : null;
  if (!support.ok) return { effective: false, supported: false, reason: support.reason, delegate };
  const unit = `workit-probe-${process.pid}-${Date.now().toString(36)}`;
  // The same `systemd-run …` prefix a heavy check runs under.
  const [runner, ...prefix] = scopePrefix(unit, { memoryMax: PROBE_MEMORY, cpuQuota: PROBE_CPU });
  const probe = spawnSync(runner, [...prefix, "sh", "-c", PROBE_SCRIPT], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0)
    return {
      effective: false,
      supported: true,
      reason: `systemd-run failed: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().split("\n")[0]}`,
      delegate,
    };
  const [memoryMax = "", cpuMax = ""] = probe.stdout.trim().split(/\n/u);
  if (memoryMax.trim() === PROBE_MEMORY && cpuMax.trim().startsWith("50000 "))
    return { effective: true, memoryMax: memoryMax.trim(), cpuMax: cpuMax.trim(), delegate };
  return {
    effective: false,
    supported: true,
    reason: `the scope started but its cgroup reads memory.max=${memoryMax.trim() || "?"} cpu.max=${cpuMax.trim() || "?"} (asked ${PROBE_MEMORY} and 50000 100000)`,
    delegate,
  };
}
