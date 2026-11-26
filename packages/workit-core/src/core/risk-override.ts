// A sealed workspace override of a risk path (#891 part 4): the user lists
// risk-path globs in the workspace's `additiveRiskPaths`, at their own
// terminal, and seals it (`workit workspace seal`). A file the list names
// whose edit is purely additive, as the workflow sub-rule reads it
// (policy/workflow-edit.ts: a `run:` or command input grown only by a guarded
// `&& <command>` append), then leaves the lane: the PR lands on the lane of
// the rest of the diff, without the focused floor an additive workflow edit
// keeps otherwise, so the user stops passing `--unverified` per PR.
//
// It fails closed: an edit the sub-rule does not read as additive, a file
// the repository's own `.workit/risk-paths` names (they only tighten) and a
// list the seal does not cover (then the lane is unchanged and says why)
// keep the lane computeLane gives. A high-risk judgment still raises it.
// `pr status`, `pr merge` and `stack land` read it (policy/pr-lane.ts); the
// Stop hook reads the gate `pr status` recorded for the head (a `pr.gate` row).
import { additiveRiskPathsPolicy, type AdditiveRiskPathsPolicy } from "../autonomy";
import { fileAt, mergeBase } from "../git/rev";
import {
  RISK_PATHS_FILE,
  branchLane,
  computeLane,
  globMatch,
  laneFiles,
  parseRiskPaths,
  type BranchLane,
} from "./policy/lane";

type LaneOptions = Parameters<typeof branchLane>[1];

const list = (items: readonly string[]): string =>
  `${items.slice(0, 3).join(", ")}${items.length > 3 ? ", …" : ""}`;

/**
 * branchLane with the workspace's sealed `additiveRiskPaths` applied (see
 * the header), plus a note when the list names a changed file it does not
 * soften: unsealed, or an edit that is not purely additive.
 */
export function overriddenBranchLane(
  cwd: string,
  options: LaneOptions,
  policy: AdditiveRiskPathsPolicy = additiveRiskPathsPolicy(cwd),
): BranchLane {
  const lane = branchLane(cwd, options);
  if (!policy.configured.length || lane.base === null) return lane;
  const head = options.workingTree ? null : options.head;
  const fork = mergeBase(cwd, lane.base, head ?? "HEAD");
  const files = fork && (head || options.workingTree) ? laneFiles(cwd, fork, head) : null;
  if (!fork || !files) return lane;
  const matched = files.filter((file) =>
    policy.configured.some((glob) => globMatch(glob, file.path)),
  );
  if (!matched.length) return lane;
  const note = (text: string): BranchLane => ({ ...lane, reasons: [...lane.reasons, text] });
  if (!policy.sealed)
    return note(
      `additiveRiskPaths of workspace ${policy.workspace ?? "(none)"} names ${list(matched.map((file) => file.path))} but is ignored: the seal is not valid (the user runs workit workspace seal)`,
    );
  const repoRisk = parseRiskPaths(fileAt(cwd, fork, RISK_PATHS_FILE) ?? "");
  const relaxed = matched.filter(
    (file) =>
      file.workflow?.additive === true &&
      policy.paths.some((glob) => globMatch(glob, file.path)) &&
      !repoRisk.some((glob) => globMatch(glob, file.path)),
  );
  if (!relaxed.length)
    return note(
      `additiveRiskPaths names ${list(matched.map((file) => file.path))}, but its edit is not purely additive${matched[0]?.workflow ? ` (${matched[0].workflow.detail})` : ""}`,
    );
  const assessed = computeLane({
    files: files.filter((file) => !relaxed.includes(file)),
    riskTier: options.judgment?.riskTier ?? null,
    riskPaths: [...repoRisk, ...(options.riskPaths ?? [])],
  });
  return {
    ...assessed,
    reasons: [
      ...assessed.reasons,
      `sealed additive edit: ${list(relaxed.map((file) => file.path))}`,
    ],
    base: lane.base,
    head: options.head,
  };
}
