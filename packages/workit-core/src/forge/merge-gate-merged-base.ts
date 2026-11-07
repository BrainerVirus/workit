import { gitFlowOf, isProtectedTarget, resolveBranchPolicyFor } from "../core/branch";
import { workspaceReleaseTracks } from "../core/release-tracks";
import { isProtectedBranch } from "../core/repo-context";
import { listStacks } from "../stack";
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
 * Prefixes of work branches that land once: git-flow feature/ and bugfix/
 * and the prefixes agents use for them (fix/, chore/, docs/…). release/ and
 * hotfix/ are not here: they flow into two branches.
 */
const SHORT_LIVED_PREFIXES: ReadonlySet<string> = new Set([
  "feature",
  "features",
  "feat",
  "bugfix",
  "bugfixes",
  "fix",
  "fixes",
  "bug",
  "bugs",
  "chore",
  "docs",
  "doc",
  "refactor",
  "test",
  "tests",
  "ci",
  "build",
  "perf",
  "style",
  "deps",
  "task",
  "enhancement",
]);

/** The branches the workspace keeps receiving work on: its targets, git-flow and release tracks. */
function longLivedBranches(cwd: string): Set<string> {
  const flow = gitFlowOf(cwd);
  const target = resolveBranchPolicyFor(cwd).defaultTargetBranch;
  return new Set([
    ...(typeof target === "string" && target ? [target] : []),
    ...(flow ? [flow.develop, flow.production] : []),
    ...workspaceReleaseTracks(cwd).tracks.flatMap((track) => [
      track.productionBranch,
      track.integrationBranch,
      track.baseBranch,
      track.pullRequestTarget,
      ...track.mergeBackBranches,
    ]),
  ]);
}

/**
 * Whether `branch` is a short-lived base that can land and go stale: a
 * branch of a workit stack, or a work branch by its prefix. A protected or
 * long-lived branch (the default target, git-flow develop or production, a
 * release track's branches, staging, release/*) never is; nor is anything
 * when the workspace cannot be read.
 */
export function shortLivedBranch(cwd: string, branch: string): boolean {
  try {
    if (isProtectedBranch(branch) || isProtectedTarget(cwd, branch)) return false;
    if (longLivedBranches(cwd).has(branch)) return false;
    const stacks = listStacks(cwd);
    if (
      stacks.ok &&
      stacks.data.some((stack) => stack.branches.some((entry) => entry.branch === branch))
    )
      return true;
  } catch {
    return false;
  }
  const slash = branch.indexOf("/");
  return slash > 0 && SHORT_LIVED_PREFIXES.has(branch.slice(0, slash).toLowerCase());
}

/**
 * Whether the short-lived `branch` already landed: it has no open PR and its
 * latest one merged into another branch. A long-lived base never reads as
 * landed (it keeps receiving work after each promotion), and that check
 * needs no forge call. Several open PRs from it (`ambiguous_pr`) mean it
 * has not landed. Forks on GitLab are not looked up (the base project id is
 * not known here).
 */
export function landedBranch(
  cwd: string,
  resolved: ResolvedForge,
  branch: string,
): ForgeResult<LandedBranch | null> {
  if (!shortLivedBranch(cwd, branch)) return success(null);
  const found = resolved.forge.findPr(branch, {
    owner: resolved.forge.repo.split("/")[0] ?? null,
    projectId: resolved.fork ? null : resolved.headProjectId,
    sha: null,
  });
  if (!found.ok) return found.error.startsWith("ambiguous_pr") ? success(null) : found;
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
  cwd: string,
  resolved: ResolvedForge,
  status: ForgePrStatus,
): MergedBaseRefusal | null {
  // An unknown base tip (a failed branch read) cannot show the base is untouched.
  if (status.state !== "open" || status.baseSha === null) return null;
  let landed: ForgeResult<LandedBranch | null>;
  try {
    landed = landedBranch(cwd, resolved, status.base);
  } catch {
    return null;
  }
  if (!landed.ok || !landed.data || status.baseSha !== landed.data.head) return null;
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
  cwd: string,
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
        refusal = mergedBaseGate(cwd, resolved, status.data);
        return refusal ? failure("blocked", refusal.error, refusal.unblock) : status;
      },
    },
  };
}
