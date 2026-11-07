// A live `workit ci wait` (retro 2026-11-07 R4, D4): the wait claims a marker
// keyed by repository and PR, holding its pid, process start, the head it
// waits on and a wall-clock deadline. The Stop hook reads it so a lead whose
// wait was moved to the background is not told to start another, and a
// second `ci wait` for the same PR and head reports the first instead of
// polling again. A marker whose process died, whose pid was reused, or whose
// deadline passed is not live.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "./git/rev";
import { localLockHost, processStartOf } from "./core/store-lock";

export type CiWaiter = {
  pr: number;
  /** The head the wait is on: `--head`, else the PR head of its first poll; null before it. */
  head: string | null;
  pid: number;
  /** The pid's start, so a reused pid is not mistaken for the wait. */
  start: string | null;
  /** The pid space the pid belongs to. */
  host: string;
  startedAt: number;
  /** Wall-clock ms past which the wait has ended, whatever its pid. */
  deadline: number;
};

/** Slack past the wait's timeout for the final status build. */
export const CI_WAITER_SLACK_MS = 60_000;

const waiterFile = (cwd: string, pr: number): string | null => {
  const common = gitCommonDir(cwd);
  return common ? path.join(common, "workit", "ci-waits", `pr-${pr}.json`) : null;
};

const pidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const parse = (raw: string): CiWaiter | null => {
  try {
    const value = JSON.parse(raw) as Partial<CiWaiter>;
    if (
      typeof value.pr !== "number" ||
      typeof value.pid !== "number" ||
      typeof value.deadline !== "number" ||
      typeof value.host !== "string" ||
      typeof value.startedAt !== "number"
    )
      return null;
    return {
      pr: value.pr,
      head: typeof value.head === "string" ? value.head : null,
      pid: value.pid,
      start: typeof value.start === "string" ? value.start : null,
      host: value.host,
      startedAt: value.startedAt,
      deadline: value.deadline,
    };
  } catch {
    return null;
  }
};

/** Is the marker's wait still running: same pid space, pid alive with the same start, before its deadline? */
export const waiterLive = (waiter: CiWaiter, nowMs: number = Date.now()): boolean => {
  if (nowMs >= waiter.deadline || waiter.host !== localLockHost()) return false;
  if (!pidAlive(waiter.pid)) return false;
  const start = processStartOf(waiter.pid);
  return waiter.start === null || start === null || start === waiter.start;
};

/**
 * Another process's live wait on `pr`, or null. With `head`, only a wait on
 * that head (or one that has not polled yet) counts.
 */
export const liveCiWaiter = (
  cwd: string,
  pr: number,
  head: string | null = null,
  nowMs: number = Date.now(),
): CiWaiter | null => {
  try {
    const file = waiterFile(cwd, pr);
    if (!file) return null;
    const waiter = parse(fs.readFileSync(file, "utf8"));
    if (!waiter || waiter.pr !== pr || waiter.pid === process.pid) return null;
    if (head && waiter.head && !sameSha(waiter.head, head)) return null;
    return waiterLive(waiter, nowMs) ? waiter : null;
  } catch {
    return null;
  }
};

const sameSha = (left: string, right: string): boolean =>
  left.length >= right.length ? left.startsWith(right) : right.startsWith(left);

const write = (file: string, waiter: CiWaiter): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(waiter)}\n`);
  fs.renameSync(temp, file);
};

export type CiWaiterClaim = {
  /** Record the head the wait is on once it is known. */
  setHead: (head: string) => void;
  /** Remove the marker if it is still this process's. */
  release: () => void;
};

/** Claim the marker for this process's wait on `pr`. Never throws: a failed write leaves no marker. */
export const claimCiWaiter = (
  cwd: string,
  pr: number,
  options: { head: string | null; timeoutMs: number; nowMs?: number },
): CiWaiterClaim => {
  const file = waiterFile(cwd, pr);
  const startedAt = options.nowMs ?? Date.now();
  const waiter: CiWaiter = {
    pr,
    head: options.head,
    pid: process.pid,
    start: processStartOf(process.pid),
    host: localLockHost(),
    startedAt,
    deadline: startedAt + options.timeoutMs + CI_WAITER_SLACK_MS,
  };
  const ours = (): boolean => {
    try {
      return file !== null && parse(fs.readFileSync(file, "utf8"))?.pid === process.pid;
    } catch {
      return false;
    }
  };
  try {
    if (file) write(file, waiter);
  } catch {}
  return {
    setHead: (head) => {
      if (waiter.head === head || !file || !ours()) return;
      waiter.head = head;
      try {
        write(file, waiter);
      } catch {}
    },
    release: () => {
      if (!file || !ours()) return;
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    },
  };
};
