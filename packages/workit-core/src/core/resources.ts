// Host resources for heavy checks (issue #282, slice 1): a machine-wide lease
// serializes heavy `workit check` runs across every agent and worktree, and on
// Linux with a delegated user systemd each heavy run gets its own
// `systemd-run --user --scope` with MemoryMax and CPUQuota, so parallel agents
// cannot push the desktop session into systemd-oomd.
//
// The lease is a set of slot files, `<state>/leases/slot-<n>.json`, created
// with O_EXCL: holding one is holding the lease. A slot whose holder pid is
// dead, whose boot id differs, or whose pid now belongs to another process is
// stale and reclaimed by the next acquirer under a short mkdir guard.
//
// Settings, later sources win: built-in defaults (derived from total RAM and
// CPUs), `resources` in workit.checks.json, `resources` in the matching
// workspaces.json entry (the machine owner's word). Only the CLI imports this
// module; hooks never do.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  /** systemd MemoryMax for a heavy check's scope (bytes, or a K/M/G/T size). */
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

/** "40%" of total RAM, or an absolute size ("8G", "8589934592"), as a systemd MemoryMax. */
function memoryValue(value: unknown, host: HostShape): string | Error {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const percent = PERCENT.exec(text.trim());
  if (percent) {
    const share = Number(percent[1]);
    if (share <= 0 || share > 100) return new Error(`memoryMax ${text} must be 1-100%`);
    return String(Math.floor((host.totalMemBytes * share) / 100));
  }
  const size = SIZE.exec(text.trim());
  if (size && Number(size[1]) > 0) return `${size[1]}${size[2].toUpperCase()}`;
  return new Error(`memoryMax must be a percent of RAM ("40%") or a size ("8G"), got ${text}`);
}

/** "70%" of the whole machine, or a CPU count (4 → "400%"), as a systemd CPUQuota. */
function cpuValue(value: unknown, host: HostShape): string | Error {
  if (typeof value === "number" && value > 0) return `${Math.round(value * 100)}%`;
  const percent = typeof value === "string" ? PERCENT.exec(value.trim()) : null;
  if (percent) {
    const share = Number(percent[1]);
    if (share <= 0 || share > 100) return new Error(`cpuQuota ${percent[0]} must be 1-100%`);
    return `${Math.max(1, Math.round(host.cpus * share))}%`;
  }
  return new Error(
    `cpuQuota must be a percent of the machine ("70%") or a CPU count, got ${String(value)}`,
  );
}

/**
 * Merge `resources` blocks (lowest precedence first) over the defaults.
 * Lenient: an invalid field is reported and its earlier value kept, so a typo
 * never turns the lease off.
 */
export function resolveResourceSettings(
  sources: Array<{ label: string; value: unknown }>,
  host: HostShape = hostShape(),
): { settings: ResourceSettings; warnings: string[] } {
  const settings: ResourceSettings = {
    slots: DEFAULT_SLOTS,
    heavy: [...DEFAULT_HEAVY_CHECKS],
    memoryMax: String(Math.floor(host.totalMemBytes * DEFAULT_MEMORY_SHARE)),
    cpuQuota: `${Math.max(1, Math.round(host.cpus * DEFAULT_CPU_SHARE * 100))}%`,
    waitMs: DEFAULT_WAIT_S * 1000,
    scope: true,
  };
  const warnings: string[] = [];
  for (const { label, value } of sources) {
    if (value === undefined || value === null) continue;
    if (!isRecord(value)) {
      warnings.push(`${label}: resources must be an object`);
      continue;
    }
    const warn = (field: string, message: string) =>
      warnings.push(`${label}: ${field}: ${message}`);
    if (value.slots !== undefined) {
      const slots = value.slots;
      if (typeof slots === "number" && Number.isInteger(slots) && slots >= 1 && slots <= MAX_SLOTS)
        settings.slots = slots;
      else warn("slots", `must be an integer 1-${MAX_SLOTS}`);
    }
    if (value.heavy !== undefined) {
      const heavy = isRecord(value.heavy) ? Object.keys(value.heavy) : value.heavy;
      if (Array.isArray(heavy) && heavy.every((item) => typeof item === "string"))
        settings.heavy = heavy;
      else warn("heavy", "must be a list of check names");
    }
    if (value.memoryMax !== undefined) {
      const memory = memoryValue(value.memoryMax, host);
      if (memory instanceof Error) warn("memoryMax", memory.message);
      else settings.memoryMax = memory;
    }
    if (value.cpuQuota !== undefined) {
      const cpu = cpuValue(value.cpuQuota, host);
      if (cpu instanceof Error) warn("cpuQuota", cpu.message);
      else settings.cpuQuota = cpu;
    }
    if (value.wait !== undefined) {
      if (typeof value.wait === "number" && value.wait >= 0) settings.waitMs = value.wait * 1000;
      else warn("wait", "must be a number of seconds");
    }
    if (value.scope !== undefined) {
      if (typeof value.scope === "boolean") settings.scope = value.scope;
      else warn("scope", "must be true or false");
    }
  }
  return { settings, warnings };
}

// ---------------------------------------------------------------------------
// the machine lease

/** Workit's state dir for `env` (the logger's resolution, over an explicit env). */
export function stateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  if (env.WORKFLOW_TOOLKIT_STATE) return env.WORKFLOW_TOOLKIT_STATE;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "workit");
  const home = env.HOME || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "workit");
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "workit");
  return path.join(home, ".local", "state", "workit");
}

export const leaseDir = (env: NodeJS.ProcessEnv): string => path.join(stateDir(env), "leases");

export type LeaseRecord = {
  id: string;
  pid: number;
  /** Field 22 of /proc/<pid>/stat, so a recycled pid does not keep a lease alive. */
  processStart: string | null;
  bootId: string | null;
  check: string;
  cwd: string;
  session: string | null;
  startedAt: string;
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

/** Start time of `pid` (Linux), parsed after the last ")" so a comm with spaces cannot shift it. */
export function processStart(pid: number): string | null {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

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

/** Why `lease` no longer holds anything, or null while its holder runs. */
export function staleReason(
  lease: LeaseRecord,
  probe: {
    alive?: (pid: number) => boolean;
    boot?: string | null;
    start?: (pid: number) => string | null;
  } = {},
): string | null {
  const boot = probe.boot === undefined ? bootId() : probe.boot;
  if (lease.bootId && boot && lease.bootId !== boot) return "taken before a reboot";
  if (!(probe.alive ?? pidAlive)(lease.pid)) return `holder pid ${lease.pid} is gone`;
  const start = (probe.start ?? processStart)(lease.pid);
  if (lease.processStart && start && start !== lease.processStart)
    return `pid ${lease.pid} now belongs to another process`;
  return null;
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
  /** Called once, when the first attempt finds every slot held. */
  onWait?: (holders: LeaseHolder[]) => void;
  /** Overrides for tests. */
  probe?: Parameters<typeof staleReason>[1];
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

/**
 * Take one of `slots` machine-wide lease slots, waiting (polling every
 * `pollMs`) up to `waitMs` for a live holder to finish. The returned lease is
 * released by `release()`, and on process exit as a backstop.
 */
export async function acquireLease(options: AcquireOptions): Promise<AcquireResult> {
  const pid = options.pid ?? process.pid;
  const record: LeaseRecord = {
    id: randomUUID(),
    pid,
    processStart: processStart(pid),
    bootId: bootId(),
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
        if (parseLease(readText(file))?.id === record.id) fs.rmSync(file, { force: true });
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

/** Record the scope unit on a held lease, so holders can be traced to their cgroup. */
export function noteLeaseScope(lease: HeldLease, unit: string): void {
  lease.record.scope = unit;
  try {
    if (parseLease(readText(lease.file))?.id === lease.record.id)
      fs.writeFileSync(lease.file, `${JSON.stringify(lease.record)}\n`, { mode: 0o600 });
  } catch {
    // The lease still holds; only the scope note is missing.
  }
}

/** Is `id` (an outer run's WORKIT_LEASE) a lease held in `dir`? A nested heavy check reuses it. */
export function heldLease(dir: string, id: string | undefined): LeaseRecord | null {
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
    if (lease?.id === id && !staleReason(lease)) return lease;
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
export const SCOPE_START_FAILURE =
  /^(?:Failed to (?:connect to bus|create bus connection|start transient scope unit|parse \S+?=)[^\n]*)/u;

/**
 * Should the "no scope" notice print? Once per session: a marker under the
 * state dir records that this session was told.
 */
export function firstNotice(env: NodeJS.ProcessEnv, session: string | null, key: string): boolean {
  const id = (session ?? `ppid-${process.ppid}`).replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120);
  const file = path.join(stateDir(env), "notices", `${key}-${id}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EEXIST";
  }
}
