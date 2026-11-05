// Git facts that cannot change while one workit process runs, asked once.
//
// A checkout's top level, git dir and common dir are fixed for the life of a
// workit call (no verb moves or re-initialises the repository it runs in), yet
// readers across the CLI asked git for them again and again: in one ledger
// test file, 141 of 1,285 spawned processes (#284 N6). On Windows each spawn
// costs 10-30x more than on Linux.
//
// Only successful answers are cached, so a directory that becomes a repository
// later is asked again. A cached entry whose checkout no longer leads to its
// git dir (removed, or re-added as a new worktree) is dropped. HEAD,
// branches and other refs are never cached here: they move during a call, and
// a stale HEAD would mis-key a SHA-keyed verdict.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Absolute paths as git prints them with --path-format=absolute; `top` is null in a bare repository or a git dir. */
export type GitDirs = { top: string | null; gitDir: string; commonDir: string };

const cache = new Map<string, GitDirs>();

const revParse = (cwd: string, args: string[]): string[] | null => {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (run.status !== 0) return null;
  const lines = (run.stdout ?? "").split(/\r?\n/u).filter(Boolean);
  return lines.length === args.length ? lines : null;
};

const realOrNull = (file: string): string | null => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
};

/**
 * Whether a cached entry still describes the checkout: its `.git` (the git
 * dir itself, or a `gitdir:` file) must still lead to the cached git dir. A
 * worktree removed and re-added at the same path gets a new admin dir, and
 * git may hand the old name to another worktree, so the git dir existing is
 * not enough.
 */
const stillValid = (facts: GitDirs): boolean => {
  const gitDir = realOrNull(facts.gitDir);
  if (!gitDir) return false;
  if (!facts.top) return true;
  const dotGit = path.join(facts.top, ".git");
  let target: string | null = null;
  try {
    if (fs.statSync(dotGit).isDirectory()) target = dotGit;
    else {
      const match = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(dotGit, "utf8"));
      target = match ? path.resolve(facts.top, match[1]) : null;
    }
  } catch {
    return false;
  }
  return target !== null && realOrNull(target) === gitDir;
};

/** The checkout's top level, git dir and common dir, from one git call per directory and process; null outside a repository. */
export function gitDirs(cwd: string): GitDirs | null {
  const key = path.resolve(cwd);
  const hit = cache.get(key);
  if (hit && stillValid(hit)) return hit;
  cache.delete(key);
  const full = revParse(key, ["--git-dir", "--git-common-dir", "--show-toplevel"]);
  // A bare repository (or a cwd inside the git dir) has no top level, and git
  // refuses the whole call: ask again without it.
  const dirs = full ?? revParse(key, ["--git-dir", "--git-common-dir"]);
  if (!dirs) return null;
  const facts = { gitDir: dirs[0], commonDir: dirs[1], top: dirs[2] ?? null };
  cache.set(key, facts);
  return facts;
}

/** For tests that rebuild a repository at a path this process already asked about. */
export function forgetGitDirs(): void {
  cache.clear();
}

// One read per call, never across calls: the origin URL can be changed by the
// user between two workit calls, but one verdict gate asked git for it twice
// (the provider in vcs-config, the verdict mirror's identity in the ledger).
// Inside `withinCall`, the first answer per directory is reused until `fn`
// returns; outside it every read asks git.
let callReads: Map<string, string | null> | null = null;

/** Run `fn` with per-call reads (originUrl) shared, and forgotten when it returns. Nested calls join the outer one. */
export function withinCall<T>(fn: () => T): T {
  if (callReads) return fn();
  callReads = new Map();
  try {
    return fn();
  } finally {
    callReads = null;
  }
}

/** `git remote get-url origin`, trimmed; null without an origin. */
export function originUrl(cwd: string): string | null {
  const key = path.resolve(cwd);
  if (callReads?.has(key)) return callReads.get(key) ?? null;
  const run = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const url = run.status === 0 ? (run.stdout ?? "").trim() || null : null;
  callReads?.set(key, url);
  return url;
}
