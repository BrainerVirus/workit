// Hide the unstaged rest of the files a path-form commit takes in part (#907).
//
// `workit git commit -- <paths>` commits a file staged in part through a
// private index that holds its staged hunks. The pre-commit hooks would see
// that file as staged in part (`MM`) and run their own stash of the unstaged
// rest: lefthook before 2.2 does it with `git diff --output <file> --`, which
// git reads as `--no-index` in a linked worktree (the patch file sits in the
// main checkout's git dir, outside the worktree) and fails with "Not a git
// repository" (exit 129). So workit hides the rest itself: each such file
// gets its staged content in the working tree while the commit runs, and its
// exact bytes and mode back afterwards. Hooks then check what is committed
// and find nothing staged in part to stash.
//
// The originals are copied under `<git dir>/workit/` first and removed only
// once restored, so an interrupted commit leaves them there to copy back.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;

const gitLine = (cwd: string, args: string[]): string | null => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  return run.status === 0 ? run.stdout.trim() : null;
};

/** `copy` null: the file was gone from the working tree; `link`: it was a symlink. */
type Saved = { file: string; copy: string | null; mode: number; link?: string };

export type HiddenUnstaged = {
  /** Put every file's working-tree bytes and mode back; null when done, else why not. */
  restore: () => string | null;
};

/**
 * Replace each of `files` (top-relative, each staged in part) in the working
 * tree with its staged content from the real index. Returns the restorer, or
 * an error when a file could not be saved or checked out (nothing is left
 * changed then).
 */
export function hideUnstaged(
  cwd: string,
  files: readonly string[],
): HiddenUnstaged | { error: string } {
  const top = gitLine(cwd, ["rev-parse", "--show-toplevel"]);
  const store = gitLine(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    `workit/unstaged-${process.pid}-${Date.now()}`,
  ]);
  if (!top || !store)
    return { error: "could not locate the worktree to set the unstaged changes aside" };
  const saved: Saved[] = [];
  const restore = (): string | null => {
    const failed: string[] = [];
    for (const entry of saved) {
      const target = path.join(top, entry.file);
      try {
        rmSync(target, { force: true });
        if (entry.link !== undefined) symlinkSync(entry.link, target);
        else if (entry.copy !== null) {
          writeFileSync(target, readFileSync(entry.copy));
          chmodSync(target, entry.mode);
        }
      } catch {
        failed.push(entry.file);
      }
    }
    if (failed.length)
      return `could not put back the unstaged changes of ${failed.join(", ")}; the originals are in ${store}`;
    rmSync(store, { recursive: true, force: true });
    return null;
  };
  try {
    mkdirSync(store, { recursive: true });
    files.forEach((file, index) => {
      const source = path.join(top, file);
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat) {
        saved.push({ file, copy: null, mode: 0 });
        return;
      }
      if (stat.isSymbolicLink()) {
        saved.push({ file, copy: null, mode: 0, link: readlinkSync(source) });
        return;
      }
      const copy = path.join(store, String(index));
      copyFileSync(source, copy);
      saved.push({ file, copy, mode: stat.mode & 0o7777 });
    });
    writeFileSync(path.join(store, "files.json"), JSON.stringify(saved));
  } catch (error) {
    rmSync(store, { recursive: true, force: true });
    return {
      error: `could not set the unstaged changes aside: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // checkout-index takes paths relative to the cwd, without pathspec magic.
  const checkout = spawnSync("git", ["checkout-index", "-f", "--", ...files], {
    cwd: top,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (checkout.status !== 0) {
    const restored = restore();
    return {
      error: `could not check out the staged content of ${files.join(", ")}: ${(checkout.stderr ?? "").trim()}${restored ? `; ${restored}` : ""}`,
    };
  }
  return { restore };
}
