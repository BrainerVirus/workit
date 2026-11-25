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
// The originals are copied to `<git dir>/workit/unstaged-<pid>-<ms>/` with a
// manifest first and removed only once restored, so an interrupted commit
// leaves them there; `workit doctor` reports such a folder and
// `workit gc --unstaged` puts them back (git/unstaged-backups.ts).
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

export const runGit = (cwd: string, args: string[], input?: string) =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });

const gitLine = (cwd: string, args: string[]): string | null => {
  const run = runGit(cwd, args);
  return run.status === 0 ? run.stdout.trim() : null;
};

/** A backup folder's name: the committing process and when it started. */
export const BACKUP_DIR = /^unstaged-(\d+)-(\d+)$/u;
export const MANIFEST = "files.json";

/**
 * One file set aside. `copy` (a name in the folder) holds its bytes; null
 * with no `link`: the file was gone from the working tree. `staged` is the
 * blob the hide step wrote to the working tree.
 */
export type SavedFile = {
  file: string;
  copy: string | null;
  mode: number;
  link?: string;
  staged: string;
};

export type BackupManifest = {
  version: 1;
  pid: number;
  createdAt: number;
  /** The worktree's top directory. */
  top: string;
  files: SavedFile[];
};

/** Put one saved file back as it was; throws on an I/O error. */
export function restoreSaved(dir: string, top: string, entry: SavedFile): void {
  const target = path.join(top, entry.file);
  rmSync(target, { force: true });
  if (entry.link !== undefined) symlinkSync(entry.link, target);
  else if (entry.copy !== null) {
    writeFileSync(target, readFileSync(path.join(dir, entry.copy)));
    chmodSync(target, entry.mode);
  }
}

export type HiddenUnstaged = {
  /** Put every file's working-tree bytes and mode back; null when done, else why not. */
  restore: () => string | null;
};

/** `path -> staged blob` from the real index (top-relative paths). */
const stagedBlobs = (top: string, files: readonly string[]): Map<string, string> => {
  const blobs = new Map<string, string>();
  const run = runGit(top, ["ls-files", "-s", "-z", "--", ...files.map((f) => `:(literal)${f}`)]);
  for (const entry of (run.stdout ?? "").split("\0")) {
    const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/u.exec(entry);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
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
  const createdAt = Date.now();
  const store = gitLine(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    `workit/unstaged-${process.pid}-${createdAt}`,
  ]);
  if (!top || !store)
    return { error: "could not locate the worktree to set the unstaged changes aside" };
  const blobs = stagedBlobs(top, files);
  const missing = files.filter((file) => !blobs.has(file));
  if (missing.length) return { error: `no staged content to commit for ${missing.join(", ")}` };
  const saved: SavedFile[] = [];
  const restore = (): string | null => {
    const failed: string[] = [];
    for (const entry of saved) {
      try {
        restoreSaved(store, top, entry);
      } catch {
        failed.push(entry.file);
      }
    }
    if (failed.length)
      return `could not put back the unstaged changes of ${failed.join(", ")}; the originals are in ${store} (workit gc --unstaged --apply restores them)`;
    rmSync(store, { recursive: true, force: true });
    return null;
  };
  try {
    mkdirSync(store, { recursive: true });
    files.forEach((file, index) => {
      const staged = blobs.get(file)!;
      const source = path.join(top, file);
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat) saved.push({ file, copy: null, mode: 0, staged });
      else if (stat.isSymbolicLink())
        saved.push({ file, copy: null, mode: 0, link: readlinkSync(source), staged });
      else {
        copyFileSync(source, path.join(store, String(index)));
        saved.push({ file, copy: String(index), mode: stat.mode & 0o7777, staged });
      }
    });
    const manifest: BackupManifest = {
      version: 1,
      pid: process.pid,
      createdAt,
      top,
      files: saved,
    };
    writeFileSync(path.join(store, MANIFEST), JSON.stringify(manifest));
  } catch (error) {
    rmSync(store, { recursive: true, force: true });
    return {
      error: `could not set the unstaged changes aside: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // checkout-index takes paths relative to the cwd, without pathspec magic.
  const checkout = runGit(top, ["checkout-index", "-f", "--", ...files]);
  if (checkout.status !== 0) {
    const restored = restore();
    return {
      error: `could not check out the staged content of ${files.join(", ")}: ${(checkout.stderr ?? "").trim()}${restored ? `; ${restored}` : ""}`,
    };
  }
  return { restore };
}
