// Verdict carry-over across a follow-up change (#334, decision mvk5q3io): a
// verdict judged head H; the branch is now at H'. The branch's own change
// since H (what came from the base left out, see lane.ts driftFiles) is
// classified with the review lane, and the verdict still applies when:
//
//   lane-none   that change is lane `none`: docs, comment or formatting-only
//               edits, generated copies (by the base's .gitattributes), or
//               nothing at all (an empty commit);
//   tests-only  the verdict is kind `unit` and the change is lane `self`
//               (small) with every behavior file a test: test files off risk
//               paths, no lockfile, no binary.
//
// Everything else is stale, failing closed: a behavior or risk-path change,
// an opaque file, an unreadable diff, a judged head git no longer has. A
// stale verdict whose change is lane `self` (small, no risk path, nothing
// opaque) asks only a focused re-verify of the changed files.
import { mergeBase, fileAt } from "../../git/rev";
import { computeLane, driftFiles, kindOf, parseRiskPaths, RISK_PATHS_FILE } from "./lane";

export type CarryRule = "lane-none" | "tests-only";

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
  const files =
    fromFork && toFork
      ? driftFiles(cwd, { from: input.from, to: input.to, fromFork, toFork })
      : null;
  if (!fromFork || !toFork || !files)
    return stale(`the change since ${since.slice(0, 12)} cannot be read`);
  // Repo risk paths from both base revisions: they only tighten.
  const riskPaths = [fromFork, toFork].flatMap((fork) =>
    parseRiskPaths(fileAt(cwd, fork, RISK_PATHS_FILE) ?? ""),
  );
  const lane = computeLane({ files, riskPaths });
  const paths = files.map((file) => file.path);
  if (lane.lane === "none") return { carries: true, rule: "lane-none", since, files: paths };
  if (
    input.kind === "unit" &&
    lane.lane === "self" &&
    files.every((file) => TEST_ONLY_KINDS.has(kindOf(file)))
  )
    return { carries: true, rule: "tests-only", since, files: paths };
  return stale(lane.reasons[0] ?? `lane ${lane.lane}`, paths, lane.lane === "self");
}
