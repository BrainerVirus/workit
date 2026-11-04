// Verdict carry-over across a follow-up change (#334, decision mvk5q3io): a
// verdict judged head H; the branch is now at H'. The branch's own change
// since H (what came from the base left out, see lane.ts driftFiles) is
// classified with the review lane, and the verdict still applies when:
//
//   rebase      the branch was rebased and every file it touches is exactly
//               the judged change replayed onto the new fork point: only
//               trunk's commits differ (bookkeeping.ts replayTree);
//   lane-none   that change is lane `none`: docs (a changelog included),
//               comment or formatting-only edits, generated copies (by the
//               base's .gitattributes), bookkeeping (a version-only manifest
//               change, a file a `write:*` script regenerates), or nothing at
//               all (an empty commit);
//   tests-only  the verdict is kind `unit` and every changed file is a test,
//               docs or bookkeeping, off risk paths, with no lockfile and no
//               binary, whatever its size and whatever the PR's own lane.
//
// After a rebase, a file whose current content is the judged change replayed
// onto the new fork is left out before the lane is read: a trunk edit in a
// branch file never counts as the branch's change, and a file whose result
// differs (a hand-resolved conflict, an amend) always does.
//
// Everything else is stale, failing closed: a behavior or risk-path change,
// an opaque file, an unreadable diff, a judged head git no longer has. A
// stale verdict whose change is lane `self` (small, no risk path, nothing
// opaque) asks only a focused re-verify of the changed files.
import { mergeBase, fileAt } from "../../git/rev";
import { bookkeepingPaths, replayTree } from "./bookkeeping";
import {
  computeLane,
  cosmeticFiles,
  driftFiles,
  kindOf,
  laneFiles,
  parseRiskPaths,
  RISK_PATHS_FILE,
} from "./lane";

/** `rebase`: the same patch on a moved base (ledger.ts exact carry, or every branch file replays). */
export type CarryRule = "lane-none" | "tests-only" | "rebase";

export type Drift =
  | { carries: true; rule: CarryRule; since: string; files: string[] }
  | {
      carries: false;
      since: string;
      /** The changed files, or null when they cannot be read. */
      files: string[] | null;
      /** A focused re-verify of `files` is enough (lane self). */
      focused: boolean;
      reason: string;
    };

const TEST_ONLY_KINDS: ReadonlySet<string> = new Set(["doc", "cosmetic", "generated", "test"]);

/**
 * Whether a `kind` verdict at `from` (keyed against `fromBase`, a commit)
 * still applies at `to` (against `toBase`).
 */
export function verdictDrift(
  cwd: string,
  input: { from: string; to: string; fromBase: string; toBase: string; kind: string },
): Drift {
  const since = input.from;
  const stale = (reason: string, files: string[] | null = null, focused = false): Drift => ({
    carries: false,
    since,
    files,
    focused,
    reason,
  });
  const fromFork = mergeBase(cwd, input.fromBase, input.from);
  const toFork = mergeBase(cwd, input.toBase, input.to);
  const range = fromFork && toFork ? { from: input.from, to: input.to, fromFork, toFork } : null;
  const drifted = range ? driftFiles(cwd, range) : null;
  if (!range || !drifted) return stale(`the change since ${since.slice(0, 12)} cannot be read`);
  let files = drifted;
  if (range.fromFork !== range.toFork) {
    // A rebase: the branch's own change is what the head changes against the
    // judged head replayed onto the new fork (trunk's lines left out; a
    // conflict holds markers, so its resolution counts). Unreadable: every
    // drifted file stays, none cosmetic (fail closed).
    const tree = replayTree(cwd, range.from, range.fromFork, range.toFork);
    const own = tree ? laneFiles(cwd, tree, range.to, range.toFork) : null;
    if (own && !own.length) return { carries: true, rule: "rebase", since, files: [] };
    // A file whose code equals the judged code (only comments or whitespace
    // differ from the judged head, e.g. a conflict in a comment resolved by
    // hand) is cosmetic: trunk's code in it would differ too.
    const judged = own ? cosmeticFiles(cwd, range.from, range.to) : null;
    if (own)
      files = own.map((file) =>
        !file.binary && judged?.cosmetic.has(file.path) ? { ...file, cosmetic: true } : file,
      );
  }
  const bookkeeping = bookkeepingPaths(cwd, {
    from: input.from,
    to: input.to,
    base: range.toFork,
    paths: files.map((file) => file.path),
  });
  files = files.map((file) => (bookkeeping.has(file.path) ? { ...file, generated: true } : file));
  // Repo risk paths from both base revisions: they only tighten.
  const riskPaths = [range.fromFork, range.toFork].flatMap((fork) =>
    parseRiskPaths(fileAt(cwd, fork, RISK_PATHS_FILE) ?? ""),
  );
  const lane = computeLane({ files, riskPaths });
  const paths = files.map((file) => file.path);
  if (lane.lane === "none") return { carries: true, rule: "lane-none", since, files: paths };
  // Tests cannot change what the code does: a unit verdict keeps any size
  // of test-only follow-up, off risk paths, with nothing opaque.
  if (
    input.kind === "unit" &&
    lane.riskFiles.length === 0 &&
    files.every((file) => TEST_ONLY_KINDS.has(kindOf(file)))
  )
    return { carries: true, rule: "tests-only", since, files: paths };
  return stale(lane.reasons[0] ?? `lane ${lane.lane}`, paths, lane.lane === "self");
}
