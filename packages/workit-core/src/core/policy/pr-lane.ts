// The verdict gate of one PR head under the workspace's verification mode:
// what `pr merge`, `stack land` and `pr status` read (#333).
import { resolveAutonomy, type VerificationMode } from "../../autonomy";
import { currentBranch } from "../../git/rev";
import { readLedger, type VerdictCheck } from "../../ledger";
import { currentJudgment } from "./current-judgment";
import { branchLane, laneGate, type BranchLane, type LaneGate } from "./lane";

export type PrLaneGate = LaneGate & { verification: VerificationMode; lane: BranchLane };

/**
 * The review lane of `head` against the PR's `base` and what the gate asks
 * for it. The checked-out task's judgment raises the lane only when `branch`
 * is checked out here (it describes that work, not another branch's).
 *
 * `ci` is the forge's state of the head's checks; a caller that did not read
 * it gets the newest `pr.status` row Workit recorded for that head (a
 * dependency bump's self lane needs it green).
 */
export function prLaneGate(
  cwd: string,
  check: Pick<VerdictCheck, "accepted" | "selfVerdict">,
  pr: { branch: string; base: string; head: string; ci?: string | null },
): PrLaneGate {
  const verification = resolveAutonomy(cwd).verification;
  const lane = branchLane(cwd, {
    base: pr.base,
    head: pr.head,
    judgment: currentBranch(cwd) === pr.branch ? currentJudgment(cwd) : null,
  });
  const ci = lane.classification === "dependency-bump" ? (pr.ci ?? recordedCi(cwd, pr.head)) : null;
  return { ...laneGate(check, verification, lane, ci), verification, lane };
}

/** The checks state of the newest `pr.status` row the CLI recorded for `head`, or null. */
export function recordedCi(cwd: string, head: string): string | null {
  const ledger = readLedger(cwd, { integrity: true });
  if (!ledger.ok) return null;
  const row = ledger.value.rows.findLast(
    (candidate) =>
      candidate.type === "pr.status" &&
      candidate.observer === "workit_cli" &&
      candidate.integrity !== "unverified" &&
      candidate.head === head,
  );
  return typeof row?.checks === "string" ? row.checks : null;
}

/** One line naming the lane and why, for refusals and status. */
export const laneLabel = (gate: Pick<PrLaneGate, "lane" | "missing">): string =>
  `lane ${gate.lane.lane} (${gate.lane.reasons.join("; ")})${gate.missing ? `; missing evidence: ${gate.missing}` : ""}`;
