// The process-table reads and signals the process registry (#328) needs: is a
// pid the process we recorded (its start time, ruling C), is a process group
// still alive, how much memory a group holds, and stopping a group with a
// grace (SIGTERM, then SIGKILL).
//
// Every read goes through `procTree`, so tests can act as another platform or
// fake a sampler. Windows has no process groups and no start time Workit can
// read, so a stop there is report-only (decider ruling C).
import { spawnSync } from "node:child_process";
import { processStartOf } from "./store-lock";

/** How long a stop waits after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 10_000;

const POLL_MS = 100;

export const procTree = {
  platform: process.platform,
  /** The pid's start time; null when it is gone or cannot be read. */
  start: (pid: number): string | null => processStartOf(pid),
  /** Signal `target` (a negative number names a process group). */
  kill: (target: number, signal: NodeJS.Signals | 0): void => {
    process.kill(target, signal);
  },
  /** `ps -A -o pgid=,rss=` output (rss in KiB), or null when ps cannot run. */
  table: (): string | null => {
    const run = spawnSync("ps", ["-A", "-o", "pgid=,rss="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return run.status === 0 ? run.stdout : null;
  },
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
};

/** True while `target` (a pid, or a negative group id) can be signalled by someone. */
const signalable = (target: number): boolean => {
  try {
    procTree.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const pidAlive = (pid: number): boolean => pid > 0 && signalable(pid);

export const groupAlive = (pgid: number): boolean => pgid > 0 && signalable(-pgid);

/**
 * What `pid` is now against the start time recorded for it: `same` (still
 * that process), `gone`, `reused` (another process took the pid) or
 * `unknown` (no recorded start, or one that cannot be read here).
 */
export function identity(
  pid: number,
  recordedStart: string | null,
): "same" | "gone" | "reused" | "unknown" {
  if (!pidAlive(pid)) return "gone";
  if (!recordedStart) return "unknown";
  const now = procTree.start(pid);
  if (now === null) return pidAlive(pid) ? "unknown" : "gone";
  return now === recordedStart ? "same" : "reused";
}

/** The resident memory of every process in group `pgid`, in bytes; null when unreadable. */
export function groupRss(pgid: number): number | null {
  if (procTree.platform === "win32") return null;
  const table = procTree.table();
  if (table === null) return null;
  let kib = 0;
  let seen = false;
  for (const line of table.split("\n")) {
    const [group, rss] = line.trim().split(/\s+/u).map(Number);
    if (group === pgid && Number.isFinite(rss)) {
      kib += rss;
      seen = true;
    }
  }
  return seen ? kib * 1024 : null;
}

export type StopTarget = { pid: number | null; pgid: number | null; pidStart: string | null };

export type GroupStop =
  /** The group ended after SIGTERM. */
  | { outcome: "stopped"; signal: "SIGTERM" }
  /** It outlived the grace and got SIGKILL. */
  | { outcome: "stopped"; signal: "SIGKILL" }
  /** Nothing of it was running. */
  | { outcome: "gone" }
  /** The pid now belongs to another process: nothing was signalled. */
  | { outcome: "reused" }
  /** It could not be stopped here; the detail says why. */
  | { outcome: "refused"; detail: string };

/**
 * The leader is still ours (or gone while its group lives on: a live group's
 * id is never handed out as a new pid, so the group is still ours).
 */
const stillOurs = (target: StopTarget): "ours" | "gone" | "reused" => {
  const leader = target.pid ? identity(target.pid, target.pidStart) : "gone";
  if (leader === "reused") return "reused";
  if (leader === "gone") return target.pgid && groupAlive(target.pgid) ? "ours" : "gone";
  return "ours";
};

/**
 * Stop a recorded process group: SIGTERM, wait `graceMs` for it to end, then
 * SIGKILL. The leader's start time is checked before each signal, so a pid
 * another process took is never signalled.
 */
export async function stopGroup(
  target: StopTarget,
  graceMs: number = STOP_GRACE_MS,
): Promise<GroupStop> {
  if (procTree.platform === "win32")
    return {
      outcome: "refused",
      detail:
        "Windows has no process group or start time Workit can check, so the stop is report-only; end it in Task Manager",
    };
  const pgid = target.pgid ?? target.pid;
  if (!pgid) return { outcome: "gone" };
  const before = stillOurs(target);
  if (before !== "ours") return { outcome: before };
  try {
    procTree.kill(-pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { outcome: "gone" };
    return { outcome: "refused", detail: (error as Error).message };
  }
  const deadline = procTree.now() + graceMs;
  while (procTree.now() < deadline) {
    if (!groupAlive(pgid)) return { outcome: "stopped", signal: "SIGTERM" };
    await procTree.sleep(POLL_MS);
  }
  if (!groupAlive(pgid)) return { outcome: "stopped", signal: "SIGTERM" };
  // Check again: the leader may have exited and its pid been reused during the grace.
  if (stillOurs(target) === "reused") return { outcome: "reused" };
  try {
    procTree.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      return { outcome: "refused", detail: (error as Error).message };
  }
  return { outcome: "stopped", signal: "SIGKILL" };
}
