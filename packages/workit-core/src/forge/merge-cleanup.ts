// After `workit pr merge` deleted the remote head branch (#384): the local
// branch and the slice's clean fanout worktree go too. Never forced.
import fs from "node:fs";
import path from "node:path";
import { gitRun, nulList } from "../fanout";
import { SCRATCH_DIR, listWorktrees } from "../fanout-worktree";
import { GIT_TIMEOUTS } from "../git/rev";
import { FANOUT_TOKEN_FILE } from "../hooks/worktree-confine";

const SLOW = GIT_TIMEOUTS.worktree;

/** `workit fanout worktree create` marked this worktree's admin dir with its token. */
const isFanoutWorktree = (worktree: string): boolean => {
  const dir = gitRun(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return false;
  try {
    return fs.readFileSync(path.join(dir.stdout.trim(), FANOUT_TOKEN_FILE), "utf8").trim() !== "";
  } catch {
    return false;
  }
};

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(fs.realpathSync.native(parent), fs.realpathSync.native(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export type LocalCleanup = {
  /** The local branch was deleted. */
  branchDeleted: boolean;
  /** The Workit fanout worktree that was on the branch and clean, removed. */
  worktreeRemoved: string | null;
  /** Why anything was kept: one line each. */
  notes: string[];
};

/**
 * After `pr merge` deleted the remote head branch: delete the local branch
 * when it is not checked out anywhere, and first remove a clean worktree that
 * `workit fanout worktree create` made on it. Never forced: a dirty worktree,
 * one someone else made, the main checkout, the one this command runs in, or
 * a local branch with commits beyond the merged head are kept and named.
 */
export function cleanupMergedBranch(cwd: string, branch: string, mergedHead: string): LocalCleanup {
  const out: LocalCleanup = { branchDeleted: false, worktreeRemoved: null, notes: [] };
  if (!branch || branch.startsWith("-")) return out;
  const ref = `refs/heads/${branch}`;
  const tip = gitRun(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (!tip.ok) return out;
  if (
    tip.stdout.trim() !== mergedHead &&
    !gitRun(cwd, ["merge-base", "--is-ancestor", tip.stdout.trim(), mergedHead]).ok
  ) {
    out.notes.push(`local ${branch} has commits that were not merged; kept it`);
    return out;
  }
  const trees = listWorktrees(cwd);
  for (const [index, entry] of trees.entries()) {
    if (entry.branch !== ref) continue;
    if (index === 0 || inside(cwd, entry.path)) {
      out.notes.push(`local ${branch} is checked out in ${entry.path}; kept it`);
      return out;
    }
    if (!isFanoutWorktree(entry.path)) {
      out.notes.push(
        `local ${branch} is checked out in ${entry.path}, not a Workit fanout worktree; kept both`,
      );
      return out;
    }
    const status = gitRun(entry.path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    const dirty = status.ok
      ? nulList(status.stdout).filter((line) => !line.slice(3).startsWith(`${SCRATCH_DIR}/`))
      : ["unreadable"];
    if (dirty.length > 0) {
      out.notes.push(
        `worktree ${entry.path} has ${dirty.length === 1 && dirty[0] === "unreadable" ? "an unreadable state" : `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}`}; kept it and local ${branch}`,
      );
      return out;
    }
    const removed = gitRun(cwd, ["worktree", "remove", entry.path], SLOW);
    if (!removed.ok) {
      out.notes.push(
        `could not remove worktree ${entry.path} (${removed.stderr.trim().split("\n")[0]}); kept local ${branch}`,
      );
      return out;
    }
    out.worktreeRemoved = entry.path;
  }
  if (listWorktrees(cwd).some((entry) => entry.branch === ref)) return out;
  const deleted = gitRun(cwd, ["branch", "-D", "--", branch]);
  if (deleted.ok) out.branchDeleted = true;
  else out.notes.push(`could not delete local ${branch}: ${deleted.stderr.trim().split("\n")[0]}`);
  return out;
}
