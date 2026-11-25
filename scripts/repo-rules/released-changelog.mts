// The `released-changelog` repo rule, a warning: CHANGELOG.md's [Unreleased]
// should not hold an entry a `workit-dev-v*` release already shipped. No
// release writes back to main, so before scripts/roll-changelog.ts every entry
// since 0.6.0 piled up under [Unreleased] (about 1,200 lines by 2.11.0).
// check.mts prints each hit with the roll command and never fails on it:
// release notes do not depend on main being rolled, and a hard failure would
// make every open branch carry a conflicting roll after each release.
//
// It runs the roll's core (packages/workit-core/src/core/changelog-roll.ts)
// over the tags of the checkout at `root` (one `git show` per tag). A checkout
// with no `workit-dev-v*` tags, such as CI's tagless shallow clone, or a root
// that is not a git repo, reports nothing.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  gitExec,
  shippedUnreleased,
  tagSnapshots,
} from "../../packages/workit-core/src/core/changelog-roll.ts";
import { TAG_PREFIX } from "../../packages/workit-core/scripts/analyze-release-scope.ts";

export const RULE = "released-changelog";

const FILE = "CHANGELOG.md";
const CITED =
  "release notes: no release writes back to main, so 1,200 lines of shipped entries piled up under [Unreleased]";

export type ReleasedHit = {
  rule: string;
  file: string;
  line: number;
  column: number;
  message: string;
};

/** Each [Unreleased] entry of `root`'s CHANGELOG.md that a release tag already holds. */
export function scanReleasedChangelog(root: string): ReleasedHit[] {
  const file = path.join(root, FILE);
  if (!existsSync(file)) return [];
  let snapshots;
  try {
    snapshots = tagSnapshots(gitExec(root), TAG_PREFIX);
  } catch {
    return [];
  }
  return shippedUnreleased(readFileSync(file, "utf8"), snapshots).map(({ line, version }) => ({
    rule: RULE,
    file: FILE,
    line,
    column: 1,
    message: `this [Unreleased] entry already shipped in ${version}. Fix: run \`bun scripts/roll-changelog.ts\`, which moves every released entry into its version's section. (${CITED})`,
  }));
}
