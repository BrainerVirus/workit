// Where the task event store lives and which task a checkout's work belongs
// to (design §4.1, D3, D13).
//
// - The store directory is `<git common dir>/workit` in a git repository, so
//   every worktree of the repo shares it and it survives worktree removal and
//   `git clean`; outside git it is `<root>/.workit`.
// - The implicit task key is the branch name when HEAD is attached,
//   `detached-<hash of the worktree>` on a detached HEAD, and
//   `dir-<hash of the root>` outside git.
//
// Per-turn hooks resolve this on every event, so the common layouts (a `.git`
// directory, or a worktree's `.git` file with its `commondir`) are read from
// the filesystem. Anything else, or any GIT_* discovery override in the
// environment, asks git itself.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StoreLocation = {
  /** The store directory. */
  dir: string;
  /** True in a git repository (shared by its worktrees). */
  shared: boolean;
  /** The worktree top level (null outside git, or in a bare repository). */
  top: string | null;
  /** The worktree's own git dir, when read from the filesystem. */
  git?: { gitDir: string; top: string | null; reftable: boolean };
};

export type TaskKey = {
  key: string;
  kind: "branch" | "detached" | "dir";
  /** The branch name when HEAD is attached. */
  branch: string | null;
  /** When a task was bound to this key (stored with the binding). */
  boundAt?: string;
};

const NOT_A_REPO = /not a git repository \(or any (of the parent directories|parent up to)/u;

type GitRun = { ok: boolean; stdout: string; stderr: string; missing: boolean };
const gitRun = (cwd: string, args: string[]): GitRun => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      LANGUAGE: "C",
    },
  });
  const error: NodeJS.ErrnoException | undefined = run.error;
  return {
    ok: run.status === 0,
    stdout: run.stdout ?? "",
    stderr: error ? String(error.message) : (run.stderr ?? ""),
    missing: error?.code === "ENOENT",
  };
};

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/** The canonical path (the native resolver also expands Windows 8.3 short names). */
const real = (file: string): string => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
};

/** Environment that changes how git discovers a repository. */
const DISCOVERY_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

type FastGit =
  | { kind: "none" }
  | { kind: "repo"; common: string; gitDir: string; top: string | null; reftable: boolean };

/** A directory that is itself a git dir (a bare repository, or inside `.git`). */
const isGitDir = (dir: string): boolean => {
  try {
    return (
      fs.statSync(path.join(dir, "HEAD")).isFile() &&
      fs.statSync(path.join(dir, "objects")).isDirectory() &&
      fs.statSync(path.join(dir, "refs")).isDirectory()
    );
  } catch {
    return false;
  }
};

const reftableRefs = (common: string): boolean => {
  try {
    return /^\s*refstorage\s*=\s*reftable\s*$/imu.test(
      fs.readFileSync(path.join(common, "config"), "utf8"),
    );
  } catch {
    return false;
  }
};

/**
 * Find the repository the way git does for the plain layouts, without
 * spawning git: from the canonical path (symlinks resolved first, as git
 * does), walk up to the first `.git` or git dir (stopping at a filesystem
 * boundary, like git), then follow a `.git` file and `commondir`. Null when
 * the layout is anything else, so the caller asks git.
 */
function fastGit(root: string): FastGit | null {
  if (DISCOVERY_ENV.some((name) => process.env[name])) return null;
  let dir = real(root);
  let device: number | null = null;
  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      return null;
    }
    if (device !== null && stat.dev !== device) return { kind: "none" };
    device = stat.dev;
    const dotGit = path.join(dir, ".git");
    let entry: fs.Stats | null = null;
    try {
      entry = fs.statSync(dotGit);
    } catch {}
    let gitDir: string | null = null;
    let top: string | null = null;
    if (entry) {
      top = dir;
      if (entry.isDirectory()) gitDir = dotGit;
      else if (entry.isFile()) {
        let text = "";
        try {
          text = fs.readFileSync(dotGit, "utf8");
        } catch {
          return null;
        }
        const match = /^gitdir: (.+)$/mu.exec(text);
        if (!match) return null;
        gitDir = path.resolve(dir, match[1].trim());
      } else return null;
      if (!fs.existsSync(path.join(gitDir, "HEAD"))) return null;
    } else if (isGitDir(dir)) gitDir = dir;
    if (gitDir) {
      let common = gitDir;
      try {
        common = path.resolve(
          gitDir,
          fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
        );
      } catch {}
      if (!fs.existsSync(path.join(common, "objects"))) return null;
      return {
        kind: "repo",
        common: real(common),
        gitDir: real(gitDir),
        top: top === null ? null : real(top),
        reftable: reftableRefs(common),
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { kind: "none" };
    dir = parent;
  }
}

/**
 * The store directory for a checkout root, or an error message when git
 * cannot answer for a directory that is (or may be) inside a repository.
 * `top` is the worktree's top level (null for a bare repository or a git
 * dir); a checkout is identified by it, so every subdirectory of a worktree
 * is the same checkout.
 */
export function resolveStore(root: string): StoreLocation | Error {
  root = path.resolve(root);
  // A root that is not (yet) a directory has no repository: keep the 2.x
  // per-directory layout, so reads and writes fail or create as before.
  let directory = false;
  try {
    directory = fs.statSync(root).isDirectory();
  } catch {}
  if (!directory) return { dir: path.join(root, ".workit"), shared: false, top: null };
  const fast = fastGit(root);
  if (fast?.kind === "none") return { dir: path.join(root, ".workit"), shared: false, top: null };
  if (fast?.kind === "repo")
    return {
      dir: path.join(fast.common, "workit"),
      shared: true,
      top: fast.top,
      git: { gitDir: fast.gitDir, top: fast.top, reftable: fast.reftable },
    };
  const run = gitRun(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = run.stdout.trim();
  if (run.ok && common) {
    const top = gitRun(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    return {
      dir: path.join(real(path.resolve(root, common)), "workit"),
      shared: true,
      top: top.ok && top.stdout.trim() ? real(top.stdout.trim()) : null,
    };
  }
  if (run.missing || (!run.ok && NOT_A_REPO.test(run.stderr)))
    return { dir: path.join(root, ".workit"), shared: false, top: null };
  return new Error(
    `cannot locate the workit store: git rev-parse failed (${run.stderr.trim().split("\n")[0] || "no output"}); fix the repository (git status should work here)`,
  );
}

/** The branch a rebase in progress will update (HEAD is detached meanwhile). */
const rebasingBranch = (gitDir: string): string | null => {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    try {
      const ref = fs.readFileSync(path.join(gitDir, state, "head-name"), "utf8").trim();
      const match = /^refs\/heads\/(.+)$/u.exec(ref);
      if (match) return match[1];
    } catch {}
  }
  return null;
};

/** The implicit task key for `root` (see the module comment). */
export function resolveTaskKey(root: string, location: StoreLocation): TaskKey {
  if (!location.shared) return { key: `dir-${shortHash(root)}`, kind: "dir", branch: null };
  const branchKey = (name: string): TaskKey => ({ key: name, kind: "branch", branch: name });
  // reftable keeps refs out of the filesystem; HEAD is a `refs/heads/.invalid` stub.
  if (location.git && !location.git.reftable) {
    let head = "";
    try {
      head = fs.readFileSync(path.join(location.git.gitDir, "HEAD"), "utf8").trim();
    } catch {}
    const ref = /^ref: refs\/heads\/(.+)$/u.exec(head);
    if (ref && ref[1] !== ".invalid") return branchKey(ref[1]);
    if (/^[0-9a-f]{40,64}$/u.test(head)) {
      const rebasing = rebasingBranch(location.git.gitDir);
      if (rebasing) return branchKey(rebasing);
      return {
        key: `detached-${shortHash(location.git.top ?? location.git.gitDir)}`,
        kind: "detached",
        branch: null,
      };
    }
  }
  const branch = gitRun(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const name = branch.ok ? branch.stdout.trim() : "";
  if (name && name !== ".invalid") return branchKey(name);
  const gitDir = gitRun(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (gitDir.ok && gitDir.stdout.trim()) {
    const rebasing = rebasingBranch(gitDir.stdout.trim());
    if (rebasing) return branchKey(rebasing);
  }
  const top = gitRun(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const worktree = top.ok && top.stdout.trim() ? top.stdout.trim() : root;
  return { key: `detached-${shortHash(real(worktree))}`, kind: "detached", branch: null };
}

/**
 * The checkout a path belongs to: its worktree's top level in a git
 * repository (so every subdirectory is the same checkout), else the path.
 */
export function checkoutRootOf(root: string, location?: StoreLocation | Error): string {
  const resolved = path.resolve(root);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
  const found = location ?? resolveStore(canonical);
  if (found instanceof Error || !found.shared || !found.top) return canonical;
  // Keep the caller's spelling (e.g. a Windows short name) when it already is the top.
  if (real(canonical) === found.top) return canonical;
  try {
    return fs.realpathSync(found.top);
  } catch {
    return canonical;
  }
}

export type BranchRename = { from: string; to: string; /** Unix seconds. */ at: number };

/**
 * Branch renames recorded in the reflogs ("Branch: renamed refs/heads/a to
 * refs/heads/b"): every branch log in the common dir, plus this worktree's
 * HEAD log. Oldest first.
 */
export function branchRenames(location: StoreLocation): BranchRename[] {
  if (!location.shared) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else files.push(path.join(dir, entry.name));
  };
  walk(path.join(path.dirname(location.dir), "logs", "refs", "heads"));
  if (location.git) files.push(path.join(location.git.gitDir, "logs", "HEAD"));
  const seen = new Set<string>();
  const renames: BranchRename[] = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(
      / (\d+) [+-]\d{4}\tBranch: renamed refs\/heads\/(\S+) to refs\/heads\/(\S+)/gu,
    )) {
      const rename = { from: match[2], to: match[3], at: Number(match[1]) };
      const id = `${rename.at}\0${rename.from}\0${rename.to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      renames.push(rename);
    }
  }
  return renames.toSorted((left, right) => left.at - right.at);
}

/**
 * The key a task bound to `key` at `boundAt` (ISO time) follows to: a branch
 * renamed after the task was bound takes its task along, so a new branch
 * created later under the old name does not inherit it.
 */
export function followRenames(key: string, boundAt: string, renames: BranchRename[]): string {
  let current = key;
  let since = Math.floor(Date.parse(boundAt) / 1000);
  for (const rename of renames)
    if (rename.from === current && rename.at >= since) {
      current = rename.to;
      since = rename.at;
    }
  return current;
}

/**
 * A filesystem-safe directory name for one checkout's records, from its
 * canonical path, so every spelling of the same directory (symlinks, Windows
 * short names, drive-letter case) maps to one checkout.
 */
export const checkoutSlug = (root: string): string => {
  let canonical = real(root);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const base =
    path
      .basename(canonical)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 40) || "root";
  return `${base}-${shortHash(canonical)}`;
};
