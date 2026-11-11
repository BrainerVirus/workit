// Imported first by the state-isolation preload: fails the run when a test
// made a worktree under the developer's real Workit state dir. A test that
// hands a child (or main's io.env) an env without the throwaway
// WORKIT_STATE_DIR resolves the real one, and its `fanout worktree create`
// leaves `<state>/worktrees/<repo>-<hash>/<slice>` behind for good, pointing
// at a temp repo that is deleted after the run.
import { afterAll } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workitDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

/** The state dir Workit resolves without WORKIT_STATE_DIR: $XDG_STATE_HOME or ~/.local/state, /workit. */
export const realStateDir = (env: NodeJS.ProcessEnv = process.env): string =>
  workitDir("state", { ...env, WORKIT_STATE_DIR: undefined });

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

/** Every `worktrees/<repo>/<slug>` dir under `stateDir`. */
export const worktreeDirs = (stateDir: string): Set<string> =>
  new Set(list(path.join(stateDir, "worktrees")).flatMap(list));

const tempRoots = (): string[] => {
  const roots = [os.tmpdir()];
  try {
    roots.push(realpathSync(os.tmpdir()));
  } catch {
    // tmpdir missing: the plain path is all we have.
  }
  return roots;
};

/** True when the worktree's `.git` file names a gitdir inside the temp dir: a test repo's. */
const fromTempRepo = (worktree: string, roots: string[]): boolean => {
  const file = path.join(worktree, ".git");
  if (!existsSync(file)) return false;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false; // a directory: a plain clone, not a linked worktree
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return gitdir !== undefined && roots.some((root) => gitdir.startsWith(root + path.sep));
};

/**
 * Worktrees under `stateDir` that were not in `before` and belong to a temp
 * repo. Live sessions add their own worktrees there during a run; only one
 * whose repository sits in the temp dir is a test's.
 */
export const leakedWorktrees = (stateDir: string, before: Set<string>): string[] => {
  const roots = tempRoots();
  return [...worktreeDirs(stateDir)]
    .filter((dir) => !before.has(dir) && fromTempRepo(dir, roots))
    .toSorted();
};

export const leakMessage = (stateDir: string, leaked: string[]): string =>
  [
    `A test wrote ${leaked.length} worktree(s) into the real Workit state dir ${stateDir}:`,
    ...leaked.map((dir) => `  ${dir}`),
    "Give the spawned process (or main's io.env) the run's WORKIT_STATE_DIR (test/shared/state-isolation.ts), never an env that drops it.",
  ].join("\n");

/**
 * Snapshot the real state dir's worktrees now and fail the run in afterAll if
 * a test left a new one there. Call it before WORKIT_STATE_DIR and the XDG
 * vars change.
 */
export const guardRealState = (env: NodeJS.ProcessEnv = process.env): void => {
  const stateDir = realStateDir(env);
  const before = worktreeDirs(stateDir);
  afterAll(() => {
    const leaked = leakedWorktrees(stateDir, before);
    if (leaked.length > 0) throw new Error(leakMessage(stateDir, leaked));
  });
};
