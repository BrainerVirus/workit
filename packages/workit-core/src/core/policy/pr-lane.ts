// The verdict gate of one PR head under the workspace's verification mode:
// what `pr merge`, `stack land` and `pr status` read (#333).
import { resolveAutonomy, type VerificationMode } from "../../autonomy";
import { currentBranch } from "../../git/rev";
import type { VerdictCheck } from "../../ledger";
import { currentJudgment } from "./current-judgment";
import { branchLane, laneGate, type BranchLane, type LaneGate } from "./lane";

export type PrLaneGate = LaneGate & { verification: VerificationMode; lane: BranchLane };

/**
 * The review lane of `head` against the PR's `base` and what the gate asks
 * for it. The checked-out task's judgment raises the lane only when `branch`
 * is checked out here (it describes that work, not another branch's).
 */
export function prLaneGate(
  cwd: string,
  check: Pick<VerdictCheck, "accepted" | "selfVerdict">,
  pr: { branch: string; base: string; head: string },
): PrLaneGate {
  const verification = resolveAutonomy(cwd).verification;
  const lane = branchLane(cwd, {
    base: pr.base,
    head: pr.head,
    judgment: currentBranch(cwd) === pr.branch ? currentJudgment(cwd) : null,
  });
  return { ...laneGate(check, verification, lane), verification, lane };
}

/** One line naming the lane and why, for refusals and status. */
export const laneLabel = (gate: Pick<PrLaneGate, "lane">): string =>
  `lane ${gate.lane.lane} (${gate.lane.reasons.join("; ")})`;
