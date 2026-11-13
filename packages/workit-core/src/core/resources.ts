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
import { describePressure, readPressure, type PressureReading } from "./pressure";
import { processStartOf, type ProcessStartDeps } from "./store-lock";

export { stateDir };
export {
  probeScope,
  scopePrefix,
  scopeSupport,
  type ScopeProbe,
  type ScopeSupport,
} from "./heavy-scope";

/** Named checks that take the lease when nothing is configured. */
export const DEFAULT_HEAVY_CHECKS = ["test", "build", "packaging"];
/**
 * Named checks that never take the lease unless the machine lists them heavy:
 * they finish in seconds, so they must not queue behind a 10-minute suite (#508).
 */
export const DEFAULT_LIGHT_CHECKS = ["lint", "typecheck", "format"];
const DEFAULT_SLOTS = 1;
/** A queued heavy check waits its turn this long by default (#508). */
const DEFAULT_WAIT_S = 1800;
/** A holder past this hold time is shown `stuck?` (#608). */
export const DEFAULT_MAX_HOLD_MS = 15 * 60_000;
/** A holder whose check printed nothing and used no CPU for this long is shown `stuck?`. */
export const SILENT_MS = 5 * 60_000;
/** Past this many times its max hold, a silent holder is reclaimed by the next acquirer. */
const AUTO_REAP_FACTOR = 3;
const DEFAULT_MEMORY_SHARE = 0.4;
const DEFAULT_CPU_SHARE = 0.7;
const MAX_SLOTS = 64;
/** The most units a `resources.budget` count may hold. */
const MAX_UNITS = 1024;
/**
 * The automatic machine reserve (#326, decisions mvi7cb4w and mvi7mhmo): a
 * quarter of RAM, at least 2 GiB and at most 6 GiB, is kept for the desktop
 * and IDE; heavy checks and dev servers share the rest.
 */
const RESERVE_SHARE = 0.25;
const RESERVE_MIN_BYTES = 2 * 1024 ** 3;
const RESERVE_MAX_BYTES = 6 * 1024 ** 3;
/** Cores kept for the desktop: 2 from 8 CPUs, else 1. A heavy check's default CPUQuota leaves them free. */
const reserveCores = (cpus: number): number => (cpus >= 8 ? 2 : 1);
/** A waiter queued this long holds its place: nobody behind it backfills the budget it needs. */
export const DEFAULT_AGING_MS = 5 * 60_000;
/**
 * Pressure alone holds a check at most this long: past it the check runs and
 * the pressure stays named on its lease's wait, so a machine whose load never
 * drops (a busy Mac) slows checks down but never stalls them.
 */
export const PRESSURE_MAX_WAIT_MS = 5 * 60_000;
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
  /** How long a check may hold a slot before it is shown `stuck?` (#608); unset is DEFAULT_MAX_HOLD_MS. */
  maxHoldMs?: number;
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

/** What a holder takes from the budget: count units and memory bytes. */
export type Charge = { units: number; bytes: number };

/**
 * The weighted budget (#326). Two dimensions, both must fit: `units` (a count:
 * `resources.slots`, or a `resources.budget` number; a check weighs 1 unless
 * `resources.weights` says more) and `memoryBytes` (RAM less the reserve, or a
 * `resources.budget` size), charged in bytes of measured peak RSS. A dev
 * server holds memory and no units; with only `resources.slots` configured
 * (`mode: "slots"`) checks are counted as before, and a units budget weighs
 * them in units only: in both, only `admit` reads the memory budget.
 */
export type Budget = {
  mode: "slots" | "units" | "memory" | "default";
  units: number;
  memoryBytes: number;
  reserveBytes: number;
  /** Where the reserve came from. */
  reserveSource: "automatic" | "configured";
  /** Per check: a units weight, or a fixed memory charge in bytes. */
  weights: Record<string, Partial<Charge>>;
  /** The memory charge of a check with no measured run and no weight (its MemoryMax). */
  defaultBytes: number;
  agingMs: number;
  /** How long pressure alone may hold a check (default PRESSURE_MAX_WAIT_MS). */
  pressureMaxWaitMs?: number;
  /** False when the machine turned the pressure gate off (`resources.pressure: false`). */
  pressureGate: boolean;
  /** The pressure gate's reader; null reads nothing (the gate is open). */
  pressure: (() => PressureReading) | null;
};

const autoReserve = (host: HostShape): number =>
  Math.min(
    RESERVE_MAX_BYTES,
    Math.max(RESERVE_MIN_BYTES, Math.floor(host.totalMemBytes * RESERVE_SHARE)),
  );

/** The budget `slots` alone gives: N units, weight 1 each, no memory charge for checks, no pressure gate. */
export const slotsBudget = (slots: number, host: HostShape = hostShape()): Budget => {
  const reserve = autoReserve(host);
  return {
    mode: "slots",
    units: slots,
    memoryBytes: Math.max(0, host.totalMemBytes - reserve),
    reserveBytes: reserve,
    reserveSource: "automatic",
    weights: {},
    defaultBytes: Math.floor(host.totalMemBytes * DEFAULT_MEMORY_SHARE),
    agingMs: DEFAULT_AGING_MS,
    pressureGate: true,
    pressure: null,
  };
};

/**
 * The budget the last `resolveResourceSettings` on the real host gave (the CLI
 * resolves its settings once per run), so `acquireLease` weighs a check by its
 * name without its caller passing the budget.
 */
let resolvedBudget: Budget | null = null;

/** A units weight (a whole number) or a memory charge (a size or percent of RAM). */
function weightValue(value: unknown, host: HostShape): Partial<Charge> | Error {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 && value <= MAX_SLOTS
      ? { units: value }
      : new Error(`a units weight must be a whole number 1-${MAX_SLOTS}`);
  const bytes = memoryValue(value, host);
  return bytes instanceof Error
    ? new Error(`must be a units weight (2) or a memory size ("4G")`)
    : { bytes };
}

/**
 * Merge `resources` blocks over the defaults, machine sources before repo
 * ones. Lenient: an invalid or refused field is reported and the earlier
 * value kept, so a typo never turns the lease off.
 */
export function resolveResourceSettings(
  sources: ResourceSource[],
  host?: HostShape,
): { settings: ResourceSettings; warnings: string[]; budget: Budget } {
  const resolved = resolveWith(sources, host ?? hostShape());
  if (!host) resolvedBudget = withGate(resolved.budget);
  return resolved;
}

function resolveWith(
  sources: ResourceSource[],
  host: HostShape,
): { settings: ResourceSettings; warnings: string[]; budget: Budget } {
  let memory = Math.floor(host.totalMemBytes * DEFAULT_MEMORY_SHARE);
  let cpu = Math.max(
    1,
    Math.min(
      Math.round(host.cpus * DEFAULT_CPU_SHARE * 100),
      (host.cpus - reserveCores(host.cpus)) * 100,
    ),
  );
  let slotsSet = false;
  let units: number | null = null;
  let memoryBudget: number | null = null;
  let reserve: number | null = null;
  let pressureGate = true;
  const weights: Record<string, Partial<Charge>> = {};
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
      ) {
        settings.slots = slots;
        slotsSet = true;
      } else warn("slots", `must be an integer 1-${MAX_SLOTS}`);
    }
    if (value.budget !== undefined) {
      const raw = value.budget;
      const count =
        typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_UNITS
          ? raw
          : null;
      const bytes = count === null ? memoryValue(raw, host) : null;
      if (count === null && bytes instanceof Error)
        warn(
          "budget",
          `must be a number of units (1-${MAX_UNITS}) or a memory size ("24G", "60%")`,
        );
      else if (repo) {
        // A repo may only lower the machine's budget, in the same unit.
        const lower =
          count !== null
            ? units !== null && count <= units
            : memoryBudget !== null && (bytes as number) <= memoryBudget;
        if (!lower) machineOnly("budget");
        else if (count !== null) units = count;
        else memoryBudget = bytes as number;
      } else if (count !== null) {
        units = count;
        memoryBudget = null;
      } else {
        memoryBudget = bytes as number;
        units = null;
      }
    }
    if (value.pressure !== undefined) {
      if (repo) machineOnly("pressure");
      else if (typeof value.pressure === "boolean") pressureGate = value.pressure;
      else warn("pressure", "must be true or false");
    }
    if (value.reserve !== undefined) {
      const next = memoryValue(value.reserve, host);
      if (next instanceof Error)
        warn("reserve", 'must be a percent of RAM ("20%") or a size ("6G")');
      // A larger reserve tightens; a repo cannot lower the machine's.
      else if (repo && next < (reserve ?? autoReserve(host))) machineOnly("reserve");
      else reserve = next;
    }
    if (value.weights !== undefined) {
      if (!isRecord(value.weights)) warn("weights", "must map check names to weights");
      else
        for (const [name, raw] of Object.entries(value.weights)) {
          const weight = weightValue(raw, host);
          if (weight instanceof Error) warn(`weights.${name}`, weight.message);
          // A repo may only make its checks weigh more.
          else if (
            repo &&
            ((weight.units !== undefined && weight.units < (weights[name]?.units ?? 1)) ||
              (weight.bytes !== undefined && weight.bytes < (weights[name]?.bytes ?? memory)))
          )
            machineOnly(`weights.${name}`);
          else weights[name] = { ...weights[name], ...weight };
        }
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
      const wait = durationValue(value.wait);
      if (wait !== null) settings.waitMs = wait;
      else warn("wait", 'must be a number of seconds or a duration ("30m")');
    }
    if (value.maxHold !== undefined) {
      const hold = durationValue(value.maxHold);
      if (hold === null || hold <= 0)
        warn("maxHold", 'must be a positive number of seconds or a duration ("15m")');
      else if (repo && hold > (settings.maxHoldMs ?? DEFAULT_MAX_HOLD_MS))
        warn("maxHold", "a repo can only lower it");
      else settings.maxHoldMs = hold;
    }
  }
  // More slots run more heavy checks at once, each up to memoryMax: say when together they can take all RAM.
  const share = Math.round((memory / host.totalMemBytes) * 100);
  if (
    units === null &&
    memoryBudget === null &&
    settings.slots > 1 &&
    settings.slots * memory > host.totalMemBytes
  )
    warnings.push(
      `slots: ${settings.slots} heavy checks at ${share}% of RAM each can use ${settings.slots * share}% of it; lower memoryMax to about ${Math.floor(80 / settings.slots)}% or use fewer slots`,
    );
  settings.memoryMax = String(memory);
  settings.cpuQuota = `${cpu}%`;
  const reserveBytes = reserve ?? autoReserve(host);
  const mode: Budget["mode"] =
    units !== null
      ? "units"
      : memoryBudget !== null
        ? "memory"
        : slotsSet && reserve === null && Object.keys(weights).length === 0
          ? "slots"
          : "default";
  const capacity = units ?? (memoryBudget !== null ? MAX_SLOTS : settings.slots);
  // The slot files a check may take: as many as can hold at once (every weight is at least 1 unit).
  settings.slots = Math.min(MAX_SLOTS, capacity);
  const budget: Budget = {
    mode,
    units: capacity,
    memoryBytes: memoryBudget ?? Math.max(0, host.totalMemBytes - reserveBytes),
    reserveBytes,
    reserveSource: reserve === null ? "automatic" : "configured",
    weights,
    defaultBytes: memory,
    agingMs: DEFAULT_AGING_MS,
    pressureGate,
    pressure: null,
  };
  return { settings, warnings, budget };
}

/** "6.0 GiB". */
export const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.max(0, Math.round(bytes / 1024 ** 2))} MiB`;

/** Seconds (a number) or a duration ("30m") as ms; null when it is neither. */
const durationValue = (value: unknown): number | null =>
  typeof value === "number"
    ? value >= 0
      ? value * 1000
      : null
    : typeof value === "string"
      ? parseWait(value)
      : null;

// ---------------------------------------------------------------------------
// the machine lease

export const leaseDir = (env: NodeJS.ProcessEnv): string => path.join(stateDir(env), "leases");

export type LeaseRecord = {
  id: string;
  /** The workit process that took the lease. */
  pid: number;
  /** The process start time (processStart), so a recycled pid does not keep a lease alive. */
  processStart: string | null;
  /** The kernel boot id (Linux). */
  bootId: string | null;
  /** Boot time in ms, where there is no boot id (macOS, Windows). */
  bootTime?: number | null;
  /** The check's process group: it outlives a SIGKILLed workit. */
  pgid?: number | null;
  /**
   * The group leader's start time, so a recycled pgid does not keep a lease
   * alive. Null when it could not be read (Windows); absent on older leases,
   * whose group is trusted only within the age bound.
   */
  pgidStart?: string | null;
  /** Past this age a lease whose holder cannot be identified (no processStart, no group identity) is stale. */
  maxAgeMs?: number | null;
  check: string;
  cwd: string;
  session: string | null;
  startedAt: string;
  /** The check's systemd scope unit; it holds the lease while it has processes. */
  scope: string | null;
  /** Last time the check printed or used CPU (#608); absent on older leases. */
  heartbeatAt?: string | null;
  /** The holder's max hold time; absent on older leases (the reader's own setting applies). */
  maxHoldMs?: number | null;
  /** The process that started workit (a queued ticket): its waiter leaves when it ends. */
  ownerPid?: number | null;
  ownerStart?: string | null;
  /** The waiter honours a `workit lock cancel` marker (older ones get SIGTERM). */
  cancellable?: boolean;
  /**
   * The waiter's own slot count (a queued ticket; workspaces may set different
   * ones): a waiter ahead that cannot use the slot that freed does not hold
   * back those behind it. Absent on older tickets, which may take any slot.
   */
  slots?: number | null;
  /** What holds it: a heavy check (absent on older leases) or an admitted holder such as a dev server. */
  kind?: string;
  /** Its charge on the budget (absent on older leases: 1 unit, the reader's default memory charge). */
  units?: number;
  bytes?: number;
  /** The highest RSS of its check group seen so far (the heartbeat samples it). */
  peakRssBytes?: number | null;
  /** The registry's id for an admitted holder (`workit stop <id>`). */
  ref?: string | null;
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

/**
 * Start time of `pid`, so a recycled pid does not keep a lease alive: /proc
 * on Linux, `ps -o lstart=` on macOS (store-lock.ts), null elsewhere.
 */
export const processStart = (pid: number, deps?: ProcessStartDeps): string | null => {
  if (deps) return processStartOf(pid, deps);
  // A waiter polls the holder every tick; on macOS each probe spawns `ps`. A
  // live pid's start time cannot change, so a short real-time cache is exact
  // enough (a pid reused within it keeps its lease that long at most).
  const now = Date.now();
  const hit = START_CACHE.get(pid);
  if (hit && now - hit.at < START_CACHE_MS) return hit.start;
  const start = processStartOf(pid);
  if (START_CACHE.size > 256) START_CACHE.clear();
  START_CACHE.set(pid, { start, at: now });
  return start;
};
const START_CACHE_MS = 2_000;
const START_CACHE = new Map<number, { start: string | null; at: number }>();

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

/** This process's group (Linux, from /proc); null where there is no cheap read. */
const ownGroup = (): number | null => {
  if (process.platform !== "linux") return null;
  const pgrp = Number(statFields(process.pid)?.[2]);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
};

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

export const parseLease = (text: string | null): LeaseRecord | null => {
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
 * The lease's check group: `same` while it runs under the leader recorded with
 * it, `recycled` when another process now leads that pgid, `unproven` when it
 * has members but its leader is gone or was never recorded, `none` otherwise.
 */
function groupState(
  lease: LeaseRecord,
  probe: LeaseProbe,
): "same" | "recycled" | "unproven" | "none" {
  const pgid = lease.pgid;
  if (typeof pgid !== "number" || pgid <= 0 || !(probe.group ?? groupAlive)(pgid)) return "none";
  if (typeof lease.pgidStart !== "string") return "unproven";
  const leader = (probe.start ?? processStart)(pgid);
  return leader === lease.pgidStart ? "same" : leader ? "recycled" : "unproven";
}

/**
 * Why `lease` no longer holds anything, or null while it does. It holds while
 * its workit process runs, or, once that is gone (a SIGKILL), while the
 * check's process group (led by the recorded leader) or scope still has
 * processes. A lease from before a reboot is stale either way; so is one past
 * its age bound whose holder cannot be identified (no process start, or a
 * group whose leader cannot be proven). A lease from an older workit records
 * no leader, so its age bound applies as soon as its workit is unidentified.
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
  const bound =
    typeof lease.maxAgeMs === "number" && age > lease.maxAgeMs
      ? `older than its ${Math.round(lease.maxAgeMs / 1000)} s bound`
      : null;
  const legacy = lease.pgidStart === undefined;
  if (!start && bound && (legacy || !lease.processStart)) return bound;
  const holder = !(probe.alive ?? pidAlive)(lease.pid)
    ? `holder pid ${lease.pid} is gone`
    : start && start !== lease.processStart
      ? `pid ${lease.pid} now belongs to another process`
      : null;
  // A live pid whose start cannot be read now is not proven to be the holder.
  if (!holder) return start ? null : bound;
  // workit is gone, but the check it started may still run.
  const group = groupState(lease, probe);
  if (group === "same") return null;
  if (group === "unproven") return legacy ? null : bound;
  if (lease.scope && (probe.scope ?? scopeBusy)(lease.scope)) return start ? null : bound;
  return group === "recycled"
    ? `${holder}; process group ${lease.pgid} now belongs to another process`
    : holder;
}

/**
 * Why a holder looks stuck (#608), or null: it has held its slot past its max
 * hold time, or its check printed nothing and used no CPU for SILENT_MS. A
 * lease from an older workit has no heartbeat; only its hold time counts.
 */
export function stuckReason(
  lease: LeaseRecord,
  maxHoldMs: number,
  now = Date.now(),
): string | null {
  const limit = typeof lease.maxHoldMs === "number" ? lease.maxHoldMs : maxHoldMs;
  const age = now - Date.parse(lease.startedAt);
  const beat = lease.heartbeatAt ? now - Date.parse(lease.heartbeatAt) : null;
  if (age > limit) return `held ${formatWait(age)}, past its ${formatWait(limit)} limit`;
  if (beat !== null && beat > SILENT_MS) return `no heartbeat for ${formatWait(beat)}`;
  return null;
}

/**
 * Why the next acquirer reclaims a live but stuck holder, or null: held past
 * AUTO_REAP_FACTOR times its max hold and silent for at least its max hold
 * (no heartbeat at all counts as silent). A busy long run is never reclaimed.
 */
export function autoReapReason(
  lease: LeaseRecord,
  maxHoldMs: number,
  now = Date.now(),
): string | null {
  const limit = typeof lease.maxHoldMs === "number" ? lease.maxHoldMs : maxHoldMs;
  const age = now - Date.parse(lease.startedAt);
  const beat = now - Date.parse(lease.heartbeatAt ?? lease.startedAt);
  return age > AUTO_REAP_FACTOR * limit && beat > limit
    ? `stuck: held ${formatWait(age)}, silent for ${formatWait(beat)}, past ${AUTO_REAP_FACTOR}x its ${formatWait(limit)} limit`
    : null;
}

export type LeaseHolder = Pick<LeaseRecord, "pid" | "check" | "cwd" | "session" | "startedAt"> & {
  /** Why the holder looks stuck (stuckReason); absent or null when it does not. */
  stuck?: string | null;
  /** Not a heavy check: an admitted holder (`server`), or `pressure` standing for the pressure gate. */
  kind?: string;
  /** An admitted holder's registry id. */
  ref?: string | null;
  /** An admitted holder's memory charge. */
  bytes?: number;
};

const holderOf = (lease: LeaseRecord): LeaseHolder => ({
  pid: lease.pid,
  check: lease.check,
  cwd: lease.cwd,
  session: lease.session,
  startedAt: lease.startedAt,
  ...(lease.kind && lease.kind !== "check"
    ? { kind: lease.kind, ref: lease.ref ?? null, bytes: lease.bytes ?? 0 }
    : {}),
});

/** Why a queued ticket's owner (the process that started its workit) is gone, or null. */
export function ownerGone(record: LeaseRecord, probe: LeaseProbe = {}): string | null {
  const owner = record.ownerPid;
  if (typeof owner !== "number" || owner <= 1) return null;
  if (!(probe.alive ?? pidAlive)(owner)) return `owner pid ${owner} is gone`;
  const start = record.ownerStart ? (probe.start ?? processStart)(owner) : null;
  return start && start !== record.ownerStart
    ? `owner pid ${owner} now belongs to another process`
    : null;
}

/** Why a queued ticket no longer waits: its waiter or the waiter's owner is gone. */
export const ticketStale = (record: LeaseRecord, probe: LeaseProbe = {}): string | null =>
  staleReason(record, probe) ?? ownerGone(record, probe);

/** Remove a stale slot under a mkdir guard, re-checking it inside so a fresh holder is never removed. */
export function reclaim(
  file: string,
  stale: (lease: LeaseRecord | null, ageMs: number) => boolean,
) {
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
  reclaimed: Reclaimed[];
  release: () => void;
};

/** A slot reclaimed from a gone holder, or (`reaped`) from a live one past its auto-reap bound. */
export type Reclaimed = LeaseHolder & { reason: string; reaped?: boolean };

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
  /** The max hold time applied to older leases that carry none (#608); recorded on the lease unless `holdMs` is set. */
  maxHoldMs?: number;
  /** This check's own max hold time, recorded on its lease (heavy-eta holdLimit: from its measured runs). */
  holdMs?: number;
  /** The process that started this waiter (default: the parent); null records none. */
  ownerPid?: number | null;
  /** Called once, when the first attempt finds every slot held. */
  onWait?: (holders: LeaseHolder[]) => void;
  /** Called when the wait starts and every `statusEveryMs` after (default 30 s). */
  onStatus?: (status: QueueStatus) => void;
  statusEveryMs?: number;
  /**
   * Called once, when the wait first reaches its limit: the ms to keep
   * waiting, in the same place in the queue (0 gives up as `timeout`).
   */
  onLimit?: (status: QueueStatus) => number;
  /** The weighted budget; default: the one `resolveResourceSettings` gave for these slots, else `slots` alone. */
  budget?: Budget;
  /** Overrides for tests. */
  probe?: LeaseProbe;
  pid?: number;
  clock?: Clock;
  /**
   * false: poll only, no file watching. A test on a fake clock sets it, so a
   * late real watch event (macOS FSEvents can deliver one for a write made
   * before the watch began) never adds a settle to the fake waited time.
   */
  watch?: boolean;
};

/** Where a waiter stands: 1 is next in line. */
export type QueueStatus = {
  position: number;
  /** Live waiters ahead of this one. */
  ahead: number;
  /** Those waiters, in serving order (for a wait estimate). */
  aheadOf: LeaseHolder[];
  /** The live holders of the slots. */
  holders: LeaseHolder[];
  waitedMs: number;
  /** The first report of this wait (whatever time has already passed). */
  first: boolean;
};

/** `sleep` ends early when `signal` aborts. */
export type Clock = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type AcquireResult =
  | { ok: true; lease: HeldLease }
  | {
      ok: false;
      reason: "timeout";
      holders: LeaseHolder[];
      waitedMs: number;
      /** Where this waiter stood when it gave up. */
      position: number;
      /** The wait limit it reached first, when `onLimit` re-queued it once. */
      requeuedAfterMs: number | null;
    }
  | {
      ok: false;
      reason: "cancelled";
      /** Who cancelled it: `workit lock cancel`'s note, or the owner that ended. */
      by: string;
      waitedMs: number;
    }
  | { ok: false; reason: "unavailable"; error: string };

/** One pass over the slots: the slot taken, or the live holders. */
function tryOnce(
  options: AcquireOptions,
  record: LeaseRecord,
  reclaimed: Reclaimed[],
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
      let stuck = false;
      const removed = reclaim(file, (current, ageMs) => {
        reason = current
          ? staleReason(current, options.probe)
          : ageMs > UNREADABLE_TTL_MS
            ? "unreadable"
            : null;
        if (current && reason === null) {
          reason = autoReapReason(
            current,
            options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS,
            options.probe?.now,
          );
          stuck = reason !== null;
        }
        return reason !== null;
      });
      if (removed) {
        if (lease && reason)
          reclaimed.push({ ...holderOf(lease), reason, ...(stuck ? { reaped: true } : {}) });
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
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
};

/** A change seen while a waiter was busy re-reads the lease after this, not after the whole poll. */
const SETTLE_MS = 50;
/** The files whose change can free a slot or move the queue: slots, tickets and cancel markers. */
const WAKE_NAME = /^slot-\d+\.json$|^\d{15}-\d{16}-[\w-]+\.json(?:\.cancel)?$/u;

export type LeaseWake = {
  /** Wait up to `ms`, ending soon after a slot or the queue changes. */
  pause: (ms: number) => Promise<void>;
  close: () => void;
};

/**
 * Wakes a lease waiter when a slot is released or taken or the queue moves,
 * so a freed slot is taken without waiting out the poll. The poll still bounds
 * every wait: a holder killed outright releases nothing, and a platform
 * without file watching only polls. The waiter's own ticket (`own`) never
 * wakes it: a late watch event for its own write would only add a settle.
 */
export function leaseWake(
  dir: string,
  clock: Clock = realClock,
  own?: string,
  watch = true,
): LeaseWake {
  let changed = false;
  let wake: (() => void) | null = null;
  const watchers: fs.FSWatcher[] = [];
  const onChange = (_event: string, name: string | Buffer | null) => {
    if (name !== null && (String(name) === own || !WAKE_NAME.test(String(name)))) return;
    changed = true;
    wake?.();
  };
  for (const target of [dir, queueDir(dir)]) {
    try {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!watch) continue;
      const watcher = fs.watch(target, { persistent: false }, onChange);
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // No watching here: the poll alone wakes the waiter.
    }
  }
  return {
    pause: async (ms) => {
      if (!changed) {
        const abort = new AbortController();
        await Promise.race([
          clock.sleep(ms, abort.signal),
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
        ]);
        wake = null;
        abort.abort();
      }
      if (!changed) return;
      changed = false;
      await clock.sleep(Math.min(ms, SETTLE_MS));
    },
    close: () => {
      for (const watcher of watchers) watcher.close();
    },
  };
}

/** Remove `file` only while it still holds lease `id`: a reclaimed and retaken slot is someone else's. */
function removeOwn(file: string, id: string): void {
  if (parseLease(readText(file))?.id === id) fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------------------
// the queue (issues #508, #608)
//
// A waiter writes a ticket, `<leases>/queue/<ms>-<ns>-<id>.json` (a lease
// record naming its process and the process that started it), and takes a
// slot only while fewer live waiters stand ahead of it than there are free
// slots. "Ahead" is round-robin per session: a session's n-th waiter (counting
// the slots it already holds) goes after every other session's earlier ones,
// arrival order breaking ties, so one session's chain of jobs cannot starve
// another's single check. A ticket whose waiter or owner died is stale
// (ticketStale), and the next reader removes it under the same mkdir guard.
// `workit lock cancel` drops a ticket and leaves a `<ticket>.cancel` marker
// its waiter reads. An older CLI that does not queue still races for a free
// slot; it can jump the queue, never break it.

export const queueDir = (dir: string): string => path.join(dir, "queue");

const TICKET = /^\d{15}-\d{16}-[\w-]+\.json$/u;

/** The marker `workit lock cancel` leaves for a ticket's waiter. */
export const cancelMarker = (ticket: string): string => `${ticket}.cancel`;

/** A ticket name that sorts in arrival order. */
const ticketName = (now: number, id: string): string =>
  `${String(now).padStart(15, "0")}-${String(process.hrtime.bigint() % 10n ** 16n).padStart(16, "0")}-${id}.json`;

export type QueueEntry = {
  file: string;
  holder: LeaseHolder;
  id: string | null;
  stale: string | null;
  /** The full ticket, for `workit lock cancel`. */
  record?: LeaseRecord;
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
      stale: ticketStale(record, probe),
      record,
    });
  }
  return entries;
}

const sessionKey = (holder: Pick<LeaseHolder, "session" | "pid">): string =>
  holder.session ?? `pid:${holder.pid}`;

/** A slot handed out: whose session, and when (ms). */
export type Grant = { key: string; at: number };

const GRANTS_FILE = "grants.json";
/** Grants older than this no longer weigh on anyone's turn. */
const GRANT_TTL_MS = 2 * 3_600_000;
const MAX_GRANTS = 256;

/** Recent grants (best effort: unreadable means none). */
export function readGrants(dir: string, now = Date.now()): Grant[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, GRANTS_FILE), "utf8"));
    const list = isRecord(value) && Array.isArray(value.grants) ? value.grants : [];
    return list.filter(
      (item): item is Grant =>
        isRecord(item) &&
        typeof item.key === "string" &&
        typeof item.at === "number" &&
        now - item.at < GRANT_TTL_MS,
    );
  } catch {
    return [];
  }
}

/** Note a grant for the round-robin. A lost race drops one note, never a slot. */
function recordGrant(dir: string, holder: LeaseHolder, at: number): void {
  try {
    const grants = [...readGrants(dir, at), { key: sessionKey(holder), at }].slice(-MAX_GRANTS);
    const file = path.join(dir, GRANTS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ grants })}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // Fairness is best effort.
  }
}

/**
 * `waiting` (live, in arrival order) in serving order: round-robin per
 * session. A waiter's round counts its session's waiters ahead of it, the
 * slots its session held when it queued (`holders`), and the slots its
 * session was granted since (`grants`); arrival order breaks ties.
 */
export function fairOrder<T extends { holder: LeaseHolder }>(
  waiting: T[],
  holders: LeaseHolder[],
  grants: Grant[] = [],
): T[] {
  const ahead = new Map<string, number>();
  return waiting
    .map((entry, arrival) => {
      const key = sessionKey(entry.holder);
      const queuedAt = Date.parse(entry.holder.startedAt);
      const before = ahead.get(key) ?? 0;
      ahead.set(key, before + 1);
      const held = holders.filter(
        (holder) => sessionKey(holder) === key && Date.parse(holder.startedAt) < queuedAt,
      ).length;
      const granted = grants.filter((grant) => grant.key === key && grant.at >= queuedAt).length;
      return { entry, round: before + held + granted, arrival };
    })
    .toSorted((a, b) => a.round - b.round || a.arrival - b.arrival)
    .map(({ entry }) => entry);
}

type Waiter = { name: string; holder: LeaseHolder; slots: number | null; record?: LeaseRecord };

/** The live tickets served before `own` (a ticket name, or "~" before queueing), removing stale ones on the way. */
function waitersAhead(
  options: AcquireOptions,
  own: string,
  self: LeaseHolder,
  holders: LeaseHolder[],
): Waiter[] {
  const live: Waiter[] = [];
  for (const entry of leaseQueue(options.dir, options.probe)) {
    const name = path.basename(entry.file);
    if (!TICKET.test(name) || name === own) continue;
    if (
      entry.stale &&
      reclaim(entry.file, (current) => !current || ticketStale(current, options.probe) !== null)
    )
      continue;
    const slots = entry.record?.slots;
    live.push({
      name,
      holder: entry.holder,
      slots: typeof slots === "number" && slots > 0 ? slots : null,
      record: entry.record,
    });
  }
  const order = fairOrder(
    [...live, { name: own, holder: self, slots: options.slots }].toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    ),
    holders,
    readGrants(options.dir, options.probe?.now),
  );
  return order.slice(
    0,
    order.findIndex((entry) => entry.name === own),
  );
}

/** Every slot file's index in `dir`, at least `slots` of them: a workspace with more slots uses higher ones. */
function slotRange(dir: string, slots: number): number {
  let count = slots;
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^slot-(\d+)\.json$/u.exec(name);
      if (match) count = Math.max(count, Number(match[1]) + 1);
    }
  } catch {
    // No lease dir yet.
  }
  return count;
}

/**
 * The live holders of the first `slots` slots by slot index, read without
 * reclaiming: a stale lease, or one past its auto-reap bound, does not count.
 */
export function liveHolders(
  dir: string,
  slots: number,
  probe: LeaseProbe = {},
  maxHoldMs = DEFAULT_MAX_HOLD_MS,
): Map<number, LeaseHolder> {
  return new Map(
    [...liveSlots(dir, slots, probe, maxHoldMs)].map(([slot, { holder }]) => [slot, holder]),
  );
}

/** liveHolders with each holder's record (null when unreadable). */
function liveSlots(
  dir: string,
  slots: number,
  probe: LeaseProbe,
  maxHoldMs: number,
): Map<number, { holder: LeaseHolder; record: LeaseRecord | null }> {
  const live = new Map<number, { holder: LeaseHolder; record: LeaseRecord | null }>();
  for (const slot of leaseSlots(dir, slots, probe, maxHoldMs)) {
    if (!slot.holder || slot.stale) continue;
    const record = parseLease(readText(path.join(dir, `slot-${slot.slot}.json`)));
    if (!record || !autoReapReason(record, maxHoldMs, probe.now))
      live.set(slot.slot, { holder: slot.holder, record });
  }
  return live;
}

/**
 * Is one of the first `slots` slots left once each waiter ahead (in serving
 * order) takes the lowest free slot within its own slot count? A waiter of
 * unknown count may take any. With one count for all, this is "fewer waiters
 * ahead than free slots".
 */
export function slotLeft(
  held: ReadonlySet<number>,
  ahead: ReadonlyArray<{ slots: number | null }>,
  slots: number,
): boolean {
  const top = Math.max(slots, ...ahead.map((waiter) => waiter.slots ?? 0));
  const free = Array.from({ length: top }, (_, slot) => slot).filter((slot) => !held.has(slot));
  for (const waiter of ahead) {
    const at = free.findIndex((slot) => slot < (waiter.slots ?? top));
    if (at >= 0) free.splice(at, 1);
  }
  return free.some((slot) => slot < slots);
}

// ---------------------------------------------------------------------------
// the weighted budget (#326)
//
// A check's charge is its units weight (default 1) and its memory: a fixed
// `resources.weights` size, else its last measured peak RSS in this checkout
// (`rss.json`, which the heartbeat keeps), else its MemoryMax. A waiter whose
// charge fits what is free runs ahead of bigger waiters (backfill), until one
// of them has waited `agingMs`: from then on nobody behind it takes what it
// needs. Admitted holders (dev servers, `admit`) charge memory only, live in
// `admitted/` and never take a slot file, so an older CLI never counts them.

const RSS_FILE = "rss.json";
const MAX_RSS_ENTRIES = 512;
const rssKey = (check: string, cwd: string): string => `${check}\u0000${cwd}`;

function readRss(dir: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, RSS_FILE), "utf8"));
    return isRecord(value) && isRecord(value.entries) ? value.entries : {};
  } catch {
    return {};
  }
}

/** The last measured peak RSS (bytes) of `check` run in `cwd`, or null. */
export function measuredRss(dir: string, check: string, cwd: string): number | null {
  const entry = readRss(dir)[rssKey(check, cwd)];
  return isRecord(entry) && typeof entry.bytes === "number" && entry.bytes > 0 ? entry.bytes : null;
}

/** Keep a check's measured peak RSS for its next charge. Best effort: a lost race drops one sample. */
export function recordPeakRss(
  dir: string,
  check: string,
  cwd: string,
  bytes: number,
  now = Date.now(),
): void {
  if (!(bytes > 0)) return;
  try {
    const entries = readRss(dir);
    const key = rssKey(check, cwd);
    delete entries[key];
    entries[key] = { bytes: Math.round(bytes), at: new Date(now).toISOString() };
    const kept = Object.fromEntries(Object.entries(entries).slice(-MAX_RSS_ENTRIES));
    const file = path.join(dir, RSS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ entries: kept })}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // The next run measures again.
  }
}

/** What `check` run in `cwd` takes from `budget`. */
export function checkCharge(budget: Budget, dir: string, check: string, cwd: string): Charge {
  const weight = budget.weights[check] ?? {};
  return {
    units: weight.units ?? 1,
    bytes: weight.bytes ?? measuredRss(dir, check, cwd) ?? budget.defaultBytes,
  };
}

/** What a holder's or waiter's record takes: older records weigh 1 unit and the default memory. */
function recordCharge(record: LeaseRecord | null | undefined, budget: Budget): Charge {
  const admitted = Boolean(record?.kind && record.kind !== "check");
  return {
    units: admitted ? 0 : typeof record?.units === "number" ? record.units : 1,
    bytes: Math.max(
      typeof record?.bytes === "number" ? record.bytes : budget.defaultBytes,
      record?.peakRssBytes ?? 0,
    ),
  };
}

/**
 * Does `own` fit once each waiter ahead (serving order) takes its charge? A
 * waiter ahead that does not fit is passed (backfill) unless it has waited
 * `agingMs`: then it holds the line. A charge over the whole budget counts
 * as the whole budget, so it runs alone. `memory` false counts units only.
 */
export function fitsBudget(
  budget: Pick<Budget, "units" | "memoryBytes" | "agingMs">,
  used: Charge,
  ahead: ReadonlyArray<{ charge: Charge; waitedMs: number }>,
  own: Charge,
  memory = true,
): boolean {
  const free = { units: budget.units - used.units, bytes: budget.memoryBytes - used.bytes };
  const fits = (charge: Charge) =>
    Math.min(charge.units, budget.units) <= free.units &&
    (!memory || Math.min(charge.bytes, budget.memoryBytes) <= free.bytes);
  for (const waiter of ahead) {
    if (fits(waiter.charge)) {
      free.units -= Math.min(waiter.charge.units, budget.units);
      free.bytes -= Math.min(waiter.charge.bytes, budget.memoryBytes);
    } else if (waiter.waitedMs >= budget.agingMs) return false;
  }
  return fits(own);
}

export const admittedDir = (dir: string): string => path.join(dir, "admitted");

export type AdmittedEntry = { file: string; record: LeaseRecord; stale: string | null };

/** The admitted holders (dev servers) in `dir`. Read-only: nothing is removed. */
export function admittedHolders(dir: string, probe: LeaseProbe = {}): AdmittedEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(admittedDir(dir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .flatMap((name) => {
      const file = path.join(admittedDir(dir), name);
      const record = parseLease(readText(file));
      return record ? [{ file, record, stale: staleReason(record, probe) }] : [];
    });
}

/** Live check holders and admitted holders, with what they take from `budget`. */
function budgetUse(
  dir: string,
  slots: number,
  budget: Budget,
  probe: LeaseProbe,
  maxHoldMs: number,
): { used: Charge; checks: LeaseHolder[]; admitted: LeaseHolder[] } {
  const used: Charge = { units: 0, bytes: 0 };
  const checks = liveSlots(dir, slotRange(dir, slots), probe, maxHoldMs);
  for (const { record } of checks.values()) {
    const charge = recordCharge(record, budget);
    used.units += charge.units;
    used.bytes += charge.bytes;
  }
  const admitted: LeaseHolder[] = [];
  for (const entry of admittedHolders(dir, probe)) {
    if (entry.stale) continue;
    used.bytes += recordCharge(entry.record, budget).bytes;
    admitted.push(holderOf(entry.record));
  }
  return { used, checks: [...checks.values()].map((slot) => slot.holder), admitted };
}

/** Run `fn` under the budget's mkdir guard; null when another process holds it. */
function underGuard<T>(dir: string, fn: () => T): T | null {
  const guard = path.join(dir, "budget.guard");
  try {
    fs.mkdirSync(guard);
  } catch {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_TTL_MS)
        fs.rmSync(guard, { force: true, recursive: true });
    } catch {
      // Gone already.
    }
    return null;
  }
  try {
    return fn();
  } finally {
    fs.rmSync(guard, { force: true, recursive: true });
  }
}

/** The pressure gate as a holder, so a wait line names it. */
const pressureHolder = (reading: PressureReading, now: number): LeaseHolder => ({
  pid: 0,
  check: describePressure(reading) ?? "pressure",
  cwd: "",
  session: null,
  startedAt: new Date(now).toISOString(),
  kind: "pressure",
});

/** The budget a lease acquisition uses: the caller's, else the one the CLI resolved for these slots. */
function budgetFor(options: AcquireOptions): Budget {
  if (options.budget) return options.budget;
  if (resolvedBudget && Math.min(MAX_SLOTS, resolvedBudget.units) === options.slots)
    return resolvedBudget;
  return slotsBudget(options.slots);
}

export type AdmitOptions = {
  /** The lease dir (leaseDir(env)). */
  dir: string;
  /** What holds the weight: `server` for a dev server. */
  kind: string;
  /** What runs ("vite", "docker compose up"), for the holder lines. */
  label: string;
  /** Its measured RSS in bytes (or its expected RSS before the first sample). */
  rssBytes: number;
  cwd: string;
  session: string | null;
  /** The holder's process (default: this one); the weight is freed once it is gone. */
  pid?: number;
  /** The registry's id, named in a refusal's unblock (`workit stop <id>`). */
  ref?: string | null;
  /** Default: the budget the CLI resolved, else the machine's defaults. */
  budget?: Budget;
  probe?: LeaseProbe;
  now?: number;
};

export type Admission = {
  record: LeaseRecord;
  file: string;
  /** Re-measure: charge `rssBytes` from now on. */
  update: (rssBytes: number) => void;
  release: () => void;
};

export type AdmitResult =
  | { ok: true; admission: Admission }
  | {
      ok: false;
      reason: "budget" | "pressure" | "unavailable";
      /** Who holds the memory budget (checks and admitted holders). */
      holders: LeaseHolder[];
      pressure: PressureReading | null;
      /** One line: what was refused and why. */
      line: string;
      unblock: string;
    };

const GUARD_TRIES = 40;
const pauseSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The accounting call for a long-lived holder (decider ruling 6): charge
 * `rssBytes` against the memory budget. It fits, and is recorded until
 * `release()` or its process ends; or it is refused at once, never queued,
 * naming the holders or the pressure and the unblock. It never takes a slot
 * or a queue ticket.
 */
export function admit(options: AdmitOptions): AdmitResult {
  const budget = options.budget ?? resolvedBudget ?? defaultBudget();
  const unblockFor = (holders: LeaseHolder[]) => {
    const refs = holders.flatMap((holder) => (holder.ref ? [holder.ref] : []));
    return `${refs.length ? `workit stop ${refs.join(" ")}, or ` : ""}start it with --no-lease --reason "<why>" (recorded in the ledger)`;
  };
  const pressure = budget.pressure?.() ?? null;
  if (pressure?.critical)
    return {
      ok: false,
      reason: "pressure",
      holders: [],
      pressure,
      line: `${options.label} not started: ${describePressure(pressure)}`,
      unblock: `wait for the pressure to drop, or ${unblockFor([])}`,
    };
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;
  const boot = bootId();
  const record: LeaseRecord = {
    id: randomUUID(),
    pid,
    processStart: processStart(pid),
    bootId: boot,
    bootTime: boot ? null : bootTime(),
    check: options.label,
    cwd: options.cwd,
    session: options.session,
    startedAt: new Date(now).toISOString(),
    scope: null,
    kind: options.kind,
    units: 0,
    bytes: Math.max(0, Math.round(options.rssBytes)),
    ref: options.ref ?? null,
  };
  const file = path.join(
    admittedDir(options.dir),
    `${String(now).padStart(15, "0")}-${record.id}.json`,
  );
  try {
    fs.mkdirSync(admittedDir(options.dir), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      holders: [],
      pressure,
      line: `${options.label}: the lease dir is unavailable: ${(error as Error).message}`,
      unblock: unblockFor([]),
    };
  }
  for (let attempt = 0; attempt < GUARD_TRIES; attempt += 1) {
    const outcome = underGuard(options.dir, () => {
      const probe = options.probe ?? {};
      for (const entry of admittedHolders(options.dir, probe))
        if (entry.stale) removeOwn(entry.file, entry.record.id);
      const use = budgetUse(options.dir, MAX_SLOTS, budget, probe, DEFAULT_MAX_HOLD_MS);
      const holders = [...use.checks, ...use.admitted];
      if (use.used.bytes + (record.bytes ?? 0) > budget.memoryBytes)
        return { ok: false as const, holders, used: use.used.bytes };
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      return { ok: true as const };
    });
    if (outcome === null) {
      pauseSync(5);
      continue;
    }
    if (!outcome.ok)
      return {
        ok: false,
        reason: "budget",
        holders: outcome.holders,
        pressure,
        line: `${options.label} not started: it needs ${formatBytes(record.bytes ?? 0)} and the memory budget has ${formatBytes(Math.max(0, budget.memoryBytes - outcome.used))} of ${formatBytes(budget.memoryBytes)} free (${formatBytes(budget.reserveBytes)} reserved for the desktop); held by ${outcome.holders.map((holder) => describeHolder(holder, now)).join("; ") || "nobody"}`,
        unblock: unblockFor(outcome.holders),
      };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off("exit", release);
      removeOwn(file, record.id);
    };
    if (pid === process.pid) process.on("exit", release);
    return {
      ok: true,
      admission: {
        record,
        file,
        update: (rssBytes) => {
          record.bytes = Math.max(0, Math.round(rssBytes));
          if (released || parseLease(readText(file))?.id !== record.id) return;
          const temp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
          fs.renameSync(temp, file);
        },
        release,
      },
    };
  }
  return {
    ok: false,
    reason: "unavailable",
    holders: [],
    pressure,
    line: `${options.label}: the budget guard stayed busy`,
    unblock: unblockFor([]),
  };
}

/** The machine's default budget, with the real pressure gate. */
const defaultBudget = (): Budget => withGate(resolveWith([], hostShape()).budget);

/**
 * `budget` reading the real pressure source, unless the machine turned the
 * gate off or WORKIT_NO_PRESSURE_GATE=1 (the test suite's preload sets it, so
 * the runner's own load never decides a test that is not about the gate).
 */
const withGate = (budget: Budget): Budget => ({
  ...budget,
  pressure:
    budget.pressureGate && process.env.WORKIT_NO_PRESSURE_GATE !== "1"
      ? () => readPressure()
      : null,
});

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

/** The note a cancel marker carries, or null when there is none. */
function cancelledBy(ticket: string): string | null {
  const text = readText(cancelMarker(ticket));
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.by === "string") return value.by;
  } catch {
    // A marker is a marker, whatever it says.
  }
  return "workit lock cancel";
}

/**
 * Take one of `slots` machine-wide lease slots. A slot free and nobody queued
 * ahead: it is taken at once. Otherwise the caller queues (a ticket in
 * `queue/`) and polls every `pollMs`, round-robin per session, up to
 * `waitMs`, which `onLimit` may extend once without losing its place;
 * `onStatus` reports its place now and then. A `workit lock cancel`
 * marker, or the end of the process that started this waiter, ends the wait
 * as `cancelled`. The returned lease is released by `release()`, and on
 * process exit as a backstop.
 */
export async function acquireLease(options: AcquireOptions): Promise<AcquireResult> {
  const clock = options.clock ?? realClock;
  const pid = options.pid ?? process.pid;
  const boot = bootId();
  const budget = budgetFor(options);
  // `slots` alone counts checks as before; any other budget weighs them.
  const weighted = budget.mode !== "slots";
  const charge = weighted ? checkCharge(budget, options.dir, options.check, options.cwd) : null;
  const record: LeaseRecord = {
    id: randomUUID(),
    pid,
    processStart: processStart(pid),
    bootId: boot,
    bootTime: boot ? null : bootTime(),
    pgid: null,
    pgidStart: null,
    maxAgeMs: options.maxAgeMs ?? null,
    check: options.check,
    cwd: options.cwd,
    session: options.session,
    startedAt: new Date(clock.now()).toISOString(),
    scope: null,
    heartbeatAt: null,
    maxHoldMs: options.holdMs ?? options.maxHoldMs ?? null,
    ...(charge ? { units: charge.units, bytes: charge.bytes } : {}),
  };
  try {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "unavailable", error: (error as Error).message };
  }
  const started = clock.now();
  const reclaimed: Reclaimed[] = [];
  let waitedOn: LeaseHolder[] = [];
  const name = ticketName(started, record.id);
  const ticket = path.join(queueDir(options.dir), name);
  const owner = options.ownerPid === undefined ? process.ppid : options.ownerPid;
  // A ticket outlives a waiter that never finds the slot it would take on
  // platforms without a process start time; its age bound is the wait.
  const ticketRecord: LeaseRecord = {
    ...record,
    maxAgeMs: options.waitMs + 60_000,
    ownerPid: typeof owner === "number" && owner > 1 ? owner : null,
    ownerStart: typeof owner === "number" && owner > 1 ? processStart(owner) : null,
    cancellable: true,
    slots: options.slots,
  };
  const self = holderOf(record);
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
    if (queued) {
      removeOwn(ticket, record.id);
      fs.rmSync(cancelMarker(ticket), { force: true });
    }
    queued = false;
  };
  let nextStatus = 0;
  let pressedSince: number | null = null;
  let limitMs = options.waitMs;
  let requeuedAfterMs: number | null = null;
  const maxHold = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  // Every waiter reads every slot file, whatever its own count, so all serve the queue in one order.
  const holding = () =>
    liveHolders(options.dir, slotRange(options.dir, options.slots), options.probe, maxHold);
  // Watching starts before the first read, so a release right after it still wakes this waiter.
  const wake = leaseWake(options.dir, clock, name, options.watch ?? true);
  try {
    for (;;) {
      const waited = clock.now() - started;
      if (queued) {
        const by = cancelledBy(ticket) ?? ownerGone(ticketRecord, options.probe);
        if (by) return { ok: false, reason: "cancelled", by, waitedMs: waited };
      }
      const before = holding();
      const waiters = waitersAhead(options, queued ? name : "~", self, [...before.values()]);
      const aheadOf = waiters.map((waiter) => waiter.holder);
      const ahead = aheadOf.length;
      const reading = budget.pressure?.() ?? null;
      if (reading?.critical) pressedSince ??= clock.now();
      else pressedSince = null;
      const pressed =
        reading?.critical &&
        clock.now() - (pressedSince ?? clock.now()) <
          (budget.pressureMaxWaitMs ?? PRESSURE_MAX_WAIT_MS)
          ? reading
          : null;
      const use = weighted
        ? budgetUse(options.dir, options.slots, budget, options.probe ?? {}, maxHold)
        : null;
      const fitsNow = (current: { used: Charge } | null, line: readonly Waiter[]) =>
        current && charge
          ? fitsBudget(
              budget,
              current.used,
              line.map((waiter) => ({
                charge: recordCharge(waiter.record, budget),
                waitedMs: clock.now() - Date.parse(waiter.holder.startedAt),
              })),
              charge,
              // A units budget is the owner's count: checks are weighed in units only.
              budget.mode !== "units",
            )
          : slotLeft(new Set(before.keys()), line, options.slots);
      if (!pressed && fitsNow(use, waiters)) {
        const now = new Date(clock.now()).toISOString();
        record.startedAt = now;
        record.heartbeatAt = now;
        // A weighted take re-checks the budget under its guard, so two waiters never both fit the same room.
        const outcome = weighted
          ? (underGuard(options.dir, () =>
              fitsNow(
                budgetUse(options.dir, options.slots, budget, options.probe ?? {}, maxHold),
                [],
              )
                ? tryOnce(options, record, reclaimed)
                : null,
            ) ?? { holders: [] })
          : tryOnce(options, record, reclaimed);
        if ("slot" in outcome) {
          recordGrant(options.dir, self, clock.now());
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
      // Name everything that keeps this check waiting: the pressure gate, the checks, the admitted holders.
      const holders = [
        ...(pressed ? [pressureHolder(pressed, clock.now())] : []),
        ...holding().values(),
        ...(use?.admitted ?? []),
      ];
      if (!waitedOn.length) {
        waitedOn = holders;
        options.onWait?.(holders);
      }
      if (waited >= limitMs) {
        const more =
          requeuedAfterMs === null
            ? (options.onLimit?.({
                position: ahead + 1,
                ahead,
                aheadOf,
                holders,
                waitedMs: waited,
                first: false,
              }) ?? 0)
            : 0;
        if (!(more > 0))
          return {
            ok: false,
            reason: "timeout",
            holders,
            waitedMs: waited,
            position: ahead + 1,
            requeuedAfterMs,
          };
        // Re-queued once in the same place: the ticket's age bound follows the new limit.
        requeuedAfterMs = waited;
        limitMs = waited + more;
        ticketRecord.maxAgeMs = limitMs + 60_000;
        if (queued && fs.existsSync(ticket)) writeTicket(ticket, ticketRecord);
      }
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
      } else if (!fs.existsSync(ticket) && !fs.existsSync(cancelMarker(ticket))) {
        // Wrongly reclaimed (a clock step past its age bound): stand in the same place again.
        writeTicket(ticket, ticketRecord);
      }
      if (waited >= nextStatus) {
        options.onStatus?.({
          position: ahead + 1,
          ahead,
          aheadOf,
          holders,
          waitedMs: waited,
          first: nextStatus === 0,
        });
        nextStatus = waited + (options.statusEveryMs ?? 30_000);
      }
      await wake.pause(Math.min(options.pollMs ?? 2000, Math.max(1, limitMs - waited)));
    }
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      error: (error as Error).message,
    };
  } finally {
    wake.close();
    leave();
  }
}

/**
 * Record the check's scope unit or process group on a held lease, so the lease
 * stays held while they run, even if workit itself is killed. Never writes
 * over a slot that is no longer this lease's.
 */
export function updateLease(
  lease: HeldLease,
  patch: Pick<
    Partial<LeaseRecord>,
    "scope" | "pgid" | "pgidStart" | "heartbeatAt" | "peakRssBytes"
  >,
) {
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
 * Record the check's process group on a held lease, with its leader's start
 * time read fresh (not cached), so a later reader can tell a recycled pgid.
 */
export const recordGroup = (lease: HeldLease, pgid: number) =>
  updateLease(lease, { pgid, pgidStart: processStartOf(pgid) });

/**
 * The lease an outer heavy check passed down as WORKIT_LEASE, when it is held
 * in `dir` by this process or one of its ancestors, or by the check group
 * this process runs in (its leader proven): the ancestor chain breaks once the
 * outer workit dies or a daemon re-parents to init. A nested heavy check
 * reuses it instead of queueing behind its own parent; a leaked or forged id
 * from an unrelated process is ignored.
 */
export function heldLease(
  dir: string,
  id: string | undefined,
  options: {
    probe?: LeaseProbe;
    ancestor?: (pid: number) => boolean;
    /** This process's group; null where it cannot be read (Windows, macOS). */
    group?: () => number | null;
  } = {},
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
      ((options.ancestor ?? isAncestor)(lease.pid) || inLeaseGroup(lease, options))
    )
      return lease;
  }
  return null;
}

/** Does this process run in the lease's check group, under the leader recorded with it? */
function inLeaseGroup(
  lease: LeaseRecord,
  options: { probe?: LeaseProbe; group?: () => number | null },
): boolean {
  const own = (options.group ?? ownGroup)();
  return own !== null && own === lease.pgid && groupState(lease, options.probe ?? {}) === "same";
}
/** "test, pid 123, 1m 40s, /repo/wt" for a waiting or timeout message; a stuck holder says so. */
export function describeHolder(holder: LeaseHolder, now = Date.now()): string {
  if (holder.kind === "pressure") return holder.check;
  const age = formatWait(now - Date.parse(holder.startedAt));
  if (holder.kind)
    return `${holder.kind} ${holder.check}${holder.ref ? ` (${holder.ref})` : ""}, pid ${holder.pid}, ${formatBytes(holder.bytes ?? 0)}${holder.session ? `, session ${holder.session}` : ""}, ${age}, ${holder.cwd}`;
  return `${holder.check}, pid ${holder.pid}${holder.session ? `, session ${holder.session}` : ""}, ${age}, ${holder.cwd}${holder.stuck ? `, stuck? (${holder.stuck})` : ""}`;
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
  /** Why its live holder looks stuck (`workit lock reap` frees it), or null. */
  stuck: string | null;
  /** Its charge on a weighted budget (absent on a counted lease). */
  units?: number;
  bytes?: number;
};

/**
 * What each of `slots` lease slots holds right now. Read-only: nothing is
 * reclaimed. `maxHoldMs` judges `stuck` for leases that do not carry their own.
 */
export function leaseSlots(
  dir: string,
  slots: number,
  probe: LeaseProbe = {},
  maxHoldMs = DEFAULT_MAX_HOLD_MS,
): SlotState[] {
  const states: SlotState[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const lease = parseLease(readText(path.join(dir, `slot-${slot}.json`)));
    const stale = lease ? staleReason(lease, probe) : null;
    const stuck = lease && !stale ? stuckReason(lease, maxHoldMs, probe.now) : null;
    states.push({
      slot,
      holder: lease ? { ...holderOf(lease), ...(stuck ? { stuck } : {}) } : null,
      stale,
      stuck,
      ...(typeof lease?.units === "number" ? { units: lease.units } : {}),
      ...(typeof lease?.bytes === "number"
        ? { bytes: Math.max(lease.bytes, lease.peakRssBytes ?? 0) }
        : {}),
    });
  }
  return states;
}
