import { isProtectedBranch } from "../core/repo-context";
import type { ResolvedForge } from "./resolve";
import { failure, success, type Forge, type ForgePrStatus, type ForgeResult } from "./types";

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
 * passes. A read that fails never refuses (the merge gate goes on as before).
 */
export function mergedBaseGate(
  resolved: ResolvedForge,
  status: ForgePrStatus,
): MergedBaseRefusal | null {
  if (status.state !== "open") return null;
  let landed: ForgeResult<LandedBranch | null>;
  try {
    landed = landedBranch(resolved, status.base);
  } catch {
    return null;
  }
  if (!landed.ok || !landed.data) return null;
  if (status.baseSha !== null && status.baseSha !== landed.data.head) return null;
  const noun = resolved.forge.kind === "github" ? "PR #" : "MR !";
  const { base, number } = status;
  const trunk = landed.data.into;
  return {
    error: `base_landed: ${base} already landed on ${trunk} (${noun}${landed.data.pr}); merging ${noun}${number} into ${base} would leave its change off ${trunk}`,
    unblock: `workit pr edit --pr ${number} --base ${trunk}  # retarget it onto ${trunk} (in a workit stack: workit stack sync restacks and retargets it), then workit pr merge --pr ${number} once CI is green`,
    data: { reason: "base_landed", pr: number, base, landedOn: trunk, landedPr: landed.data.pr },
  };
}

/**
 * \`forge\` as \`pr merge\` reads it: the first open PR it reads is judged by
 * \`mergedBaseGate\` on that same read (no extra PR read), and a refusal is
 * returned as a \`blocked\` read, so nothing merges; \`refusal\` keeps it for
 * the envelope.
 */
export function landedBaseGuard(
  forge: Forge,
  resolved: ResolvedForge,
): { forge: Forge; refusal: () => MergedBaseRefusal | null } {
  let judged = false;
  let refusal: MergedBaseRefusal | null = null;
  return {
    refusal: () => refusal,
    forge: {
      ...forge,
      prStatus(number) {
        const status = forge.prStatus(number);
        if (judged || !status.ok || status.data.state !== "open") return status;
        judged = true;
        refusal = mergedBaseGate(resolved, status.data);
        return refusal ? failure("blocked", refusal.error, refusal.unblock) : status;
      },
    },
  };
}
