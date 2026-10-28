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
// word), then `resources` in .workit/checks.json, which can only tighten them.
// Only the CLI imports this module; hooks never do.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailLines, type CheckRun } from "../checks";
import { stateDir } from "./heavy";

export { stateDir };
export {
  probeScope,
  scopePrefix,
  scopeSupport,
  type ScopeProbe,
  type ScopeSupport,
} from "./heavy-scope";

/** Named checks that take the lease when nothing is configured. */
export const DEFAULT_HEAVY_CHECKS = ["test", "build"];
/**
 * Named checks that never take the lease unless the machine lists them heavy:
 * they finish in seconds, so they must not queue behind a 10-minute suite (#508).
 */
export const DEFAULT_LIGHT_CHECKS = ["lint", "typecheck", "format"];
const DEFAULT_SLOTS = 1;
/** A queued heavy check waits its turn this long by default (#508). */
const DEFAULT_WAIT_S = 1800;
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
  /** Named checks that never take the lease (disjoint from `heavy`). */
  light: string[];
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
 * sets anything. `repo` (the repo's .workit/checks.json) can only tighten: it
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
    light: [...DEFAULT_LIGHT_CHECKS],
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
      else {
        settings.heavy = repo ? [...new Set([...settings.heavy, ...heavy])] : heavy;
        settings.light = settings.light.filter((name) => !heavy.includes(name));
      }
    }
    if (value.light !== undefined) {
      const light = value.light;
      // Exempting a check from the lease loosens it: the machine owner's word only.
      if (repo) machineOnly("light");
      else if (!Array.isArray(light) || !light.every((item) => typeof item === "string"))
        warn("light", "must be a list of check names");
      else {
        settings.light = light;
        settings.heavy = settings.heavy.filter((name) => !light.includes(name));
      }
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
      const wait =
        typeof value.wait === "number"
          ? value.wait >= 0
            ? value.wait * 1000
            : null
          : typeof value.wait === "string"
            ? parseWait(value.wait)
            : null;
      if (wait !== null) settings.waitMs = wait;
      else warn("wait", 'must be a number of seconds or a duration ("30m")');
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
  /** Called when the wait starts and every `statusEveryMs` after (default 30 s). */
  onStatus?: (status: QueueStatus) => void;
  statusEveryMs?: number;
  /** Overrides for tests. */
  probe?: LeaseProbe;
  pid?: number;
  clock?: Clock;
};

/** Where a waiter stands: 1 is next in line. */
export type QueueStatus = {
  position: number;
  /** Live waiters ahead of this one. */
  ahead: number;
  /** The live holders of the slots. */
  holders: LeaseHolder[];
  waitedMs: number;
  /** The first report of this wait (whatever time has already passed). */
  first: boolean;
};

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export type AcquireResult =
  | { ok: true; lease: HeldLease }
  | {
      ok: false;
      reason: "timeout";
      holders: LeaseHolder[];
      waitedMs: number;
      /** Where this waiter stood when it gave up. */
      position: number;
    }
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

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Remove `file` only while it still holds lease `id`: a reclaimed and retaken slot is someone else's. */
function removeOwn(file: string, id: string): void {
  if (parseLease(readText(file))?.id === id) fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------------------
// the queue (issue #508)
//
// A waiter writes a ticket, `<leases>/queue/<ms>-<ns>-<id>.json` (a lease
// record naming its process), and takes a slot only while fewer live waiters
// stand ahead of it than there are free slots: first come, first served. A
// ticket whose process died is stale by the same test as a slot
// (staleReason), and the next waiter removes it under the same mkdir guard.
// An older CLI that does not queue still races for a free slot; it can jump
// the queue, never break it.

export const queueDir = (dir: string): string => path.join(dir, "queue");

const TICKET = /^\d{15}-\d{16}-[\w-]+\.json$/u;

/** A ticket name that sorts in arrival order. */
const ticketName = (now: number, id: string): string =>
  `${String(now).padStart(15, "0")}-${String(process.hrtime.bigint() % 10n ** 16n).padStart(16, "0")}-${id}.json`;

export type QueueEntry = {
  file: string;
  holder: LeaseHolder;
  id: string | null;
  stale: string | null;
};

/** The queue's tickets in arrival order. Read-only: nothing is removed. */
export function leaseQueue(dir: string, probe: LeaseProbe = {}): QueueEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(queueDir(dir));
  } catch {
    return [];
  }
  const entries: QueueEntry[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).toSorted()) {
    const file = path.join(queueDir(dir), name);
    const record = parseLease(readText(file));
    if (!record) continue;
    entries.push({
      file,
      holder: holderOf(record),
      id: record.id,
      stale: staleReason(record, probe),
    });
  }
  return entries;
}

/** The live tickets ahead of `own`, removing stale ones on the way. */
function waitersAhead(options: AcquireOptions, own: string): number {
  let ahead = 0;
  for (const entry of leaseQueue(options.dir, options.probe)) {
    if (path.basename(entry.file) >= own) break;
    if (!TICKET.test(path.basename(entry.file))) continue;
    if (
      entry.stale &&
      reclaim(entry.file, (current) => !current || staleReason(current, options.probe) !== null)
    )
      continue;
    ahead += 1;
  }
  return ahead;
}

/** Live holders of the slots, read without reclaiming. */
function liveHolders(options: AcquireOptions): LeaseHolder[] {
  return leaseSlots(options.dir, options.slots, options.probe)
    .filter((slot) => slot.holder && !slot.stale)
    .map((slot) => slot.holder as LeaseHolder);
}

function writeTicket(file: string, record: LeaseRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** "90", "90s", "30m", "1.5h" as ms; null when it is none of those. */
export function parseWait(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/u.exec(text.trim());
  if (!match) return null;
  const unit = { "": 1000, s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 1000;
  return Math.round(Number(match[1]) * unit);
}

/** "12m 5s" or "40s". */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/**
 * Take one of `slots` machine-wide lease slots. A slot free and nobody queued
 * ahead: it is taken at once. Otherwise the caller queues (a ticket in
 * `queue/`) and polls every `pollMs`, first come, first served, up to
 * `waitMs`; `onStatus` reports its place now and then. The returned lease is
 * released by `release()`, and on process exit as a backstop.
 */
export async function acquireLease(options: AcquireOptions): Promise<AcquireResult> {
  const clock = options.clock ?? realClock;
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
    startedAt: new Date(clock.now()).toISOString(),
    scope: null,
  };
  try {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "unavailable", error: (error as Error).message };
  }
  const started = clock.now();
  const reclaimed: HeldLease["reclaimed"] = [];
  let waitedOn: LeaseHolder[] = [];
  const name = ticketName(started, record.id);
  const ticket = path.join(queueDir(options.dir), name);
  // A ticket outlives a waiter that never finds the slot it would take on
  // platforms without a process start time; its age bound is the wait.
  const ticketRecord: LeaseRecord = {
    ...record,
    maxAgeMs: options.waitMs + 60_000,
  };
  let queued = false;
  // Ctrl-C or SIGTERM while queued: give up the place, then exit as the signal would.
  const onSignal = (signal: NodeJS.Signals) => {
    leave();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const leave = () => {
    process.off("exit", leave);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (queued) removeOwn(ticket, record.id);
    queued = false;
  };
  let nextStatus = 0;
  try {
    for (;;) {
      const waited = clock.now() - started;
      const ahead = queued ? waitersAhead(options, name) : waitersAhead(options, "~");
      const free = options.slots - liveHolders(options).length;
      if (ahead < free) {
        const outcome = tryOnce(options, record, reclaimed);
        if ("slot" in outcome) {
          const waitedMs = queued ? waited : 0;
          leave();
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
              waitedMs,
              reclaimed,
              release,
            },
          };
        }
      }
      const holders = liveHolders(options);
      if (!waitedOn.length) {
        waitedOn = holders;
        options.onWait?.(holders);
      }
      if (waited >= options.waitMs)
        return {
          ok: false,
          reason: "timeout",
          holders,
          waitedMs: waited,
          position: ahead + 1,
        };
      if (!queued) {
        // Handlers first, then one event-loop turn so Bun has armed them, then
        // the ticket: a signal that lands as the ticket appears must find a
        // handler, not the default action that leaves the ticket behind.
        process.on("exit", leave);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        await new Promise<void>((resolve) => setImmediate(resolve));
        writeTicket(ticket, ticketRecord);
        queued = true;
      } else if (!fs.existsSync(ticket)) {
        // Wrongly reclaimed (a clock step past its age bound): stand in the same place again.
        writeTicket(ticket, ticketRecord);
      }
      if (waited >= nextStatus) {
        options.onStatus?.({
          position: ahead + 1,
          ahead,
          holders,
          waitedMs: waited,
          first: nextStatus === 0,
        });
        nextStatus = waited + (options.statusEveryMs ?? 30_000);
      }
      await clock.sleep(Math.min(options.pollMs ?? 2000, Math.max(1, options.waitMs - waited)));
    }
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      error: (error as Error).message,
    };
  } finally {
    leave();
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
