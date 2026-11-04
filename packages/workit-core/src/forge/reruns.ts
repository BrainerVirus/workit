// The rerun-once record (design §2.1 `ci rerun`): one row per check rerun on
// a given head (of a PR, or of a branch such as a red main), so a second rerun
// of the same check on the same head needs `--force`. Rows use the ledger row shape (`type: "ci.rerun"`) so S13 can
// fold this file into `ledger.jsonl`.
//
// It lives in the git common dir (`<common>/workit/ci-reruns.jsonl`, design
// §0 #5) so every worktree of the repository shares it and `git clean` does
// not drop it. Append-only; unreadable lines are skipped.
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "../git/rev";

export type RerunRow = {
  v: 1;
  at: string;
  type: "ci.rerun";
  forge: string;
  repo: string;
  /** The PR whose checks were rerun; null for a branch rerun (`--ref`). */
  pr: number | null;
  /** The branch whose latest run was rerun; null for a PR rerun. Absent on older rows. */
  branch?: string | null;
  head: string;
  /** The workflow run / pipeline the check belongs to. Absent on older rows. */
  runId?: number | null;
  check: string;
  reason: string;
  forced: boolean;
};

export function rerunLogPath(cwd: string): string | null {
  const common = gitCommonDir(cwd);
  return common ? path.join(common, "workit", "ci-reruns.jsonl") : null;
}

const isRow = (value: unknown): value is RerunRow => {
  const row = value as Partial<RerunRow> | null;
  return (
    !!row &&
    row.type === "ci.rerun" &&
    (typeof row.pr === "number" || typeof row.branch === "string") &&
    typeof row.head === "string" &&
    typeof row.check === "string" &&
    typeof row.repo === "string"
  );
};

/**
 * How often each check was rerun on commit `head` in `repo`, whether through
 * its PR or its branch: one commit's checks are one allowance.
 */
export function rerunCounts(cwd: string, key: { repo: string; head: string }): Map<string, number> {
  const counts = new Map<string, number>();
  const file = rerunLogPath(cwd);
  if (!file) return counts;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return counts;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isRow(row) && row.repo === key.repo && row.head === key.head)
      counts.set(row.check, (counts.get(row.check) ?? 0) + 1);
  }
  return counts;
}

/** Append rows (one write, O_APPEND). Returns false when the file cannot be written. */
export function recordReruns(cwd: string, rows: readonly RerunRow[]): boolean {
  if (rows.length === 0) return true;
  const file = rerunLogPath(cwd);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return true;
  } catch {
    return false;
  }
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 60_000;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run `fn` holding `<common>/workit/ci-reruns.lock` (atomic create). Two
 * concurrent `ci rerun`s therefore cannot both pass the once-per-head check.
 * A lock older than a minute is from a dead process and is taken over.
 * Null when the lock stays held past the wait (the caller reports busy).
 */
export function withRerunLock<T>(cwd: string, fn: () => T): T | null {
  const file = rerunLogPath(cwd);
  if (!file) return fn();
  const lock = `${file.slice(0, -".jsonl".length)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= until) return null;
      pause(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
