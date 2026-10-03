import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import * as z from "zod";
import { canonicalJson } from "./task-contract";

/**
 * Ownership rules for a checkout's `.workit/metadata.lock`.
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
  externalAction?: true;
};

const metadataLockSchema = z
  .object({
    pid: z.number().int().nonnegative().safe(),
    processStart: z.string().nullable(),
    host: z.string().min(1),
    nonce: z.string().min(1),
    externalAction: z.literal(true).optional(),
  })
  .strict();

/** A lock from another host cannot be checked for liveness; trust it this long. */
export const FOREIGN_LOCK_TTL_MS = 10 * 60_000;
/** An empty or unparseable lock is a writer mid-create; after this it is debris. */
export const UNREADABLE_LOCK_TTL_MS = 30_000;
/** A reclaim guard lives for microseconds; one older than this was abandoned. */
export const RECLAIM_GUARD_TTL_MS = 30_000;
/** How long a mutation waits for a live holder before returning `busy`. */
export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

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

export const processStartOf = (pid: number): string | null => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null;
  } catch {
    return null;
  }
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
  localHost: string = hostname(),
): LockOwnerState => {
  const lock = metadataLockSchema.safeParse(payload);
  if (!lock.success)
    return ageMs !== null && ageMs > UNREADABLE_LOCK_TTL_MS
      ? { state: "stale", reason: "unreadable lock left behind" }
      : { state: "unknown", reason: "lock is being written" };
  const { pid, processStart, host } = lock.data;
  if (host !== localHost)
    return ageMs !== null && ageMs > FOREIGN_LOCK_TTL_MS
      ? { state: "stale", reason: `lock from host ${host} is older than its TTL` }
      : { state: "unknown", reason: `lock is held from host ${host}` };
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

export const lockPathFor = (root: string) => path.join(root, ".workit", "metadata.lock");

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
  const verdict = classifyLockOwner(owner, ageOf(lockPath, nowMs));
  return { path: lockPath, present: true, owner, ...verdict, guard };
};

export type ClearLockOutcome = MetadataLockStatus & { cleared: boolean; guardCleared: boolean };

/**
 * Clear a stale metadata lock and an abandoned reclaim guard. A live or
 * unverifiable lock is never removed; the lock is only deleted when its bytes
 * are unchanged since classification.
 */
export const clearStaleMetadataLock = (root: string, nowMs = Date.now()): ClearLockOutcome => {
  const status = inspectMetadataLock(root, nowMs);
  const guardCleared = status.guard === "abandoned" && clearAbandonedReclaimGuard(status.path);
  let cleared = false;
  if (status.state === "stale") {
    try {
      const before = fs.readFileSync(status.path, "utf8");
      const verdict = classifyLockOwner(parseMetadataLockOrNull(before), ageOf(status.path, nowMs));
      if (verdict.state === "stale" && fs.readFileSync(status.path, "utf8") === before) {
        fs.rmSync(status.path);
        cleared = true;
      }
    } catch {
      cleared = false;
    }
  }
  return { ...status, cleared, guardCleared };
};
