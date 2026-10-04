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
  /** The worktree's own git dir and top level, when read from the filesystem. */
  git?: { gitDir: string; top: string };
};

export type TaskKey = {
  key: string;
  kind: "branch" | "detached" | "dir";
  /** The branch name when HEAD is attached. */
  branch: string | null;
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

const real = (file: string): string => {
  try {
    return fs.realpathSync(file);
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

type FastGit = { kind: "none" } | { kind: "repo"; common: string; gitDir: string; top: string };

/**
 * Find the repository the way git does for the plain layouts, without
 * spawning git: walk up to the first `.git` (stopping at a filesystem
 * boundary, like git), then follow a `.git` file and `commondir`. Null when
 * the layout is anything else, so the caller asks git.
 */
function fastGit(root: string): FastGit | null {
  if (DISCOVERY_ENV.some((name) => process.env[name])) return null;
  let dir = root;
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
    if (entry) {
      let gitDir: string;
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
      let common = gitDir;
      try {
        common = path.resolve(
          gitDir,
          fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
        );
      } catch {}
      if (!fs.existsSync(path.join(common, "objects"))) return null;
      return { kind: "repo", common: real(common), gitDir: real(gitDir), top: real(dir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { kind: "none" };
    dir = parent;
  }
}

/**
 * The store directory for a checkout root, or an error message when git
 * cannot answer for a directory that is (or may be) inside a repository.
 */
export function resolveStore(root: string): StoreLocation | Error {
  root = path.resolve(root);
  // A root that is not (yet) a directory has no repository: keep the 2.x
  // per-directory layout, so reads and writes fail or create as before.
  let directory = false;
  try {
    directory = fs.statSync(root).isDirectory();
  } catch {}
  if (!directory) return { dir: path.join(root, ".workit"), shared: false };
  const fast = fastGit(root);
  if (fast?.kind === "none") return { dir: path.join(root, ".workit"), shared: false };
  if (fast?.kind === "repo")
    return {
      dir: path.join(fast.common, "workit"),
      shared: true,
      git: { gitDir: fast.gitDir, top: fast.top },
    };
  const run = gitRun(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = run.stdout.trim();
  if (run.ok && common)
    return { dir: path.join(real(path.resolve(root, common)), "workit"), shared: true };
  if (run.missing || (!run.ok && NOT_A_REPO.test(run.stderr)))
    return { dir: path.join(root, ".workit"), shared: false };
  return new Error(
    `cannot locate the workit store: git rev-parse failed (${run.stderr.trim().split("\n")[0] || "no output"}); fix the repository (git status should work here)`,
  );
}

/** The implicit task key for `root` (see the module comment). */
export function resolveTaskKey(root: string, location: StoreLocation): TaskKey {
  if (!location.shared) return { key: `dir-${shortHash(root)}`, kind: "dir", branch: null };
  if (location.git) {
    let head = "";
    try {
      head = fs.readFileSync(path.join(location.git.gitDir, "HEAD"), "utf8").trim();
    } catch {}
    const ref = /^ref: refs\/heads\/(.+)$/u.exec(head);
    if (ref) return { key: ref[1], kind: "branch", branch: ref[1] };
    if (/^[0-9a-f]{40,64}$/u.test(head))
      return { key: `detached-${shortHash(location.git.top)}`, kind: "detached", branch: null };
  }
  const branch = gitRun(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const name = branch.ok ? branch.stdout.trim() : "";
  if (name) return { key: name, kind: "branch", branch: name };
  const top = gitRun(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const worktree = top.ok && top.stdout.trim() ? top.stdout.trim() : root;
  return { key: `detached-${shortHash(real(worktree))}`, kind: "detached", branch: null };
}

/** A filesystem-safe directory name for one checkout's records. */
export const checkoutSlug = (root: string): string => {
  const base =
    path
      .basename(root)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 40) || "root";
  return `${base}-${shortHash(root)}`;
};
