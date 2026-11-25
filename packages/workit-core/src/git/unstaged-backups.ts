// Backups a killed `workit git commit` left behind (#907 follow-up).
//
// While its hooks run, a path-form commit puts a partly staged file's staged
// content in the working tree and keeps the original under
// `<git dir>/workit/unstaged-<pid>-<ms>/` (git/hide-unstaged.ts). A commit
// killed before it put the original back leaves that folder. Each saved file
// is then in one of three states:
//
// - restored: the working tree holds the original again; nothing to do.
// - hidden: the working tree still holds exactly the staged content the hide
//   step wrote, so putting the original back loses nothing.
// - changed: someone edited the file since; it is never overwritten, and the
//   folder stays so the original can be copied back by hand.
// - unhashable: git could not hash the working-tree file, so whether it was
//   edited is unknown; it is treated as changed.
//
// `workit doctor` reports the folders (unstaged_backups); `workit gc
// --unstaged` lists them and, with --apply, restores the hidden files and
// removes a folder once none of its files is changed. A folder whose
// committing process still runs is a commit in progress and is left alone.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";
import {
  BACKUP_DIR,
  MANIFEST,
  restoreSaved,
  runGit,
  type BackupManifest,
  type SavedFile,
} from "./hide-unstaged";

export type BackupFileState = "restored" | "hidden" | "changed" | "unhashable";

export type UnstagedBackup = {
  dir: string;
  pid: number;
  ageMs: number;
  /** The committing process still runs: a commit in progress. */
  live: boolean;
  top: string | null;
  files: { file: string; state: BackupFileState }[];
  /** Why the folder cannot be read or checked; it is kept. */
  problem?: string;
};

export type BackupAction = "removed" | "restored" | "kept" | "would remove" | "would restore";

export type UnstagedSweep = {
  apply: boolean;
  backups: (UnstagedBackup & { action: BackupAction; reason: string })[];
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Every git dir of the repository at `cwd`: the main one and each linked worktree's. */
const gitDirs = (cwd: string): string[] => {
  const run = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (run.status !== 0) return [];
  const common = run.stdout.trim();
  const worktrees = path.join(common, "worktrees");
  return [common, ...listDir(worktrees).map((name) => path.join(worktrees, name))];
};

/**
 * The blob git would store for the working-tree file now; null when it is
 * gone, undefined when git could not hash it.
 */
const worktreeBlob = (top: string, file: string): string | null | undefined => {
  const target = path.join(top, file);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  const run = stat.isSymbolicLink()
    ? runGit(top, ["hash-object", "--stdin"], readlinkSync(target))
    : runGit(top, ["hash-object", `--path=${file}`, "--", file]);
  return run.status === 0 ? run.stdout.trim() : undefined;
};

const isOriginal = (dir: string, top: string, entry: SavedFile): boolean => {
  const target = path.join(top, entry.file);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (entry.link !== undefined)
    return !!stat?.isSymbolicLink() && readlinkSync(target) === entry.link;
  if (entry.copy === null) return !stat;
  if (!stat?.isFile()) return false;
  return readFileSync(target).equals(readFileSync(path.join(dir, entry.copy)));
};

const fileState = (dir: string, top: string, entry: SavedFile): BackupFileState => {
  if (isOriginal(dir, top, entry)) return "restored";
  const blob = worktreeBlob(top, entry.file);
  if (blob === undefined) return "unhashable";
  return blob === entry.staged ? "hidden" : "changed";
};

const readManifest = (dir: string): BackupManifest | null => {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, MANIFEST), "utf8")) as BackupManifest;
    return parsed.version === 1 && Array.isArray(parsed.files) && typeof parsed.top === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const inspect = (dir: string, pid: number, startedAt: number, now: number): UnstagedBackup => {
  const base = { dir, pid, ageMs: Math.max(0, now - startedAt), live: processAlive(pid) };
  const manifest = readManifest(dir);
  if (!manifest)
    return { ...base, top: null, files: [], problem: `no readable ${MANIFEST} in the folder` };
  if (!existsSync(manifest.top))
    return {
      ...base,
      top: manifest.top,
      files: manifest.files.map((entry) => ({ file: entry.file, state: "changed" as const })),
      problem: `its worktree ${manifest.top} is gone`,
    };
  return {
    ...base,
    top: manifest.top,
    files: manifest.files.map((entry) => ({
      file: entry.file,
      state: fileState(dir, manifest.top, entry),
    })),
  };
};

/** The backup folders under every git dir of the repository at `cwd`. */
export function findUnstagedBackups(cwd: string, now = Date.now()): UnstagedBackup[] {
  const found: UnstagedBackup[] = [];
  for (const gitDir of gitDirs(cwd)) {
    const store = path.join(gitDir, "workit");
    for (const name of listDir(store)) {
      const match = BACKUP_DIR.exec(name);
      if (!match) continue;
      found.push(inspect(path.join(store, name), Number(match[1]), Number(match[2]), now));
    }
  }
  return found;
}

const summary = (backup: UnstagedBackup, state: BackupFileState): string[] =>
  backup.files.filter((entry) => entry.state === state).map((entry) => entry.file);

/**
 * List the backup folders and, with `apply`, put each hidden file back and
 * remove a folder once none of its files is changed. Never writes over a
 * changed file, never touches a commit in progress.
 */
export function sweepUnstagedBackups(cwd: string, options: { apply: boolean }): UnstagedSweep {
  const backups = findUnstagedBackups(cwd).map((backup) => {
    if (backup.live)
      return {
        ...backup,
        action: "kept" as const,
        reason: `commit in progress (pid ${backup.pid})`,
      };
    if (backup.problem) return { ...backup, action: "kept" as const, reason: backup.problem };
    const hidden = summary(backup, "hidden");
    const changed = summary(backup, "changed");
    const unhashable = summary(backup, "unhashable");
    const kept = [
      ...(changed.length ? [`changed since the commit: ${changed.join(", ")}`] : []),
      ...(unhashable.length ? [`could not hash: ${unhashable.join(", ")}`] : []),
    ];
    const keep = kept.length
      ? `${kept.join("; ")}; not overwritten, the originals stay in ${backup.dir}`
      : null;
    if (!options.apply) {
      if (hidden.length)
        return {
          ...backup,
          action: "would restore" as const,
          reason: `would put back ${hidden.join(", ")}${keep ? `; ${keep}` : ""}`,
        };
      return keep
        ? { ...backup, action: "kept" as const, reason: keep }
        : { ...backup, action: "would remove" as const, reason: "every file already restored" };
    }
    const manifest = readManifest(backup.dir)!;
    const failed: string[] = [];
    const files = backup.files.map((entry) => {
      if (entry.state !== "hidden") return entry;
      const saved = manifest.files.find((item) => item.file === entry.file)!;
      try {
        restoreSaved(backup.dir, manifest.top, saved);
        return { ...entry, state: "restored" as const };
      } catch {
        failed.push(entry.file);
        return entry;
      }
    });
    if (failed.length || keep)
      return {
        ...backup,
        files,
        action: hidden.length > failed.length ? ("restored" as const) : ("kept" as const),
        reason: [
          ...(hidden.length > failed.length
            ? [`put back ${hidden.filter((file) => !failed.includes(file)).join(", ")}`]
            : []),
          ...(failed.length ? [`could not put back ${failed.join(", ")}`] : []),
          ...(keep ? [keep] : []),
        ].join("; "),
      };
    rmSync(backup.dir, { recursive: true, force: true });
    return {
      ...backup,
      files,
      action: "removed" as const,
      reason: hidden.length ? `put back ${hidden.join(", ")}` : "every file already restored",
    };
  });
  return { apply: options.apply, backups };
}
