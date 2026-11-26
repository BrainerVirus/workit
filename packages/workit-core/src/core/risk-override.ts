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
// branchLane applies the sealed list (its `additivePaths`), so the Stop hook
// reads it too; this wrapper adds the notes `pr status`, `pr merge` and
// `stack land` show (policy/pr-lane.ts).
import { additiveRiskPathsPolicy, type AdditiveRiskPathsPolicy } from "../autonomy";
import { branchLane, changedFiles, globMatch, type BranchLane } from "./policy/lane";

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
  const lane = branchLane(cwd, { ...options, additivePaths: policy.paths });
  if (!policy.configured.length || lane.base === null) return lane;
  if (lane.reasons.some((reason) => reason.startsWith("sealed additive edit"))) return lane;
  const files = changedFiles(cwd, lane.base, options.workingTree ? null : options.head);
  const matched = (files ?? []).filter((file) =>
    policy.configured.some((glob) => globMatch(glob, file.path)),
  );
  if (!matched.length) return lane;
  const paths = list(matched.map((file) => file.path));
  const note = policy.sealed
    ? `additiveRiskPaths names ${paths}, but its edit is not purely additive${matched[0]?.workflow ? ` (${matched[0].workflow.detail})` : ""}`
    : `additiveRiskPaths of workspace ${policy.workspace ?? "(none)"} names ${paths} but is ignored: the seal is not valid (the user runs workit workspace seal)`;
  return { ...lane, reasons: [...lane.reasons, note] };
}
