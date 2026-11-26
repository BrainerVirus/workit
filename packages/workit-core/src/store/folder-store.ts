// Outside every git repository a folder's Workit store lives in the state dir,
// `<state>/folders/<slug>` (workit-paths.mjs folderStoreDir), never in the
// folder (#892). Older Workit kept it in `<folder>/.workit`; the first
// resolve moves it once, keeping the folder's own config (checks.json,
// risk-paths) and what a 2.x migration left for 2.x readers where they are.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What `<folder>/.workit` may hold that is the folder's own config, not state. */
const FOLDER_CONFIG = new Set(["checks.json", "risk-paths"]);

/** The note left in `<folder>/.workit` when some of it could not move. */
export const MOVED_POINTER = "MOVED-TO-STATE.txt";

/**
 * What a 2.x migration leaves in `<folder>/.workit` on purpose: recovery
 * copies (`workit gc --prune-recovery` reads them there), the 2.x index, and
 * `tasks/<id>.json` stubs 2.x readers fail closed on.
 */
const V2_LEFTOVERS = new Set(["recovery", "index.json"]);
const isV2TaskStub = (rel: string): boolean => /^tasks[/\\][^/\\]+\.json$/u.test(rel);

/** The 3.x marker `<folder>/.workit/workspace.json` older Workit wrote (2.x readers fail closed on it). */
const MARKER = "workspace.json";

/** Null when absent, else whether it is a 2.x workspace (not a 3.x marker). */
const v2Workspace = (workit: string): boolean | null => {
  let bytes: string;
  try {
    bytes = fs.readFileSync(path.join(workit, MARKER), "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(bytes) as { store?: { format?: unknown } } | null;
    return value?.store?.format !== "workit-store";
  } catch {
    return true;
  }
};

/** A `.gitignore` older Workit generated (`*`, or `*` and `!risk-paths`). */
const generatedIgnore = (file: string): boolean => {
  try {
    return /^\*\n(!risk-paths\n)?$/u.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
};

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const isDir = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isDirectory();
  } catch {
    return false;
  }
};

const onlyStubs = (tasks: string): boolean => {
  try {
    return fs.readdirSync(tasks).every((entry) => isV2TaskStub(`tasks/${entry}`));
  } catch {
    return false;
  }
};

/**
 * The entries of `<folder>/.workit` that are state to move: everything but
 * the folder's own config, the pointer, the marker, a generated `.gitignore`
 * and 2.x leftovers. Empty when there is no such directory.
 */
export const strayEntries = (workit: string): string[] => {
  if (!isDir(workit)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(workit);
  } catch {
    return [];
  }
  return names.filter(
    (name) =>
      !FOLDER_CONFIG.has(name) &&
      !V2_LEFTOVERS.has(name) &&
      name !== MOVED_POINTER &&
      name !== MARKER &&
      !(name === ".gitignore" && generatedIgnore(path.join(workit, name))) &&
      // A tasks dir holding only 2.x stubs has nothing to move.
      !(name === "tasks" && onlyStubs(path.join(workit, name))),
  );
};

type FolderMigration = {
  from: string;
  to: string;
  /** Paths (relative to `.workit`) moved, each whole. */
  moved: string[];
  /** Paths (relative to `.workit`) left in place: the store already has one, or the move failed. */
  kept: string[];
};

/** The filesystem calls a move makes (a test seam: a copy that fails midway). */
export const folderStoreIo = {
  rename: (from: string, to: string) => fs.renameSync(from, to),
  copyFile: (from: string, to: string) => fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL),
  /** Between judging a lock stale and taking it over (a test widens the race here). */
  judgedStale: () => {},
};

let tempSeq = 0;
/** A temp name beside `file`, in the same dir, so the final rename is atomic. */
const tempBeside = (file: string): string =>
  path.join(
    path.dirname(file),
    `.${path.basename(file)}.workit-move-${process.pid}-${(tempSeq += 1)}`,
  );

/**
 * Copy `from` to the absent `to` when a rename cannot (another device, a
 * read-only parent): directories are made in place, each file or link goes
 * to a temp name beside its target and is renamed in, so a final path only
 * ever holds a complete file. A failure removes its temp and throws; files
 * already in place are complete, and a rerun drops their source copies.
 */
const copyInto = (from: string, to: string) => {
  const stat = fs.lstatSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyInto(path.join(from, name), path.join(to, name));
    return;
  }
  if (exists(to)) throw new Error(`${to} appeared during the move`);
  const temp = tempBeside(to);
  try {
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), temp);
    else folderStoreIo.copyFile(from, temp);
    folderStoreIo.rename(temp, to);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
};

/** Two regular files with the same bytes (a copy a failed earlier move left complete). */
const sameFile = (left: string, right: string): boolean => {
  try {
    const [a, b] = [fs.lstatSync(left), fs.lstatSync(right)];
    if (!a.isFile() || !b.isFile() || a.size !== b.size) return false;
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
};

/**
 * Move `from` into `to` without replacing anything there: a whole entry when
 * `to` is absent (a rename, else copyInto then a removal), a merge when both
 * are directories; a file the target already holds byte for byte only loses
 * its source. Returns the relative paths left behind; adds those moved to `moved`.
 */
const merge = (from: string, to: string, rel: string, moved: string[]): string[] => {
  if (isV2TaskStub(rel)) return [];
  if (!exists(to)) {
    try {
      folderStoreIo.rename(from, to);
    } catch {
      try {
        copyInto(from, to);
        fs.rmSync(from, { recursive: true, force: true });
      } catch {
        // What copied is complete and stays; a rerun merges the rest.
        return exists(from) ? [rel] : [];
      }
    }
    moved.push(rel);
    return [];
  }
  if (sameFile(from, to)) {
    fs.rmSync(from, { force: true });
    moved.push(rel);
    return [];
  }
  if (!isDir(from) || !isDir(to)) return [rel];
  const kept = fs
    .readdirSync(from)
    .flatMap((name) => merge(path.join(from, name), path.join(to, name), `${rel}/${name}`, moved));
  try {
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  } catch {}
  return kept;
};

/** How long a lock holder may take before its lock counts as abandoned. */
const LOCK_STALE_MS = 10_000;
/** How long a second mover waits before it skips the move this time. */
const LOCK_WAIT_MS = 250;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** What staleLock judged: the lock's pid (NaN when unreadable) and mtime. */
type StaleLock = { pid: number; mtimeMs: number };

/** The pid written in a lock file, NaN when it holds none. */
const lockPid = (lock: string): number => Number(fs.readFileSync(lock, "utf8").trim());

/** The lock holder is gone (a dead pid) or past LOCK_STALE_MS: what it judged, else null. */
const staleLock = (lock: string): StaleLock | null => {
  try {
    const { mtimeMs } = fs.statSync(lock);
    const pid = lockPid(lock);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) return { pid, mtimeMs };
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? { pid, mtimeMs } : null;
    }
  } catch {
    return null;
  }
};

/**
 * Take over the stale `lock` staleLock judged, atomically: rename it aside
 * (one mover wins; a loser gets ENOENT), then check the renamed file is the
 * one judged. A fresh lock swapped in meanwhile is linked back, never over a
 * lock created since, and the takeover fails. True when the stale one is gone.
 */
const removeStaleLock = (lock: string, judged: StaleLock): boolean => {
  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false;
  }
  let same = false;
  try {
    same = fs.statSync(aside).mtimeMs === judged.mtimeMs && Object.is(lockPid(aside), judged.pid);
  } catch {}
  if (!same)
    try {
      fs.linkSync(aside, lock);
    } catch {}
  fs.rmSync(aside, { force: true });
  return same;
};

/**
 * Take `<target>.lock` (O_EXCL) for one move: a short wait for a live holder,
 * a stale one is taken over. Null when it stays busy: the caller skips the
 * move this time, so a hook is never held up for long.
 */
export const takeMoveLock = (target: string): (() => void) | null => {
  const lock = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => fs.rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    const stale = staleLock(lock);
    if (stale) {
      folderStoreIo.judgedStale();
      if (removeStaleLock(lock, stale)) continue;
    }
    if (Date.now() >= deadline) return null;
    pause(25);
  }
};

const canonical = (dir: string): string => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** `child` is strictly below `parent`. */
const below = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Where a refused resolve is recorded under a test run, in the `WORKIT_TEST_RUN` dir. */
export const TEST_RUN_REFUSALS = "folder-store-refusals.log";

/**
 * Under a test run (`WORKIT_TEST_RUN`, set by the suite's state-isolation
 * preload), why the move of `<folder>/.workit` must not run: a test may only
 * move one from a dir of its own inside the OS temp dir. From the temp dir
 * itself, a parent of it (a `cwd: "/tmp"` payload), the account's home or any
 * other folder outside it, the move would carry a real `.workit` into the
 * run's throwaway state dir, which the run deletes (#892). Null outside a
 * test run, when there is nothing to move, or for a folder the test owns.
 */
export const testRunFolderRefusal = (
  folder: string,
  hasStray: boolean,
  env: NodeJS.ProcessEnv = process.env,
  tempDir: string = os.tmpdir(),
): string | null => {
  if (env.WORKIT_TEST_RUN === undefined || !hasStray) return null;
  const real = canonical(folder);
  const tmp = canonical(tempDir);
  if (below(tmp, real)) return null;
  return `workit test run (WORKIT_TEST_RUN): refusing to move ${path.join(real, ".workit")} into the run's throwaway state dir; a test must work in a fresh dir inside ${tmp}, never the temp dir itself, a parent of it or a folder outside it (#892)`;
};

/**
 * Move a folder's old `<folder>/.workit` store into `target` once. Never
 * replaces an entry the target has; what stays gets a pointer file naming the
 * target. Null when there was nothing to move (the usual case, one lstat).
 */
export function migrateFolderStore(
  folder: string,
  target: string,
  note: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): FolderMigration | null {
  const workit = path.join(folder, ".workit");
  const names = strayEntries(workit);
  const refusal = testRunFolderRefusal(folder, names.length > 0);
  if (refusal) {
    // Hooks fail open, so the throw alone may go unseen: the suite's preload
    // fails the test that left this file (test/shared/state-isolation.ts).
    const run = process.env.WORKIT_TEST_RUN ?? "";
    if (path.isAbsolute(run))
      try {
        fs.appendFileSync(path.join(run, TEST_RUN_REFUSALS), `${refusal}\n`);
      } catch {}
    throw new Error(refusal);
  }
  // A 2.x store migrates through the task store first (task-store.ts).
  if (names.length === 0 || v2Workspace(workit) === true) return null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    return null;
  }
  const release = takeMoveLock(target);
  if (!release) return null;
  try {
    return moveLocked(workit, target, note);
  } finally {
    release();
  }
}

/** migrateFolderStore's move, under its lock: what another mover left is re-read here. */
function moveLocked(
  workit: string,
  target: string,
  note: (line: string) => void,
): FolderMigration | null {
  const names = strayEntries(workit);
  if (names.length === 0 || v2Workspace(workit) === true) return null;
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return null;
  }
  const result: FolderMigration = { from: workit, to: target, moved: [], kept: [] };
  for (const name of names) {
    result.kept.push(
      ...merge(path.join(workit, name), path.join(target, name), name, result.moved),
    );
  }
  // The marker and a generated .gitignore go once only the folder's config is left.
  const left = (() => {
    try {
      return fs.readdirSync(workit);
    } catch {
      return [];
    }
  })();
  const v2Left = left.some(
    (name) => V2_LEFTOVERS.has(name) || (name === "tasks" && isDir(path.join(workit, name))),
  );
  if (!v2Left && result.kept.length === 0) {
    fs.rmSync(path.join(workit, MARKER), { force: true });
    if (generatedIgnore(path.join(workit, ".gitignore")))
      fs.rmSync(path.join(workit, ".gitignore"), { force: true });
  }
  const pointer = path.join(workit, MOVED_POINTER);
  let wrote = false;
  if (result.kept.length > 0) {
    const text = `Workit keeps this folder's state in ${target}.\nNot moved, because the store there already has them or the move failed: ${result.kept.join(", ")}.\nMerge them by hand (cp -Rn ${workit}/. ${target}/), then delete them here.\n`;
    try {
      if (!exists(pointer) || fs.readFileSync(pointer, "utf8") !== text) {
        fs.writeFileSync(pointer, text);
        wrote = true;
      }
    } catch {}
  } else {
    fs.rmSync(pointer, { force: true });
    try {
      if (fs.readdirSync(workit).length === 0) fs.rmdirSync(workit);
    } catch {}
  }
  if (result.moved.length > 0 || wrote)
    note(
      result.kept.length > 0
        ? `workit: moved ${workit} to ${target}; ${result.kept.length} path${result.kept.length === 1 ? "" : "s"} left in place, see ${pointer}`
        : `workit: moved ${workit} to ${target} (outside a git repository Workit keeps its state there)`,
    );
  return result;
}
