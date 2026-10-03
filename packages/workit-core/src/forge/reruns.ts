// The rerun-once record (design §2.1 `ci rerun`): one row per check rerun on
// a given PR head, so a second rerun of the same check on the same head needs
// `--force`. Rows use the ledger row shape (`type: "ci.rerun"`) so S13 can
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
  pr: number;
  head: string;
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
    typeof row.pr === "number" &&
    typeof row.head === "string" &&
    typeof row.check === "string" &&
    typeof row.repo === "string"
  );
};

/** How often each check was rerun on `head` of PR `pr` in `repo`. */
export function rerunCounts(
  cwd: string,
  key: { repo: string; pr: number; head: string },
): Map<string, number> {
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
    if (isRow(row) && row.repo === key.repo && row.pr === key.pr && row.head === key.head)
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
