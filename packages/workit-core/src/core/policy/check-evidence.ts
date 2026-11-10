// Which configured checks a verdict needs on a head, and whether each has
// fresh evidence there (#509): a local `workit check` run on that exact
// commit, or (where the lane lets CI cover it) a green CI check of that name.
// A focused lane lets CI cover a check; a full lane needs a local run.
// A check red on the head and on the merge base too is `pre-existing` (#771):
// the candidate did not break it, so it does not refuse a verdict.
import { gateCheckNames, loadCheckConfig } from "../../check-config";
import { mergeBase } from "../../git/rev";
import { type BranchLane, branchLane, type ReviewLane } from "./lane";

export type CheckEvidenceStatus = "fresh" | "failing" | "pre-existing" | "missing";

export type CheckEvidence = {
  name: string;
  status: CheckEvidenceStatus;
  /** Where the fresh (or failing) evidence came from. */
  via: "local" | "ci" | null;
  /** Whether green CI may stand in for a local run at this lane. */
  ciCovers: boolean;
  /**
   * A red check only: the merge base it was compared with, and its last local
   * run there (`missing`: none recorded, so a red cannot be told pre-existing).
   */
  base?: { sha: string; result: "passed" | "failed" | "missing" };
};

export type CheckEvidenceDoc = {
  lane: ReviewLane;
  head: string;
  /** Every configured check the verdict needs; empty for a lane without a verdict. */
  needed: CheckEvidence[];
  /** True when every needed check is fresh or pre-existing red (vacuously true when none is needed). */
  satisfied: boolean;
};

export type LocalCheckRow = { name: string; head: string; dirty: boolean; passed: boolean };
export type CiCheck = { name: string; state: "passing" | "failing" | "pending" };

/** The aggregate `check` script repeats the others; it is never asked for on its own. */
const AGGREGATE = "check";

/** The checks a lane's verdict needs, from the configured gate names. */
export function neededChecks(lane: ReviewLane, configured: readonly string[]): string[] {
  if (lane !== "focused" && lane !== "full") return [];
  const names = configured.filter((name) => name !== AGGREGATE);
  return names.length ? names : [...configured];
}

/** The check name as a whole word of the CI job name: `lint` is not `(commitlint)`. */
const ciMatch = (ci: CiCheck, name: string): boolean =>
  new RegExp(
    `(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^a-z0-9]|$)`,
    "iu",
  ).test(ci.name);

/** The observed `workit check` rows of a ledger, as evidence input. */
export function localCheckRows(rows: readonly Record<string, unknown>[]): LocalCheckRow[] {
  return rows
    .filter((row) => row.type === "check" && row.observer === "workit_cli")
    .map((row) => ({
      name: String(row.name ?? ""),
      head: String(row.head ?? ""),
      dirty: row.dirty === true,
      passed: row.result === "passed",
    }));
}

/** The merge base of a lane's head and base branch, where a red check is compared; null when unreadable. */
export const laneMergeBase = (cwd: string, lane: BranchLane): string | null =>
  lane.base && lane.head ? mergeBase(cwd, lane.base, lane.head) : null;

/** The evidence of `head` on `branch` (local runs only; CI is read by `pr status`). */
export function verdictEvidence(
  cwd: string,
  input: { head: string; base?: string | null; rows: readonly Record<string, unknown>[] },
): CheckEvidenceDoc {
  const lane = branchLane(cwd, { base: input.base ?? null, head: input.head });
  return checkEvidence({
    lane: lane.lane,
    head: input.head,
    base: laneMergeBase(cwd, lane),
    configured: gateCheckNames(loadCheckConfig(cwd), "verification"),
    local: localCheckRows(input.rows),
    ci: [],
  });
}

/** The last clean local run of `name` on `sha`. */
const lastRun = (
  local: readonly LocalCheckRow[],
  name: string,
  sha: string,
): LocalCheckRow | undefined =>
  local.findLast((row) => row.name === name && row.head === sha && !row.dirty);

/**
 * A red check, kept failing unless its last local run on the merge base failed
 * too. A head that is its own merge base has no base to compare with.
 */
function againstBase(
  red: CheckEvidence,
  local: readonly LocalCheckRow[],
  range: { base: string | null; head: string },
): CheckEvidence {
  const { base } = range;
  if (!base || base === range.head) return red;
  const run = lastRun(local, red.name, base);
  const result = run ? (run.passed ? "passed" : "failed") : "missing";
  return {
    ...red,
    ...(result === "failed" ? { status: "pre-existing" as const } : {}),
    base: { sha: base, result },
  };
}

export function checkEvidence(input: {
  lane: ReviewLane;
  head: string;
  /** The merge base: a check red there too is pre-existing, not failing. */
  base?: string | null;
  configured: readonly string[];
  /** Observed `workit check` runs, oldest first. */
  local: readonly LocalCheckRow[];
  ci: readonly CiCheck[];
}): CheckEvidenceDoc {
  const ciCovers = input.lane === "focused";
  const needed = neededChecks(input.lane, input.configured).map((name): CheckEvidence => {
    const last = lastRun(input.local, name, input.head);
    if (last?.passed) return { name, status: "fresh", via: "local", ciCovers };
    const red = (via: "local" | "ci"): CheckEvidence =>
      againstBase({ name, status: "failing", via, ciCovers }, input.local, {
        base: input.base ?? null,
        head: input.head,
      });
    const ci = input.ci.filter((check) => ciMatch(check, name));
    if (ci.some((check) => check.state === "failing")) return red("ci");
    if (last) return red("local");
    if (ciCovers && ci.some((check) => check.state === "passing"))
      return { name, status: "fresh", via: "ci", ciCovers };
    return { name, status: "missing", via: null, ciCovers };
  });
  return {
    lane: input.lane,
    head: input.head,
    needed,
    satisfied: needed.every((item) => item.status === "fresh" || item.status === "pre-existing"),
  };
}

/** The note a verdict row and a status render carry for a pre-existing red check. */
export const preExistingNote = (item: CheckEvidence): string =>
  `pre-existing red: ${item.name} (base ${item.base?.sha.slice(0, 12) ?? "?"})`;

/** The status words after a check's name. */
function evidenceState(item: CheckEvidence): string {
  if (item.status === "pre-existing")
    return `pre-existing red, also failed on the merge base ${item.base?.sha.slice(0, 12) ?? "?"}${item.via ? ` (${item.via})` : ""}`;
  const via = item.via
    ? ` (${item.via})`
    : item.ciCovers
      ? " (run it, or green CI covers it)"
      : " (run workit check " + item.name + " on this head)";
  return `${item.status}${via}${item.base?.result === "missing" ? `; no run on the merge base ${item.base.sha.slice(0, 12)} tells whether it was red there` : ""}`;
}

/** One line per check for a status render. */
export function evidenceLines(doc: CheckEvidenceDoc): string[] {
  if (!doc.needed.length) return [`evidence: lane ${doc.lane} needs no check run`];
  return [
    `evidence for lane ${doc.lane} on ${doc.head.slice(0, 7)}: ${doc.satisfied ? "complete" : "incomplete"}`,
    ...doc.needed.map(
      (item) =>
        `  ${item.status === "fresh" ? "ok" : item.status === "pre-existing" ? "~" : "x"} ${item.name}: ${evidenceState(item)}`,
    ),
  ];
}
