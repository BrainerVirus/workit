import { isProtectedBranch } from "../core/repo-context";
import { selectPr } from "./report";
import type { ResolvedForge } from "./resolve";
import { success, type ForgeResult } from "./types";

/** A branch that already landed on another branch through its own PR/MR. */
export type LandedBranch = {
  branch: string;
  pr: number;
  /** The branch it merged into (the trunk its changes reach). */
  into: string;
  /** Its head when that PR merged. */
  head: string;
};

/**
 * Whether `branch` already landed: it has no open PR and its latest one
 * merged into another branch. A long-lived branch (main, develop…) never
 * reads as landed: it keeps receiving work after each release. Forks on
 * GitLab are not looked up (the base project id is not known here).
 */
export function landedBranch(
  resolved: ResolvedForge,
  branch: string,
): ForgeResult<LandedBranch | null> {
  if (isProtectedBranch(branch)) return success(null);
  const found = resolved.forge.findPr(branch, {
    owner: resolved.forge.repo.split("/")[0] ?? null,
    projectId: resolved.fork ? null : resolved.headProjectId,
    sha: null,
  });
  if (!found.ok) return found;
  const ref = found.data;
  if (!ref || ref.state !== "merged" || ref.headBranch !== branch) return success(null);
  const status = resolved.forge.prStatus(ref.number);
  if (!status.ok) return status;
  if (status.data.base === branch) return success(null);
  return success({ branch, pr: ref.number, into: status.data.base, head: status.data.head.sha });
}

export type MergedBaseRefusal = {
  error: string;
  unblock: string;
  data: {
    reason: "base_landed";
    pr: number;
    base: string;
    landedOn: string;
    landedPr: number;
  };
};

/**
 * `pr merge` must not merge into a base that already landed and has not
 * moved since (#752): the change would stay on a dead branch and never reach
 * the trunk. A base with commits after its PR merged is a live branch and
 * passes. A read that fails never refuses (the merge gate reads the PR again).
 */
export function mergedBaseGate(
  cwd: string,
  resolved: ResolvedForge,
  pr: number | null,
): MergedBaseRefusal | null {
  try {
    const number = selectPr(cwd, resolved, { pr, branch: null });
    if (!number.ok) return null;
    const status = resolved.forge.prStatus(number.data);
    if (!status.ok || status.data.state !== "open") return null;
    const landed = landedBranch(resolved, status.data.base);
    if (!landed.ok || !landed.data) return null;
    if (status.data.baseSha !== null && status.data.baseSha !== landed.data.head) return null;
    const noun = resolved.forge.kind === "github" ? "PR #" : "MR !";
    const { base } = status.data;
    const trunk = landed.data.into;
    return {
      error: `base_landed: ${base} already landed on ${trunk} (${noun}${landed.data.pr}); merging ${noun}${number.data} into ${base} would leave its change off ${trunk}`,
      unblock: `workit pr edit --pr ${number.data} --base ${trunk}  # retarget it onto ${trunk} (in a workit stack: workit stack sync restacks and retargets it), then workit pr merge --pr ${number.data} once CI is green`,
      data: {
        reason: "base_landed",
        pr: number.data,
        base,
        landedOn: trunk,
        landedPr: landed.data.pr,
      },
    };
  } catch {
    return null;
  }
}
