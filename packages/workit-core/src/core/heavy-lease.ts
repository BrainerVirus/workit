// Heavy-check lease hygiene (issue #608), over the lease in resources.ts:
// prune what no longer holds or waits, reap a stuck holder, cancel queued
// waiters, and keep a holder's heartbeat while its check prints or uses CPU.
// Only the CLI imports this module; hooks never do.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  cancelMarker,
  leaseQueue,
  leaseSlots,
  parseLease,
  processStart,
  queueDir,
  reclaim,
  staleReason,
  stuckReason,
  ticketStale,
  updateLease,
  type HeldLease,
  type LeaseHolder,
  type LeaseProbe,
  type LeaseRecord,
} from "./resources";

const readLease = (file: string): LeaseRecord | null => {
  try {
    return parseLease(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const slotFile = (dir: string, slot: number): string => path.join(dir, `slot-${slot}.json`);

/** A cancel marker whose ticket is gone is debris after this. */
const MARKER_TTL_MS = 10 * 60_000;

export type Pruned = LeaseHolder & { reason: string; kind: "slot" | "waiter" };

/**
 * Free every slot whose holder is gone and drop every queued waiter whose
 * process or owner is gone, each under the reclaim guard; clear old cancel
 * markers. What `workit lock status` runs before it reads.
 */
export function pruneLease(dir: string, slots: number, probe: LeaseProbe = {}): Pruned[] {
  const pruned: Pruned[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const file = slotFile(dir, slot);
    const lease = readLease(file);
    if (!lease) continue;
    let reason: string | null = null;
    const removed = reclaim(file, (current) => {
      reason = current ? staleReason(current, probe) : null;
      return reason !== null;
    });
    if (removed && reason) pruned.push({ ...holderFields(lease), reason, kind: "slot" });
  }
  for (const entry of leaseQueue(dir, probe)) {
    if (!entry.stale) continue;
    const stale = entry.stale;
    if (reclaim(entry.file, (current) => !current || ticketStale(current, probe) !== null))
      pruned.push({ ...entry.holder, reason: stale, kind: "waiter" });
  }
  try {
    const queue = queueDir(dir);
    for (const name of fs.readdirSync(queue)) {
      if (!name.endsWith(".cancel")) continue;
      const marker = path.join(queue, name);
      if (
        !fs.existsSync(marker.slice(0, -".cancel".length)) &&
        (probe.now ?? Date.now()) - fs.statSync(marker).mtimeMs > MARKER_TTL_MS
      )
        fs.rmSync(marker, { force: true });
    }
  } catch {
    // No queue yet.
  }
  return pruned;
}

const holderFields = (lease: LeaseRecord): LeaseHolder => ({
  pid: lease.pid,
  check: lease.check,
  cwd: lease.cwd,
  session: lease.session,
  startedAt: lease.startedAt,
});

/** A `workit lock reap` or `cancel` target: a pid, a session id (or its prefix) or a directory. */
export type LeaseTarget = { pid: number } | { session: string } | { dir: string };

export function parseTarget(text: string, cwd: string): LeaseTarget {
  if (/^\d+$/u.test(text)) return { pid: Number(text) };
  if (text.includes("/") || text.includes(path.sep) || text === "." || text === "..")
    return { dir: path.resolve(cwd, text) };
  return { session: text.replace(/…$/u, "") };
}

const within = (dir: string, cwd: string): boolean => {
  const relative = path.relative(dir, path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export function matchesTarget(holder: LeaseHolder, target: LeaseTarget): boolean {
  if ("pid" in target) return holder.pid === target.pid;
  if ("session" in target)
    return (
      holder.session !== null &&
      (holder.session === target.session ||
        (target.session.length >= 8 && holder.session.startsWith(target.session)))
    );
  return within(target.dir, holder.cwd);
}

export type Reaped = LeaseHolder & { slot: number; reason: string };

/**
 * Free every slot whose live holder is stuck (stuckReason), or only those
 * matching `target`. The holder's process is not signalled: it keeps running
 * outside the lease, and its own release never touches the slot again.
 */
export function reapStuck(
  dir: string,
  slots: number,
  maxHoldMs: number,
  options: { target?: LeaseTarget | null; probe?: LeaseProbe } = {},
): Reaped[] {
  const reaped: Reaped[] = [];
  for (const state of leaseSlots(dir, slots, options.probe, maxHoldMs)) {
    if (!state.holder || !state.stuck || state.stale) continue;
    if (options.target && !matchesTarget(state.holder, options.target)) continue;
    const file = slotFile(dir, state.slot);
    let reason: string | null = null;
    const removed = reclaim(file, (current) => {
      reason =
        current && !staleReason(current, options.probe)
          ? stuckReason(current, maxHoldMs, options.probe?.now)
          : null;
      return reason !== null;
    });
    if (removed && reason)
      reaped.push({ ...state.holder, stuck: reason, slot: state.slot, reason });
  }
  return reaped;
}

export type Cancelled = LeaseHolder & { how: "marker" | "signal" | "gone" };

/**
 * Drop the queued waiters matching `target`. A waiter that reads cancel
 * markers gets one and its ticket is removed at once; an older waiter gets
 * SIGTERM, which makes it leave the queue itself.
 */
export function cancelWaiters(
  dir: string,
  target: LeaseTarget,
  by: string,
  probe: LeaseProbe & { signal?: (pid: number) => boolean } = {},
): Cancelled[] {
  const cancelled: Cancelled[] = [];
  for (const entry of leaseQueue(dir, probe)) {
    if (!matchesTarget(entry.holder, target)) continue;
    const record = entry.record;
    if (entry.stale || !record) {
      if (reclaim(entry.file, (current) => !current || ticketStale(current, probe) !== null))
        cancelled.push({ ...entry.holder, how: "gone" });
      continue;
    }
    if (record.cancellable) {
      try {
        fs.writeFileSync(
          cancelMarker(entry.file),
          `${JSON.stringify({ by, at: new Date().toISOString() })}\n`,
          { mode: 0o600 },
        );
      } catch {
        continue;
      }
      if (readLease(entry.file)?.id === record.id) fs.rmSync(entry.file, { force: true });
      cancelled.push({ ...entry.holder, how: "marker" });
      continue;
    }
    const start = record.processStart ? processStart(record.pid) : null;
    if (record.processStart && start !== record.processStart) continue;
    if ((probe.signal ?? terminate)(record.pid)) cancelled.push({ ...entry.holder, how: "signal" });
  }
  return cancelled;
}

const terminate = (pid: number): boolean => {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
};

/** `[[dd-]hh:]mm:ss[.cc]` from `ps` as hundredths of a second, or null. */
function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Math.round(total * 100);
}

/** CPU hundredths of a second used so far by process group `pgid` (macOS, via `ps`), or null. */
export function psGroupCpu(pgid: number, run: typeof spawnSync = spawnSync): number | null {
  const result = run("ps", ["-axo", "pgid=,cputime="], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  let total = 0;
  let seen = false;
  for (const line of result.stdout.split("\n")) {
    const [group, cputime] = line.trim().split(/\s+/u);
    if (Number(group) !== pgid || cputime === undefined) continue;
    const ticks = parseCpuTime(cputime);
    if (ticks === null) continue;
    seen = true;
    total += ticks;
  }
  return seen ? total : null;
}

/** CPU ticks used so far by the processes of group `pgid` (Linux, macOS), or null. */
export function groupCpuTicks(pgid: number): number | null {
  if (!(pgid > 0)) return null;
  if (process.platform === "darwin") return psGroupCpu(pgid);
  if (process.platform !== "linux") return null;
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  let total = 0;
  let seen = false;
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) !== pgid) continue;
    seen = true;
    // utime, stime, cutime, cstime: fields 14-17 of /proc/<pid>/stat.
    total += [11, 12, 13, 14].reduce((sum, at) => sum + (Number(fields[at]) || 0), 0);
  }
  return seen ? total : null;
}

/** Heartbeats are written at most this often. */
export const HEARTBEAT_EVERY_MS = 30_000;

export type Heartbeat = { touch: () => void; stop: () => void };

/**
 * Refresh the held lease's `heartbeatAt` every `everyMs` while its check
 * printed since the last beat (`touch`) or its process group used CPU.
 */
export function startHeartbeat(
  lease: HeldLease,
  options: { everyMs?: number; cpu?: () => number | null; now?: () => number } = {},
): Heartbeat {
  let active = false;
  let lastCpu: number | null = null;
  const cpu = options.cpu ?? (() => (lease.record.pgid ? groupCpuTicks(lease.record.pgid) : null));
  const timer = setInterval(() => {
    const ticks = cpu();
    const moved = ticks !== null && lastCpu !== null && ticks > lastCpu;
    if (ticks !== null) lastCpu = ticks;
    if (!active && !moved) return;
    active = false;
    updateLease(lease, {
      heartbeatAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    });
  }, options.everyMs ?? HEARTBEAT_EVERY_MS);
  timer.unref?.();
  return {
    touch: () => {
      active = true;
    },
    stop: () => clearInterval(timer),
  };
}
