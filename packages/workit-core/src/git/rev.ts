// Pure git revision and push-target helpers for the CLI verbs (design §2.0,
// §2.2; D16). Plain TS on top of the git binary: no task store, no config
// reads, no zod, so any verb can import this without paying for the engine.
//
// - headSha / worktreeTree / mergeBase / patchId / remoteTip key evidence and
//   verdicts to code state (fresh = same tree key, carried = same patch-id).
// - pushRemoteName / pushUrl / deriveForge / pushForge derive the forge from
//   the PUSH remote host, honoring ~/.ssh/config Host aliases, instead of the
//   configured provider (design §0 #6). forgeConflict turns a disagreement
//   with the workspace provider into a `blocked` result with an unblock hint.
//
// Every git call is bounded: local reads time out after GIT_TIMEOUTS.local,
// worktree hashing after GIT_TIMEOUTS.worktree, and network calls after
// GIT_TIMEOUTS.network. Network calls run under a watchdog that kills git's
// whole process tree on timeout, with prompts disabled
// (networkGitInvocation). Remote URLs are never echoed raw: messages go through
// redactRemote, which drops credentials, query and fragment.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;

/** Default bounds (ms) for git subprocesses; every network helper takes an override. */
export const GIT_TIMEOUTS = { local: 20_000, worktree: 120_000, network: 15_000 } as const;

type GitRun = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

const git = (
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): GitRun => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_BUFFER,
    timeout: options.timeoutMs ?? GIT_TIMEOUTS.local,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const error: NodeJS.ErrnoException | undefined = result.error;
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: error?.code === "ETIMEDOUT",
  };
};

const line = (run: GitRun): string | null => {
  if (!run.ok) return null;
  const value = run.stdout.trim();
  return value ? value : null;
};

// A ref or remote argument must never be read as an option by git.
const safeArg = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/**
 * The exact invocation for a git call that may touch the network: git args
 * with HTTP stall limits, and an environment that can never prompt.
 *
 * - GIT_TERMINAL_PROMPT=0 and empty GIT_ASKPASS/SSH_ASKPASS (an empty value
 *   stops git from falling back to core.askPass) mean no credential prompt.
 *   SSH_ASKPASS_REQUIRE=never and GCM_INTERACTIVE=never cover ssh and Git
 *   Credential Manager.
 * - ssh gets `-o BatchMode=yes -o ConnectTimeout=N`, appended to an existing
 *   GIT_SSH_COMMAND or core.sshCommand. ssh takes the first value of each
 *   option, so the user's own settings still win. A bare GIT_SSH program
 *   (e.g. plink) is left alone because it may not accept `-o`.
 * - HTTPS aborts once the transfer stays below 1 B/s for the whole budget
 *   (http.lowSpeedLimit/lowSpeedTime).
 */
export function networkGitInvocation(
  cwd: string,
  args: string[],
  timeoutMs: number,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
  };
  const base =
    process.env.GIT_SSH_COMMAND ||
    line(git(cwd, ["config", "--get", "core.sshCommand"])) ||
    (process.env.GIT_SSH ? null : "ssh");
  if (base)
    env.GIT_SSH_COMMAND = `${base} -o BatchMode=yes -o ConnectTimeout=${Math.min(10, seconds)}`;
  return {
    args: ["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${seconds}`, ...args],
    env,
  };
}

// Runs in a child runtime (node or bun, whichever runs workit). It starts git
// in its own process group and, on timeout, kills the whole group: git and
// every helper it spawned (git-remote-https with the URL in its argv, ssh).
// Leftover helpers are also killed after a normal exit. Windows has no
// process groups, so the tree is killed with `taskkill /T`.
const WATCHDOG = `
const cp = require("node:child_process");
const { ms, args } = JSON.parse(process.env.WORKIT_GIT_WATCHDOG);
delete process.env.WORKIT_GIT_WATCHDOG;
const win = process.platform === "win32";
const child = cp.spawn("git", args, { stdio: "inherit", detached: !win, windowsHide: true });
const killTree = () => {
  if (!child.pid) return;
  if (win) cp.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else try { process.kill(-child.pid, "SIGKILL"); } catch {}
};
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; killTree(); }, ms);
child.on("error", () => { clearTimeout(timer); process.exit(127); });
child.on("exit", (code) => {
  clearTimeout(timer);
  if (!win) killTree();
  process.exit(timedOut ? 124 : code ?? 1);
});
`;

const WATCHDOG_TIMEOUT_EXIT = 124;

/** A network git call (push, fetch, ls-remote) under the process-group watchdog (see WATCHDOG). */
export const gitNetwork = (cwd: string, args: string[], timeoutMs: number): GitRun => {
  const invocation = networkGitInvocation(cwd, args, timeoutMs);
  const result = spawnSync(process.execPath, ["-e", WATCHDOG], {
    cwd,
    encoding: "utf8",
    env: {
      ...invocation.env,
      WORKIT_GIT_WATCHDOG: JSON.stringify({ ms: timeoutMs, args: invocation.args }),
    },
    maxBuffer: MAX_BUFFER,
    // Backstop only: the watchdog itself enforces timeoutMs.
    timeout: timeoutMs + 10_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const error: NodeJS.ErrnoException | undefined = result.error;
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.status === WATCHDOG_TIMEOUT_EXIT || error?.code === "ETIMEDOUT",
  };
};

const UNPARSEABLE = "<unparseable remote>";

/**
 * A remote (URL or name) that is safe to print: userinfo (except an SSH login
 * name), query and fragment removed. Anything that does not parse as a URL,
 * an scp-like `user@host:path`, a remote name or a local path prints as
 * `<unparseable remote>`.
 */
export function redactRemote(raw: string): string {
  const value = raw.trim();
  if (!value) return UNPARSEABLE;
  // git's `<transport>::<address>` syntax (ext::<command>) can embed anything.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(value)) return UNPARSEABLE;
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith("."))
    return value;
  // A remote name (origin) or a relative path carries no userinfo.
  if (!/[:@]/u.test(value)) return value;
  if (!value.includes("://")) {
    // `user:secret@host:path` is not scp syntax; refuse rather than guess.
    if (/^[^/@]*:[^/]*@/u.test(value)) return UNPARSEABLE;
    const scp = /^(?:([^@\s/:]+)@)?([^:/\s]+):([^?#]+)/u.exec(value);
    return scp ? `${scp[1] ? `${scp[1]}@` : ""}${scp[2]}:${scp[3]}` : UNPARSEABLE;
  }
  try {
    const url = new URL(value);
    const ssh = /^(?:ssh|git\+ssh|ssh\+git):$/u.test(url.protocol);
    url.password = "";
    if (!ssh) url.username = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return UNPARSEABLE;
  }
}

/** The commit HEAD points at, or null (unborn HEAD, not a repository). */
export function headSha(cwd: string): string | null {
  return line(git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]));
}

const emptyTree = (cwd: string): string | null => line(git(cwd, ["mktree"], { input: "" }));

/** Default cap for hashing an untracked file into the worktree key. */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;

export type WorktreeTree = {
  /** The git tree of the worktree (tracked + small untracked files). */
  tree: string;
  /**
   * The freshness key: `tree` itself, or `sha256:<hex>` over `tree` plus the
   * skipped files' path/size/mtime when any untracked file was over the cap.
   */
  key: string;
  dirty: boolean;
  /** Untracked files over the cap, recorded by stat instead of content. */
  skipped: Array<{ path: string; size: number; mtimeMs: number }>;
};

/**
 * Copy the index and keep its mtime. Git trusts an entry's cached stat only
 * when the entry is older than the index file ("racy git"). An entry written
 * in the same timestamp tick as the index is re-hashed instead. A plain copy
 * stamps the index with the current time, so a same-size rewrite in that
 * tick would read as clean. That is common on git builds that compare whole
 * seconds (macOS). The copy's mtime is floored one microsecond below the
 * original: an older index only makes more entries racy, which is the safe
 * direction.
 */
const seedIndex = (from: string, to: string): void => {
  fs.copyFileSync(from, to);
  const { atimeNs, mtimeNs } = fs.statSync(from, { bigint: true });
  const seconds = (ns: bigint): number => (Number(ns / 1000n) - 1) / 1e6;
  fs.utimesSync(to, seconds(atimeNs), seconds(mtimeNs));
};

/**
 * The tree the worktree would commit right now, including unstaged and
 * untracked (non-ignored) files. Built in a throwaway index
 * (GIT_INDEX_FILE + `git add -A` + `git write-tree`), so the real index, HEAD
 * and every ref stay untouched. `dirty` is true when that tree differs from
 * HEAD's tree (or from the empty tree on an unborn branch), or when an
 * oversized untracked file exists.
 *
 * Untracked files larger than `maxUntrackedBytes` (default 5 MB: build
 * output, dumps, media) are not hashed into the object store; they enter the
 * key by path + size + mtime instead. Touching one changes the key, but an
 * edit that keeps size and mtime is not seen. Tracked files are always hashed.
 */
export function worktreeTree(
  cwd: string,
  options: { maxUntrackedBytes?: number; timeoutMs?: number } = {},
): WorktreeTree | null {
  const top = line(git(cwd, ["rev-parse", "--show-toplevel"]));
  const indexPath = line(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  if (!top || !indexPath) return null;
  const cap = options.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUTS.worktree;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workit-tree-"));
  try {
    const tempIndex = path.join(scratch, "index");
    // Seeding from the real index keeps git's stat cache, so `add -A` only
    // rehashes files that actually changed.
    if (fs.existsSync(indexPath)) seedIndex(indexPath, tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const untracked = git(top, ["ls-files", "--others", "--exclude-standard", "-z"], {
      env,
      timeoutMs,
    });
    if (!untracked.ok) return null;
    const skipped: WorktreeTree["skipped"] = [];
    for (const file of untracked.stdout.split("\0").filter(Boolean)) {
      try {
        const stat = fs.statSync(path.join(top, file));
        if (stat.isFile() && stat.size > cap)
          skipped.push({ path: file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
      } catch {
        // Vanished between listing and stat: `add -A` decides.
      }
    }
    skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const added = skipped.length
      ? git(top, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          env,
          timeoutMs,
          input: [".", ...skipped.map((file) => `:(exclude,literal)${file.path}`)].join("\0"),
        })
      : git(top, ["add", "-A"], { env, timeoutMs });
    if (!added.ok) return null;
    const tree = line(git(top, ["write-tree"], { env, timeoutMs }));
    if (!tree) return null;
    const base = line(git(top, ["rev-parse", "--verify", "-q", "HEAD^{tree}"])) ?? emptyTree(top);
    const key = skipped.length
      ? `sha256:${createHash("sha256").update(JSON.stringify({ tree, skipped })).digest("hex")}`
      : tree;
    return { tree, key, dirty: tree !== base || skipped.length > 0, skipped };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A cheap worktree freshness signal for per-turn paths: sha256 over HEAD and,
 * for every entry `git status` reports (untracked files listed one by one),
 * its path, lstat mode, size and mtime. A directory entry (a submodule or an
 * untracked nested repository) also contributes its own HEAD, so moving a
 * submodule or committing in a nested repo changes the signal. Git answers
 * from its stat cache and, with GIT_OPTIONAL_LOCKS=0, never refreshes the
 * index, and nothing is written to the object store (unlike worktreeTree).
 * Equal signals mean "probably unchanged": an edit to an already-dirty file
 * that keeps its mode, size and mtime is not seen, so gates that decide
 * (close, inspect) use worktreeTree. Null outside a repository.
 */
export function worktreeSignal(cwd: string, options: { timeoutMs?: number } = {}): string | null {
  const top = line(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (!top) return null;
  const status = git(
    top,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=dirty",
    ],
    {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUTS.worktree,
    },
  );
  if (!status.ok) return null;
  const hash = createHash("sha256");
  hash.update(`${headSha(top) ?? "unborn"}\0`);
  for (const entry of status.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const file = entry.slice(3);
    const absolute = path.join(top, file);
    let stat = "-";
    try {
      const info = fs.lstatSync(absolute, { bigint: true });
      stat = `${info.mode.toString(8)}:${info.size}:${info.mtimeNs}`;
      if (info.isDirectory()) stat += `:${headSha(absolute) ?? "-"}`;
    } catch {
      // Deleted: the status code alone records it.
    }
    hash.update(`${entry.slice(0, 2)}\0${file}\0${stat}\0`);
  }
  return `sig:${hash.digest("hex")}`;
}

/** The best common ancestor of two revisions, or null. */
export function mergeBase(cwd: string, a: string, b: string): string | null {
  if (!safeArg(a) || !safeArg(b)) return null;
  return line(git(cwd, ["merge-base", a, b]));
}

/**
 * The stable patch-id of `merge-base(base, head)..head`: equal before and
 * after a rebase that only moved the base (and while the base moves without a
 * rebase), different once the change itself differs. Null when the range is
 * empty or a revision does not resolve.
 *
 * Diff options are pinned (3 context lines, myers + indent heuristic, no
 * renames, no color, external diff or textconv, fixed prefixes) so user
 * config cannot change the id between machines. Caveat: patch-id hashes the
 * context lines, so a base change landing within 3 lines of a hunk changes
 * the id. That reads as stale, the safe direction.
 */
export function patchId(cwd: string, base: string, head: string): string | null {
  if (!safeArg(base) || !safeArg(head)) return null;
  const diff = git(cwd, [
    "diff",
    "-U3",
    "--diff-algorithm=myers",
    "--indent-heuristic",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${base}...${head}`,
    "--",
  ]);
  if (!diff.ok || !diff.stdout.trim()) return null;
  const id = git(cwd, ["patch-id", "--stable"], { input: diff.stdout });
  return line(id)?.split(/\s+/u)[0] ?? null;
}

export type RemoteTipResult =
  | { ok: true; sha: string | null }
  | { ok: false; code: "invalid_input" | "unavailable"; error: string };

/**
 * The commit a remote branch points at (`git ls-remote`). `sha: null` means
 * the remote answered and the branch does not exist; an unreachable remote,
 * an auth prompt or a timeout is `unavailable`, never a hang.
 */
export function remoteTip(
  cwd: string,
  remote: string,
  branch: string,
  options: { timeoutMs?: number } = {},
): RemoteTipResult {
  if (!safeArg(branch))
    return { ok: false, code: "invalid_input", error: "remote and branch must not start with -" };
  return remoteRefTip(cwd, remote, `refs/heads/${branch}`, options);
}

/**
 * The commit a full remote ref points at (`refs/heads/x`, `refs/tags/v1`); an
 * annotated tag resolves to the commit it peels to. Same contract as remoteTip.
 */
export function remoteRefTip(
  cwd: string,
  remote: string,
  ref: string,
  options: { timeoutMs?: number } = {},
): RemoteTipResult {
  if (!safeArg(remote) || !safeArg(ref))
    return { ok: false, code: "invalid_input", error: "remote and ref must not start with -" };
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUTS.network;
  const listed = gitNetwork(cwd, ["ls-remote", remote, ref, `${ref}^{}`], timeoutMs);
  if (!listed.ok)
    return {
      ok: false,
      code: "unavailable",
      error: listed.timedOut
        ? `git ls-remote ${redactRemote(remote)} timed out after ${timeoutMs} ms`
        : `git ls-remote ${redactRemote(remote)} failed (unreachable or not authorized)`,
    };
  let direct: string | null = null;
  for (const row of listed.stdout.split(/\r?\n/u)) {
    const [sha, name] = row.split(/\s+/u);
    if (!sha) continue;
    if (name === `${ref}^{}`) return { ok: true, sha };
    if (name === ref) direct = sha;
  }
  return { ok: true, sha: direct };
}

export type FetchResult =
  | { ok: true }
  | { ok: false; code: "invalid_input" | "unavailable" | "busy"; error: string };

/**
 * `git fetch --no-tags --no-recurse-submodules --no-write-fetch-head
 * <remote> <refspec…>` under the watchdog (no prompts, bounded). Pass bare
 * object ids (no `:dst`) for a pure read: the objects arrive, no ref moves.
 * Contention on a repository lock is `busy`.
 */
export function fetchRefs(
  cwd: string,
  remote: string,
  refspecs: readonly string[],
  options: { timeoutMs?: number } = {},
): FetchResult {
  if (
    !safeArg(remote) ||
    refspecs.length === 0 ||
    !refspecs.every((spec) => safeArg(spec.replace(/^\+/u, "")))
  )
    return { ok: false, code: "invalid_input", error: "remote and refspecs must not start with -" };
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUTS.network;
  const fetched = gitNetwork(
    cwd,
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--quiet",
      remote,
      ...refspecs,
    ],
    timeoutMs,
  );
  if (fetched.ok) return { ok: true };
  if (/\.lock'?:? File exists|unable to lock|another git process/iu.test(fetched.stderr))
    return {
      ok: false,
      code: "busy",
      error: `git fetch ${redactRemote(remote)}: the repository is locked by another git process`,
    };
  return {
    ok: false,
    code: "unavailable",
    error: fetched.timedOut
      ? `git fetch ${redactRemote(remote)} timed out after ${timeoutMs} ms`
      : `git fetch ${redactRemote(remote)} failed (unreachable, not authorized, or ref missing)`,
  };
}

/** The configured remote names. */
export function remoteNames(cwd: string): string[] {
  return (git(cwd, ["remote"]).stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The absolute git common dir (shared by every worktree), or null outside a repository. */
export function gitCommonDir(cwd: string): string | null {
  return line(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

/** True when `rev` names a commit present in the local object store. */
export function hasCommit(cwd: string, rev: string): boolean {
  if (!safeArg(rev)) return false;
  return git(cwd, ["cat-file", "-e", `${rev}^{commit}`]).ok;
}

/** The commit a local ref (e.g. refs/remotes/origin/main) points at, or null. */
export function resolveRef(cwd: string, ref: string): string | null {
  if (!safeArg(ref)) return null;
  return line(git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]));
}

/**
 * Commits `head` lacks from `base` (behind) and has on top of it (ahead), and
 * whether `base` is already an ancestor of `head`. Null when either side
 * does not resolve locally.
 */
export function aheadBehind(
  cwd: string,
  base: string,
  head: string,
): { ahead: number; behind: number; upToDate: boolean } | null {
  if (!safeArg(base) || !safeArg(head)) return null;
  const counted = line(git(cwd, ["rev-list", "--left-right", "--count", `${base}...${head}`]));
  const match = counted ? /^(\d+)\s+(\d+)$/u.exec(counted) : null;
  if (!match) return null;
  const upToDate = git(cwd, ["merge-base", "--is-ancestor", base, head]).ok;
  return { behind: Number(match[1]), ahead: Number(match[2]), upToDate };
}

const config = (cwd: string, key: string): string | null =>
  line(git(cwd, ["config", "--get", key]));

/** The current branch name (also on an unborn branch), or null when detached. */
export function currentBranch(cwd: string): string | null {
  return line(git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
}

/**
 * The remote `git push` would use for `branch` (default: the current branch),
 * in git's own precedence: branch.<b>.pushRemote, remote.pushDefault,
 * branch.<b>.remote, then `origin`, then the only remote. Null when none.
 */
export function pushRemoteName(cwd: string, branch?: string | null): string | null {
  const name = branch ?? currentBranch(cwd);
  const remotes = remoteNames(cwd);
  const candidates = [
    name ? config(cwd, `branch.${name}.pushRemote`) : null,
    config(cwd, "remote.pushDefault"),
    name ? config(cwd, `branch.${name}.remote`) : null,
  ];
  for (const candidate of candidates)
    if (candidate && candidate !== "." && remotes.includes(candidate)) return candidate;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/**
 * The single push URL of `remote` after git's insteadOf/pushInsteadOf
 * rewrites. Null when the remote is missing or pushes to several URLs (the
 * target would be ambiguous).
 */
export function pushUrl(cwd: string, remote: string): string | null {
  if (!safeArg(remote)) return null;
  const urls = git(cwd, ["remote", "get-url", "--push", "--all", remote])
    .stdout.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return urls.length === 1 ? urls[0] : null;
}

export type RemoteUrl = {
  protocol: "ssh" | "https" | "http" | "git" | "file";
  user: string | null;
  /** Host as written in the URL (an SSH alias stays unresolved, case kept). */
  host: string;
  port: string | null;
  /** Repository path without leading slash, trailing slash or `.git`. */
  path: string;
};

const cleanPath = (value: string): string =>
  value
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");

/** Parse a git remote URL (scp-like `user@host:path` or URL syntax). */
export function parseRemoteUrl(raw: string): RemoteUrl | null {
  const value = raw.trim();
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*::/u.test(value)) return null;
  // Local paths, including Windows drive paths that look scp-like (C:\repo).
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith(".")) {
    return { protocol: "file", user: null, host: "", port: null, path: value };
  }
  if (!value.includes("://")) {
    // `user:secret@host:path` is not scp syntax (see redactRemote).
    if (/^[^/@]*:[^/]*@/u.test(value)) return null;
    const scp = /^(?:([^@\s/:]+)@)?([^:/\s]+):(.+)$/u.exec(value);
    if (!scp) return null;
    return {
      protocol: "ssh",
      user: scp[1] ?? null,
      // As written: ssh matches Host patterns case-insensitively and expands
      // %h with the original spelling.
      host: scp[2],
      port: null,
      path: cleanPath(scp[3]),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/u, "");
  const protocol =
    scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git"
      ? "ssh"
      : scheme === "https" || scheme === "http" || scheme === "git" || scheme === "file"
        ? scheme
        : null;
  if (!protocol) return null;
  return {
    protocol,
    // Never keep an HTTPS credential; an SSH user is part of the identity.
    user: protocol === "ssh" && url.username ? decodeURIComponent(url.username) : null,
    host: url.hostname.replace(/\.$/u, ""),
    port: url.port || null,
    path: cleanPath(decodeURIComponent(url.pathname)),
  };
}

// ---------------------------------------------------------------------------
// ~/.ssh/config Host alias resolution: enough of ssh_config(5) for HostName
// and Port, with OpenSSH's semantics.
// - The first value obtained for each option wins.
// - Host patterns support `*`, `?` and `!negation`. They match the alias
//   case-insensitively, and %h expands to the alias as written.
// - Include is read where it appears. Its directives apply only when the
//   enclosing block matches (or at top level). Inside an inactive block,
//   Host lines in the included file never match. After the Include, the
//   enclosing block's state is restored, so its later directives still apply.
// - `Match` blocks are treated as non-matching: they depend on runtime state
//   that a static read cannot evaluate.

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("")
      .map((char) =>
        char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/gu, "\\$&"),
      )
      .join("")}$`,
    "iu",
  );

const hostMatches = (patterns: string[], host: string): boolean => {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(host)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
};

const tokens = (rest: string): string[] =>
  [...rest.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]);

type SshDirective = { key: string; args: string[] };

const directives = (text: string): SshDirective[] =>
  text.split(/\r?\n/u).flatMap((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/u.exec(trimmed);
    if (!match) return [];
    return [{ key: match[1].toLowerCase(), args: tokens(match[2]) }];
  });

/** An ssh_config text plus the home its relative `Include`s resolve against (~/.ssh). */
export type SshConfig = { text: string; home: string };

/** The user's ~/.ssh/config (empty when missing); Includes resolve lazily. */
export function readSshConfig(home: string = os.homedir()): SshConfig {
  try {
    return { text: fs.readFileSync(path.join(home, ".ssh", "config"), "utf8"), home };
  } catch {
    return { text: "", home };
  }
}

const includeFiles = (spec: string, home: string): string[] => {
  const expanded = spec.startsWith("~") ? path.join(home, spec.slice(1)) : spec;
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(home, ".ssh", expanded);
  const dir = path.dirname(absolute);
  const base = path.basename(absolute);
  if (!/[*?]/u.test(base)) return [absolute];
  try {
    const pattern = globToRegExp(base);
    return fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .toSorted()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

/**
 * Resolve an SSH host alias: the effective HostName (with %h / %% expanded)
 * and Port. An alias with no HostName resolves to itself. A plain string is
 * a config text whose relative Includes resolve against the real home.
 */
export function resolveSshHost(
  alias: string,
  sshConfig: string | SshConfig,
): { hostname: string; port: string | null } {
  const source =
    typeof sshConfig === "string" ? { text: sshConfig, home: os.homedir() } : sshConfig;
  let hostname: string | null = null;
  let port: string | null = null;
  const evaluate = (text: string, initiallyActive: boolean, neverMatch: boolean, depth: number) => {
    let active = initiallyActive;
    for (const { key, args } of directives(text)) {
      if (key === "host") {
        active = !neverMatch && hostMatches(args, alias);
        continue;
      }
      if (key === "match") {
        active = false;
        continue;
      }
      if (key === "include") {
        if (depth >= 16) continue;
        for (const spec of args)
          for (const file of includeFiles(spec, source.home)) {
            let included: string;
            try {
              included = fs.readFileSync(file, "utf8");
            } catch {
              continue;
            }
            // OpenSSH: an Include inside an inactive block can never match,
            // and the enclosing block's state is restored afterwards.
            evaluate(included, active, neverMatch || !active, depth + 1);
          }
        continue;
      }
      if (!active || args.length === 0) continue;
      if (key === "hostname" && hostname === null)
        hostname = args[0].replace(/%(%|h)/gu, (_, token: string) => (token === "h" ? alias : "%"));
      if (key === "port" && port === null) port = args[0];
    }
  };
  evaluate(source.text, true, false, 0);
  return { hostname: (hostname ?? alias).replace(/\.$/u, ""), port };
}

// ---------------------------------------------------------------------------
// Forge derivation (D16): the push remote host decides github vs gitlab.

export type ForgeKind = "github" | "gitlab";

/** Self-hosted / enterprise hosts known from vcs config (`github.host`, `gitlab.host`). */
export type ForgeHosts = { github?: readonly string[]; gitlab?: readonly string[] };

export type DerivedForge = {
  kind: ForgeKind;
  /** Host as written in the remote URL (may be an SSH alias). */
  host: string;
  /** Host after SSH alias resolution. */
  hostname: string;
  /** Host the gh/glab API calls must target (GH_HOST / GITLAB_HOST). */
  apiHost: string;
  /** owner/name (GitHub) or group[/subgroup]/project (GitLab). */
  repo: string;
  /** How the kind was decided. */
  via: "known_host" | "configured_host" | "host_name";
};

// Public forges and their SSH-over-443 endpoints.
const KNOWN_HOSTS: Record<string, { kind: ForgeKind; apiHost: string }> = {
  "github.com": { kind: "github", apiHost: "github.com" },
  "ssh.github.com": { kind: "github", apiHost: "github.com" },
  "gitlab.com": { kind: "gitlab", apiHost: "gitlab.com" },
  "altssh.gitlab.com": { kind: "gitlab", apiHost: "gitlab.com" },
};

const normalizeHost = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/\/.*$/u, "")
    .replace(/\.$/u, "");

/**
 * Derive the forge from a remote URL. SSH aliases resolve through `sshConfig`
 * (default: the user's ~/.ssh/config), so `git@github-work.com:org/repo` with
 * `Host github-work.com / HostName github.com` is GitHub at github.com.
 * Configured enterprise hosts win next; finally a host whose first label is
 * exactly `github` or `gitlab` (gitlab.example.com) is taken at face value.
 * Null when the host is unknown or the path has no owner/name.
 */
export function deriveForge(
  url: string,
  options: { hosts?: ForgeHosts; sshConfig?: string | SshConfig } = {},
): DerivedForge | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed || parsed.protocol === "file" || !parsed.host) return null;
  const segments = parsed.path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const hostname = (
    parsed.protocol === "ssh"
      ? resolveSshHost(parsed.host, options.sshConfig ?? readSshConfig()).hostname
      : parsed.host
  ).toLowerCase();
  const withPort =
    parsed.protocol !== "ssh" && parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const base = { host: parsed.host, hostname, repo: segments.join("/") };
  const known = KNOWN_HOSTS[hostname];
  if (known) {
    if (known.kind === "github" && segments.length !== 2) return null;
    return { ...base, kind: known.kind, apiHost: known.apiHost, via: "known_host" };
  }
  for (const kind of ["github", "gitlab"] as const) {
    const hosts = new Set((options.hosts?.[kind] ?? []).map(normalizeHost));
    if (hosts.has(withPort) || hosts.has(hostname)) {
      const apiHost = hosts.has(withPort) ? withPort : hostname;
      return { ...base, kind, apiHost, via: "configured_host" };
    }
  }
  const label = hostname.split(".")[0];
  if ((label === "github" || label === "gitlab") && hostname.includes("."))
    return { ...base, kind: label, apiHost: withPort, via: "host_name" };
  return null;
}

export type PushForgeResult =
  | { ok: true; remote: string; /** Redacted push URL. */ url: string; forge: DerivedForge }
  | { ok: false; code: "not_found" | "unavailable"; error: string; unblock: string };

/**
 * The forge behind the current branch's push remote. Fails closed with an
 * unblock hint when there is no push remote, the push URL is ambiguous, or
 * the host is not a recognizable GitHub/GitLab.
 */
export function pushForge(
  cwd: string,
  options: { branch?: string | null; hosts?: ForgeHosts; sshConfig?: string | SshConfig } = {},
): PushForgeResult {
  const remote = pushRemoteName(cwd, options.branch);
  if (!remote)
    return {
      ok: false,
      code: "not_found",
      error: "no push remote is configured for this branch",
      unblock: "git remote add origin <url>",
    };
  const url = pushUrl(cwd, remote);
  if (!url)
    return {
      ok: false,
      code: "unavailable",
      error: `remote "${remote}" has no single push URL`,
      unblock: `git remote get-url --push --all ${remote}  # keep exactly one push URL`,
    };
  const forge = deriveForge(url, options);
  if (!forge) {
    // Never echo the raw URL: it may carry a token (https://user:tok@…).
    const parsed = parseRemoteUrl(url);
    const host = parsed?.host || null;
    return {
      ok: false,
      code: "unavailable",
      error: host
        ? parsed?.protocol === "ssh"
          ? `unsupported_forge: could not resolve ssh alias "${host}" to GitHub or GitLab; PR and CI verbs need one (workit git push still pushes with git)`
          : `unsupported_forge: cannot tell whether push host "${host}" is GitHub or GitLab; PR and CI verbs need one (workit git push still pushes with git)`
        : `push URL ${redactRemote(url)} of remote "${remote}" is not a GitHub/GitLab URL`,
      unblock: host
        ? `if ${host} is an ssh alias of GitHub/GitLab, add "Host ${host}" with "HostName github.com" (or gitlab.com) to ~/.ssh/config; if it is a self-hosted GitHub/GitLab, set github.host or gitlab.host in ~/.config/workit/vcs.json; other forges (Bitbucket, Gitea…) have no PR/CI verbs`
        : `git remote set-url --push ${remote} <ssh-or-https-url>`,
    };
  }
  return { ok: true, remote, url: redactRemote(url), forge };
}

/**
 * D16: the push remote decides. A configured provider that disagrees is not
 * silently overridden; it is `blocked` with the exact fix.
 */
export function forgeConflict(
  derived: DerivedForge,
  configuredProvider: string | null | undefined,
): { code: "blocked"; error: string; unblock: string } | null {
  const configured = configuredProvider?.trim().toLowerCase();
  if (!configured || configured === derived.kind) return null;
  return {
    code: "blocked",
    error: `forge_mismatch: push remote ${derived.host} is ${derived.kind} but the workspace vcs.provider is ${configured}, so its account and grants do not apply; PR and CI verbs stop here (workit git push still pushes with git)`,
    unblock: `add a workspace whose glob matches only this repo, with "vcs": {"provider": "${derived.kind}"} (and its account), to ~/.config/workit/workspaces.json; the most specific glob wins`,
  };
}
