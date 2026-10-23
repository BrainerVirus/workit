// Stack-wide verdicts (#334, decision mvk5q3io): one verifier at the top of
// a stack, after its last push, covers the lower PRs it judged. A branch with
// no accepted verdict of its own is covered by a branch above it in a cached
// stack (`<store>/stacks/*.json`, S12) when:
//
//   - that branch has an accepted independent verdict now (fresh or carried);
//   - the verdict's session is not an author of the lower branch either;
//   - every commit of the lower branch since its fork from the trunk has a
//     verbatim patch-id (whitespace counts) among the commits of the judged
//     head (the verdict's own head, not the upper branch's current tip): the
//     lower change was judged unchanged. No merge commits, at least one
//     non-empty commit;
//   - the judged head holds exactly the lower branch's resulting files (no
//     `<lower>..<judged>` difference in any file the lower branch changed):
//     an upper commit that reverts or rewrites a lower file means the lower
//     PR's own code was never judged;
//   - the lower branch's own review lane is below full (decision B3): a risk
//     path or a large change needs its own verdict.
//
// A lower branch that changed after the verdict (a new commit, an amend, a
// conflict resolved differently) holds a patch-id the judged head lacks and
// is not covered. When git cannot read any of this, nothing is covered. A current independent failure or a tampered ledger on the
// lower branch is never covered over. `pr merge`, `stack land`, `stack
// status`, `pr status` and `ledger check` read this; the Stop hook does not.
import fs from "node:fs";
import path from "node:path";
import { branchLane } from "./core/policy/lane";
import { commitPatchIds, diffRaw, mergeBase } from "./git/rev";
import {
  authorSessions,
  authoredBy,
  checkVerdicts,
  defaultBase,
  resolveCommit,
  storeRoot,
  type ReadRow,
  type VerdictCheck,
} from "./ledger";

/** The verdict above `branch` in a stack that covers it. */
export type StackCover = {
  stack: string;
  /** The upper branch the verdict was recorded on. */
  branch: string;
  verdictId: string;
  /** The head that verdict judged. */
  head: string;
};

export type CoveredCheck = VerdictCheck & { cover: StackCover | null };

type Chain = { name: string; trunk: string; above: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The open branches above `branch` in each cached stack holding it, top first. */
function chainsAbove(cwd: string, branch: string): Chain[] {
  const root = storeRoot(cwd);
  if (!root.ok) return [];
  const dir = path.join(root.value.root, "stacks");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const chains: Chain[] = [];
  for (const name of names.toSorted()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.branches) || typeof parsed.trunk !== "string")
      continue;
    const entries = parsed.branches.filter(isRecord);
    const index = entries.findIndex((entry) => entry.branch === branch && !entry.merged);
    if (index < 0) continue;
    chains.push({
      name: typeof parsed.name === "string" ? parsed.name : name,
      trunk: parsed.trunk,
      above: entries
        .slice(index + 1)
        .filter((entry) => typeof entry.branch === "string" && !entry.merged)
        .map((entry) => entry.branch as string)
        .toReversed(),
    });
  }
  return chains;
}

/**
 * Whether the verdict on `judged` covers the lower branch at `head` (see the
 * header). Anything git cannot read is not covered.
 */
function covers(cwd: string, trunk: string, head: string, judged: string): boolean {
  const trunkSha = [`origin/${trunk}`, trunk].map((ref) => resolveCommit(cwd, ref)).find(Boolean);
  const ownFork = trunkSha ? mergeBase(cwd, trunkSha, head) : null;
  const judgedFork = trunkSha ? mergeBase(cwd, trunkSha, judged) : null;
  if (!ownFork || !judgedFork) return false;
  const own = commitPatchIds(cwd, ownFork, head);
  const top = commitPatchIds(cwd, judgedFork, judged);
  if (!own || !top || own.merges > 0 || own.patchIds.length === 0) return false;
  const judgedIds = new Set(top.patchIds);
  if (!own.patchIds.every((id) => judgedIds.has(id))) return false;
  // The judged tree holds exactly the lower branch's resulting files.
  const changed = diffRaw(cwd, ownFork, head);
  const between = changed ? diffRaw(cwd, head, judged) : null;
  if (!changed || !between) return false;
  const files = new Set(changed.map((entry) => entry.path));
  if (between.some((entry) => files.has(entry.path))) return false;
  return branchLane(cwd, { base: trunk, head }).lane !== "full";
}

/**
 * `checkVerdicts` for `branch`, and when it has no accepted verdict of its
 * own, the stack verdict that covers it (see the header): then `accepted`
 * names that verdict and `cover` says where it came from.
 */
export function checkVerdictsCovered(
  cwd: string,
  branch: string,
  rows: readonly ReadRow[],
): CoveredCheck {
  const check = checkVerdicts(cwd, branch, rows);
  const blocked = check.accepted.reasons.some(
    (reason) => reason === "failing_verdict" || reason === "ledger_tampered",
  );
  if (check.accepted.accepted || blocked || !check.head) return { ...check, cover: null };
  let authors: Set<string> | null = null;
  for (const chain of chainsAbove(cwd, branch))
    for (const upper of chain.above) {
      const verdict = checkVerdicts(cwd, upper, rows).accepted;
      const row = verdict.accepted ? verdict.verdict : null;
      const session = row?.actor.session;
      if (!row?.head || !session || typeof row.id !== "string") continue;
      authors ??= authorSessions(cwd, rows, branch, { base: defaultBase(cwd), head: check.head });
      if (authoredBy(authors, session)) continue;
      if (!covers(cwd, chain.trunk, check.head, row.head)) continue;
      return {
        ...check,
        accepted: { accepted: true, verdict: row, reasons: [] },
        review: "verified",
        selfVerdict: null,
        cover: { stack: chain.name, branch: upper, verdictId: row.id, head: row.head },
      };
    }
  return { ...check, cover: null };
}
