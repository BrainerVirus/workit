// `workit git stage|unstage`: index-only staging an agent can drive
// without `git add -p`. A unified diff (`--patch`) goes to the index alone
// (`git apply --cached`, checked first), so selected hunks become one focused
// commit with `workit git commit --staged`; whole paths stage or unstage as
// `git add -A` / `git reset` would. The working tree is never touched.
import { failure, success, type ForgeResult } from "../forge/types";
import { git, gitError } from "./ops";

export type StageOutcome = {
  /** Every path staged after the call (index differs from HEAD), top-relative. */
  staged: string[];
};

const stagedNow = (cwd: string): string[] =>
  git(cwd, ["diff", "--cached", "--name-only", "-z", "--no-renames"])
    .stdout.split("\0")
    .filter(Boolean);

const badPaths = (paths: readonly string[]) =>
  !paths.length || paths.some((value) => value.startsWith("-") || !value.trim());

/**
 * Stage a unified diff (`patch`) or whole `paths`. A patch is applied from the
 * top of the work tree, as `git diff` writes its paths, with hunk line counts
 * recounted so a hand-trimmed hunk still applies.
 */
export function gitStage(
  cwd: string,
  input: { patch: string } | { paths: readonly string[] },
): ForgeResult<StageOutcome> {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return failure("invalid_input", "not inside a git work tree");
  if ("patch" in input) {
    if (!input.patch.trim()) return failure("invalid_input", "the patch is empty");
    const root = top.stdout.trim();
    const apply = (...flags: string[]) =>
      git(root, ["apply", "--cached", "--recount", ...flags, "-"], { input: input.patch });
    const checked = apply("--check");
    if (!checked.ok)
      return failure(
        "failed",
        `patch_does_not_apply: ${gitError(checked, 6)}`,
        "regenerate it from `git diff -- <file>` (the index is the base: `git diff` shows only unstaged hunks) and keep whole hunks",
      );
    const applied = apply();
    if (!applied.ok) return failure("failed", `git apply --cached failed: ${gitError(applied)}`);
    return success({ staged: stagedNow(cwd) });
  }
  if (badPaths(input.paths))
    return failure("invalid_input", "paths must not be empty or start with -");
  const added = git(cwd, ["add", "-A", "--", ...input.paths]);
  if (!added.ok) return failure("failed", `git add failed: ${gitError(added)}`);
  return success({ staged: stagedNow(cwd) });
}

/** Put `paths` back to HEAD in the index; the working tree keeps every change. */
export function gitUnstage(cwd: string, paths: readonly string[]): ForgeResult<StageOutcome> {
  if (badPaths(paths)) return failure("invalid_input", "paths must not be empty or start with -");
  const reset = git(cwd, ["reset", "-q", "--", ...paths]);
  if (!reset.ok) return failure("failed", `git reset failed: ${gitError(reset)}`);
  return success({ staged: stagedNow(cwd) });
}
