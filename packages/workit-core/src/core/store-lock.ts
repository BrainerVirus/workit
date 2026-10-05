import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import * as z from "zod";
import { canonicalJson } from "./task-contract";
import { checkoutSlug, resolveStore } from "../store/paths";

/**
 * Ownership rules for the workit store's locks: a checkout's
 * `checkouts/<slug>/metadata.lock` and each task's `tasks/<id>/lock`.
 *
 * The lock is a short mutex around one store mutation (or one managed effect).
 * A lock whose owner is gone is reclaimed automatically; a lock whose owner is
 * alive is contention, which callers report as retryable `busy`.
 */

export type MetadataLock = {
  pid: number;
  processStart: string | null;
  host: string;
  nonce: string;
};

const metadataLockSchema = z
  .object({
    pid: z.number().int().nonnegative().safe(),
    processStart: z.string().nullable(),
    host: z.string().min(1),
    nonce: z.string().min(1),
    /** Written by ≤4.x managed external actions; read and ignored (D17). */
    externalAction: z.literal(true).optional(),
  })
  .strict();

/** A lock from another host cannot be checked for liveness; trust it this long. */
export const FOREIGN_LOCK_TTL_MS = 10 * 60_000;
/** An empty or unparseable lock is a writer mid-create; after this it is debris. */
export const UNREADABLE_LOCK_TTL_MS = 30_000;
/** A reclaim guard lives for microseconds; one older than this was abandoned. */
export const RECLAIM_GUARD_TTL_MS = 30_000;
/**
 * Total time a mutation waits for a live holder before returning `busy`. The
 * wait blocks the calling thread, so in-process hosts (OpenCode, MCP, Pi) keep
 * the short default; the CLI raises it for its own process.
 */
let defaultLockTimeoutMs = 250;
export const defaultLockTimeout = (): number => defaultLockTimeoutMs;
export const setDefaultLockTimeout = (ms: number): void => {
  defaultLockTimeoutMs = ms;
};

export const parseMetadataLock = (raw: string): MetadataLock => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("metadata lock is invalid"), { code: "metadata_lock_invalid" });
  }
  const parsed = metadataLockSchema.safeParse(value);
  if (!parsed.success)
    throw Object.assign(new Error("metadata lock is invalid"), { code: "metadata_lock_invalid" });
  return parsed.data;
};

/** Lenient variant for the acquire loop: an unreadable lock is classified by age. */
export const parseMetadataLockOrNull = (raw: string): MetadataLock | null => {
  try {
    return parseMetadataLock(raw);
  } catch {
    return null;
  }
};

export const sameMetadataLock = (left: unknown, right: MetadataLock): boolean => {
  const parsed = metadataLockSchema.safeParse(left);
  return parsed.success && canonicalJson(parsed.data) === canonicalJson(right);
};

/** Field 22 (starttime) of /proc/<pid>/stat; parsed after the last ")" so a comm with spaces cannot shift it. */
export const parseProcStatStart = (stat: string): string | null => {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // After ")": field 3 (state) is index 0, so field 22 is index 19.
  return (
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[19] ?? null
  );
};

export const processStartOf = (pid: number): string | null => {
  if (process.platform === "linux") {
    try {
      return parseProcStatStart(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
      });
      const value = run.status === 0 ? run.stdout.trim() : "";
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
};

const readTrimmed = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
};

/**
 * Identity of the pid space this process lives in: hostname plus, on Linux,
 * the pid-namespace inode and boot id. Containers that share the hostname
 * (`--network host`) but not the pid namespace get a different identity, so
 * their pids are never checked against this process table. Folded into the
 * existing `host` string so older Workit versions still parse the lock.
 */
let cachedLockHost: string | null = null;
export const localLockHost = (): string => {
  if (cachedLockHost !== null) return cachedLockHost;
  let pidns: string | null = null;
  try {
    pidns = /\[(\d+)\]/.exec(fs.readlinkSync("/proc/self/ns/pid"))?.[1] ?? null;
  } catch {}
  const boot = readTrimmed("/proc/sys/kernel/random/boot_id");
  cachedLockHost = pidns || boot ? `${hostname()}#${pidns ?? "?"}:${boot ?? "?"}` : hostname();
  return cachedLockHost;
};

const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as { code?: unknown }).code === "EPERM";
  }
};

export type LockOwnerState = {
  /** live: wait. stale: reclaim. unknown: wait (cannot prove the owner is gone). */
  state: "live" | "stale" | "unknown";
  reason: string;
};

export const classifyLockOwner = (
  payload: unknown,
  ageMs: number | null,
  localHost: string = localLockHost(),
): LockOwnerState => {
  const lock = metadataLockSchema.safeParse(payload);
  if (!lock.success)
    return ageMs !== null && ageMs > UNREADABLE_LOCK_TTL_MS
      ? { state: "stale", reason: "unreadable lock left behind" }
      : { state: "unknown", reason: "lock is being written" };
  const { pid, processStart, host } = lock.data;
  // Same host and pid namespace but another boot: the machine rebooted since
  // the lock was taken, so its owner cannot still be running.
  const [lockName, lockSpace] = host.split("#");
  const [localName, localSpace] = localHost.split("#");
  if (lockSpace && localSpace && lockName === localName) {
    const [lockNs, lockBoot] = lockSpace.split(":");
    const [localNs, localBoot] = localSpace.split(":");
    if (lockNs === localNs && lockNs !== "?" && lockBoot !== "?" && lockBoot !== localBoot)
      return { state: "stale", reason: "lock was taken before this machine rebooted" };
  }
  // Another host, another pid namespace, or a lock written by an older Workit
  // without namespace identity: its pid cannot be checked here.
  if (host !== localHost)
    return ageMs !== null && ageMs > FOREIGN_LOCK_TTL_MS
      ? { state: "stale", reason: `lock from ${host} is older than its TTL` }
      : { state: "unknown", reason: `lock is held from ${host}; its pid cannot be checked here` };
  if (!pidAlive(pid)) return { state: "stale", reason: `pid ${pid} is not running` };
  const currentStart = processStartOf(pid);
  if (processStart !== null && currentStart !== null && processStart !== currentStart)
    return { state: "stale", reason: `pid ${pid} now belongs to a different process` };
  return { state: "live", reason: `held by running pid ${pid}` };
};

const ageOf = (file: string, nowMs: number): number | null => {
  try {
    return nowMs - fs.lstatSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/** A checkout's lock in the task store (see core/task-store.ts). */
export const lockPathFor = (root: string): string => {
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(real);
  } catch {}
  const location = resolveStore(real);
  const dir = location instanceof Error ? path.join(real, ".workit") : location.dir;
  return path.join(dir, "checkouts", checkoutSlug(real), "metadata.lock");
};

/** Remove a reclaim guard abandoned by a crashed reclaimer. Returns true when removed. */
export const clearAbandonedReclaimGuard = (lockPath: string, nowMs = Date.now()): boolean => {
  const guard = `${lockPath}.reclaim`;
  const age = ageOf(guard, nowMs);
  if (age === null || age <= RECLAIM_GUARD_TTL_MS) return false;
  try {
    fs.rmdirSync(guard);
    return true;
  } catch {
    return false;
  }
};

export type MetadataLockStatus = {
  path: string;
  present: boolean;
  owner: MetadataLock | null;
  state: LockOwnerState["state"] | "absent";
  reason: string;
  guard: "absent" | "fresh" | "abandoned";
  /** Exact lock bytes that were classified (for compare-before-remove). */
  raw?: string;
  /** Age of the lock file in milliseconds, when present. */
  ageMs?: number | null;
};

/** Read-only inspection of a checkout's metadata lock (doctor surface). */
export const inspectMetadataLock = (root: string, nowMs = Date.now()): MetadataLockStatus => {
  const lockPath = lockPathFor(root);
  const guardAge = ageOf(`${lockPath}.reclaim`, nowMs);
  const guard =
    guardAge === null ? "absent" : guardAge > RECLAIM_GUARD_TTL_MS ? "abandoned" : "fresh";
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return {
      path: lockPath,
      present: false,
      owner: null,
      state: "absent",
      reason: "no lock",
      guard,
    };
  }
  const owner = parseMetadataLockOrNull(raw);
  const ageMs = ageOf(lockPath, nowMs);
  const verdict = classifyLockOwner(owner, ageMs);
  return { path: lockPath, present: true, owner, ...verdict, guard, raw, ageMs };
};

export type ClearLockOutcome = MetadataLockStatus & {
  cleared: boolean;
  guardCleared: boolean;
  /** Why the lock was kept, when it was present and not cleared. */
  skipped?: string;
};

/**
 * Clear a stale metadata lock (or, with `force`, any lock) and an abandoned
 * reclaim guard. Removal holds the same `.reclaim` guard that writers take
 * before reclaiming, so no writer can replace the lock between the final
 * byte check and the unlink; a fresh guard means a reclaim is already in
 * progress and the lock is left alone.
 */
export const clearStaleMetadataLock = (
  root: string,
  options: { force?: boolean; nowMs?: number } = {},
): ClearLockOutcome => {
  const nowMs = options.nowMs ?? Date.now();
  const status = inspectMetadataLock(root, nowMs);
  const guardCleared = status.guard === "abandoned" && clearAbandonedReclaimGuard(status.path);
  const outcome = { ...status, cleared: false, guardCleared };
  if (!status.present) return outcome;
  if (status.state !== "stale" && !options.force) return { ...outcome, skipped: status.reason };
  const guard = `${status.path}.reclaim`;
  try {
    fs.mkdirSync(guard);
  } catch {
    return { ...outcome, skipped: "a reclaim is in progress" };
  }
  try {
    const before = fs.readFileSync(status.path, "utf8");
    if (before !== status.raw) return { ...outcome, skipped: "the lock changed" };
    if (!options.force) {
      const verdict = classifyLockOwner(parseMetadataLockOrNull(before), ageOf(status.path, nowMs));
      if (verdict.state !== "stale") return { ...outcome, skipped: verdict.reason };
    }
    if (fs.readFileSync(status.path, "utf8") !== before)
      return { ...outcome, skipped: "the lock changed" };
    fs.rmSync(status.path);
    return { ...outcome, cleared: true };
  } catch (error) {
    return { ...outcome, skipped: `could not clear: ${String(error)}` };
  } finally {
    try {
      fs.rmdirSync(guard);
    } catch {}
  }
};
