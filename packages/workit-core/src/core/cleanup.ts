// Nothing a finished change made stays on disk (#653). After a merge, the
// branch's clean worktree (made by `workit fanout worktree create`, or under
// the managed root) and its local branch go, and the ledger says what went.
// `workit gc --worktrees` sweeps what earlier changes left: merged or
// squash-merged clean worktrees in Workit's places (the managed root
// `<state>/worktrees`, the pre-move root `~/.cache/workit-wt`, legacy
// `<repo>-wt`/`workit-wt` dirs beside a project, the temp dir), stale
// registrations, and local branches whose remote is gone once merged.
// Ignored files under a regenerable dir (the built-in list, plus the repo's
// `cleanup.regenerable` globs in .workit/checks.json) do not keep a worktree.
// Never forced: a dirty, locked or unmerged worktree, the main checkout and
// the checkout the command runs in are kept and named.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCheckConfig } from "../check-config";
import { defaultTrunk, gitRun, nulList, trunkRef } from "../fanout";
import {
  SCRATCH_DIR,
  listWorktrees,
  removeWorkerScratch,
  workerScratchesOf,
  type WorktreeEntry,
} from "../fanout-worktree";
import type { Forge } from "../forge/types";
import { GIT_TIMEOUTS, pushRemoteName } from "../git/rev";
import { FANOUT_TOKEN_FILE } from "../hooks/worktree-confine";
import {
  appendObserved,
  parseKeepTarget,
  readLedger,
  type KeepTarget,
  type LedgerActor,
} from "../ledger";
import { gitFlowOf, isProtectedTarget, resolveBranchPolicyFor } from "./branch";
import { LIVE_SESSION_TTL_MS, checkoutKey, liveProbe } from "./live-session";
import { workspaceReleaseTracks, trackBranches } from "./release-tracks";
import { heldWithin, stopProcesses } from "./procs";
import { leaseDir, parseLease, staleReason } from "./resources";
import { isWorkitMarkerPath } from "./task-store";
import { legacyWorktreesDir, stateDir, worktreesDir } from "./workit-paths.mjs";
import { matchWorkspace, workspaceCleanup } from "./workspaces";

const SLOW = GIT_TIMEOUTS.worktree;
/** Dirty paths named in output and ledger rows. */
const DIRTY_SHOWN = 5;
/** Run once a dirty worktree is dealt with; gc removes it when it is merged and clean. */
export const RELEASE_COMMAND = "workit gc --worktrees --apply";

/** Where Workit makes worktrees: `<state>/worktrees/<repo>/<slice>`, never beside the project. */
export function managedWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return worktreesDir(env);
}

/**
 * Every root whose worktrees are Workit's: the managed root, and the pre-move
 * `~/.cache/workit-wt` (its worktrees are never moved; they go once merged).
 */
export function managedWorktreeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [worktreesDir(env), legacyWorktreesDir(env)];
}

/**
 * One comparable form for a path from git (`C:/Users/runneradmin/...`) and one
 * Workit computes (`C:\Users\RUNNER~1\...`): the real path (long names,
 * symlinks resolved; resolved as written when missing), `/` separators, and
 * case folded where the filesystem ignores case (as fanout's samePath does).
 */
const canonical = (target: string): string => {
  let real: string;
  try {
    real = fs.realpathSync.native(target);
  } catch {
    real = path.resolve(target);
  }
  const slashed = real.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? slashed.toLowerCase()
    : slashed;
};

/** `child` is `parent` or under it, both read through `canonical`. */
const inside = (child: string, parent: string): boolean => {
  const from = canonical(parent);
  const to = canonical(child);
  return to === from || to.startsWith(from.endsWith("/") ? from : `${from}/`);
};

/** managed: under a managed root (current or pre-move); legacy: `<parent>/<repo>-wt/<x>`; scratch: the temp dir. */
export type WorktreePlace = "managed" | "legacy" | "scratch" | "other";

export function placeOf(worktree: string, env: NodeJS.ProcessEnv = process.env): WorktreePlace {
  if (managedWorktreeRoots(env).some((root) => inside(worktree, root))) return "managed";
  if (path.basename(path.dirname(canonical(worktree))).endsWith("-wt")) return "legacy";
  if ([os.tmpdir(), "/tmp"].some((dir) => fs.existsSync(dir) && inside(worktree, dir)))
    return "scratch";
  return "other";
}

/**
 * A host's own isolated worktree (Claude Code's `.claude/worktrees/agent-*`):
 * the host owns the directory, so Workit never removes it; its branch goes
 * once merged and checked out nowhere (`gc --branches`).
 */
const hostOwned = (worktree: string): boolean =>
  /\/\.claude\/worktrees\/[^/]+$/u.test(canonical(worktree));

const HOST_OWNED = "a host-owned worktree (.claude/worktrees); the host removes it";

/** What each git-dir entry says is under way; removing the worktree would lose its state. */
const OPERATIONS: readonly [string, string][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["BISECT_LOG", "bisect"],
  ["BISECT_START", "bisect"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/** "a <op> is in progress" when the worktree's own git dir holds a rebase, bisect, merge, cherry-pick or revert; else null. */
const operationInProgress = (worktree: string): string | null => {
  const dir = gitRun(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return null;
  const gitDir = dir.stdout.trim();
  const found = OPERATIONS.find(([entry]) => fs.existsSync(path.join(gitDir, entry)));
  return found ? `a ${found[1]} is in progress` : null;
};

/**
 * An operation under way anywhere in the repository, read from the admin
 * dirs (the common git dir and each `<common>/worktrees/<id>/`), never
 * through a worktree's path: a locked worktree whose directory is away, or a
 * prunable one, still has its rebase state there. `unreadable` when an admin
 * dir cannot be listed (the caller keeps the branch: fail closed).
 */
export function operationsUnderway(
  cwd: string,
): { where: string; busy: string } | { unreadable: string } | null {
  const common = gitRun(cwd, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return { unreadable: `git rev-parse --git-common-dir failed in ${cwd}` };
  const root = path.resolve(cwd, common.stdout.trim());
  const admins = [root];
  try {
    const nested = path.join(root, "worktrees");
    if (fs.existsSync(nested))
      for (const name of fs.readdirSync(nested)) admins.push(path.join(nested, name));
  } catch {
    return { unreadable: `${path.join(root, "worktrees")} cannot be read` };
  }
  for (const admin of admins) {
    let names: Set<string>;
    try {
      names = new Set(fs.readdirSync(admin));
    } catch {
      return { unreadable: `${admin} cannot be read` };
    }
    const found = OPERATIONS.find(([entry]) => names.has(entry));
    if (!found) continue;
    let where = admin;
    try {
      // A linked worktree's admin dir names its `.git` file in `gitdir`.
      if (admin !== root)
        where = path.dirname(fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim());
    } catch {
      // keep the admin dir as the place
    }
    return { where, busy: `a ${found[1]} is in progress` };
  }
  return null;
}

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

/** Uncommitted paths with their status code (the scratch dir left out); null when git cannot say. */
function statusEntries(worktree: string): { code: string; file: string }[] | null {
  const status = gitRun(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!status.ok) return null;
  const out: { code: string; file: string }[] = [];
  const fields = nulList(status.stdout);
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index];
    // A rename's source follows as its own field.
    if (line[0] === "R" || line[0] === "C") index++;
    const file = line.slice(3);
    if (!file.startsWith(`${SCRATCH_DIR}/`)) out.push({ code: line.slice(0, 2), file });
  }
  return out;
}

/** Uncommitted paths (the scratch dir left out); null when git cannot say. */
export function dirtyPaths(worktree: string): string[] | null {
  return statusEntries(worktree)?.map((entry) => entry.file) ?? null;
}

/**
 * Ignored paths under these directories are rebuilt by a tool; removing them
 * loses nothing. Only ignored paths are matched, so a tracked `bin/` of
 * scripts never is.
 */
const REGENERABLE = new Set([
  "node_modules",
  SCRATCH_DIR,
  "dist",
  "build",
  "bin",
  "target",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
]);

/**
 * The repo's `cleanup.regenerable` globs (.workit/checks.json, read from
 * `cwd`); none when the config is missing or invalid, so nothing extra goes.
 */
export function repoRegenerable(cwd: string): string[] {
  const config = loadCheckConfig(cwd);
  return config.error ? [] : (config.regenerable ?? []);
}

/**
 * `file` (repo-relative, `/`-separated) is under a regenerable dir: one of its
 * segments is in the built-in list, or it or a parent dir matches a repo glob.
 * Anything nested under such a dir counts, a `.env` included.
 */
const regenerablePath = (file: string, globs: readonly string[]): boolean => {
  const segments = file.replace(/\/+$/u, "").split("/");
  if (segments.some((segment) => REGENERABLE.has(segment))) return true;
  return segments.some((_, index) => {
    const prefix = segments.slice(0, index + 1).join("/");
    return globs.some((glob) => matchWorkspace(glob, prefix));
  });
};

/**
 * Ignored paths that are not regenerable (a `.env`, a local config): `git
 * status` omits them and `git worktree remove` deletes them, so they keep the
 * worktree. `regenerable` adds repo globs to the built-in list. Null when git
 * cannot say.
 */
export function ignoredKeepers(
  worktree: string,
  regenerable: readonly string[] = [],
): string[] | null {
  const listed = gitRun(worktree, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (!listed.ok) return null;
  return nulList(listed.stdout).filter(
    (file) => !regenerablePath(file, regenerable) && !isWorkitMarkerPath(worktree, file),
  );
}

const IGNORED_REASON = "ignored files that are not regenerable";

const listed = (paths: readonly string[]): string =>
  `${paths.slice(0, DIRTY_SHOWN).join(", ")}${paths.length > DIRTY_SHOWN ? `, … (${paths.length} in all)` : ""}`;

type Held = { paths: string[]; reason: string };

/**
 * Why the worktree must stay (uncommitted or valuable ignored files), or the
 * untracked old-runtime `.workit/` markers to delete before it goes (`git
 * worktree remove` refuses untracked files; ignored ones go with it).
 */
function keepReason(
  worktree: string,
  regenerable: readonly string[],
): { held: Held } | { held: null; markers: string[] } {
  const entries = statusEntries(worktree);
  if (entries === null) return { held: { paths: ["unreadable"], reason: "unreadable state" } };
  const markers = entries
    .filter((entry) => entry.code === "??" && isWorkitMarkerPath(worktree, entry.file))
    .map((entry) => entry.file);
  const dirty = entries.map((entry) => entry.file).filter((file) => !markers.includes(file));
  if (dirty.length > 0)
    return {
      held: {
        paths: dirty,
        reason: `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} (${listed(dirty)})`,
      },
    };
  const ignored = ignoredKeepers(worktree, regenerable);
  if (ignored === null) return { held: { paths: ["unreadable"], reason: "unreadable state" } };
  if (ignored.length > 0)
    return { held: { paths: ignored, reason: `${IGNORED_REASON} (${listed(ignored)})` } };
  return { held: null, markers };
}

/** Delete the untracked marker files keepReason found, each checked again; false when one changed. */
const dropMarkers = (worktree: string, markers: readonly string[]): boolean => {
  for (const file of markers) {
    if (!isWorkitMarkerPath(worktree, file)) return false;
    try {
      fs.rmSync(path.join(worktree, file));
    } catch {
      return false;
    }
  }
  return true;
};

/** A process start time as recorded; a reader that cannot tell gives null. */
const startOf = (pid: number): string | null => {
  try {
    return liveProbe.start(pid);
  } catch {
    return null;
  }
};

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Why `worktree` is in use right now, or null: a live heavy-lease holder's
 * cwd is inside it, or another session's live-session marker names it. A
 * marker whose recorded pid is still that process (same start time) is live
 * at any heartbeat age; one whose process cannot be read (another machine,
 * no pid) counts while its heartbeat is fresh.
 */
export function liveHold(
  worktree: string,
  options: { env?: NodeJS.ProcessEnv; session?: string | null; now?: number } = {},
): string | null {
  const env = options.env ?? process.env;
  const dir = leaseDir(env);
  let slots: string[] = [];
  try {
    slots = fs.readdirSync(dir).filter((name) => /^slot-\d+\.json$/u.test(name));
  } catch {
    // no lease dir: no holder
  }
  for (const name of slots) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const lease = parseLease(text);
    if (lease?.cwd && inside(lease.cwd, worktree) && !staleReason(lease))
      return `a heavy lease holder runs in it (${lease.check}, pid ${lease.pid})`;
  }
  const file = path.join(
    stateDir(env),
    "live-sessions",
    `${createHash("sha256").update(checkoutKey(worktree)).digest("hex").slice(0, 32)}.json`,
  );
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const session = typeof marker.session === "string" ? marker.session : null;
  if (!session || session === options.session) return null;
  const pid = typeof marker.pid === "number" ? marker.pid : null;
  const pidStart = typeof marker.pidStart === "string" ? marker.pidStart : null;
  const here = marker.machine === os.hostname();
  const live =
    here && pid !== null
      ? running(pid) && (pidStart === null || [null, pidStart].includes(startOf(pid)))
      : (options.now ?? Date.now()) - Date.parse(String(marker.heartbeatAt)) <= LIVE_SESSION_TTL_MS;
  return live ? `another live session works in it (${session}${pid ? `, pid ${pid}` : ""})` : null;
}

/** Bytes under a directory, symlinks not followed. */
export function directoryBytes(dir: string): number {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else
        try {
          total += fs.lstatSync(file).size;
        } catch {
          // gone meanwhile
        }
    }
  }
  return total;
}

const patchId = (cwd: string, diff: string): string[] => {
  const run = spawnSync("git", ["patch-id", "--stable"], {
    cwd,
    input: diff,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUTS.local,
    windowsHide: true,
  });
  return run.status === 0
    ? run.stdout
        .split("\n")
        .map((line) => line.split(" ")[0] ?? "")
        .filter(Boolean)
    : [];
};

export type MergeProof = "merged" | "squash-merged";

/**
 * Whether `tip` landed on `target`: an ancestor (merged), or its whole change
 * since the merge base is one commit's patch on `target` (squash-merged).
 * `trunkPatches` caches the target's patch ids per merge base.
 */
export function mergeProof(
  cwd: string,
  tip: string,
  target: string,
  trunkPatches: Map<string, Set<string>> = new Map(),
): MergeProof | null {
  if (gitRun(cwd, ["merge-base", "--is-ancestor", tip, target]).ok) return "merged";
  const base = gitRun(cwd, ["merge-base", target, tip]);
  if (!base.ok) return null;
  const from = base.stdout.trim();
  const diff = gitRun(cwd, ["diff", "--no-ext-diff", "--binary", from, tip]);
  if (!diff.ok || !diff.stdout) return null;
  const own = patchId(cwd, diff.stdout)[0];
  if (!own) return null;
  let landed = trunkPatches.get(from);
  if (!landed) {
    const log = gitRun(cwd, ["log", "--no-ext-diff", "--binary", "-p", `${from}..${target}`]);
    landed = new Set(log.ok ? patchId(cwd, log.stdout) : []);
    trunkPatches.set(from, landed);
  }
  return landed.has(own) ? "squash-merged" : null;
}

/** Remove `dir` when it is empty; true when it went. */
const removeIfEmpty = (dir: string): boolean => {
  try {
    if (fs.readdirSync(dir).length) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
};

/**
 * The managed `<repo>` dir or the legacy `-wt` dir that held a removed
 * worktree, once empty; then the pre-move root too, once nothing is left in it.
 */
const tidyParent = (
  worktree: string,
  place: WorktreePlace,
  env: NodeJS.ProcessEnv,
): string | null => {
  if (place !== "managed" && place !== "legacy") return null;
  const parent = path.dirname(worktree);
  if (!removeIfEmpty(parent)) return null;
  const old = legacyWorktreesDir(env);
  if (place === "managed" && canonical(path.dirname(parent)) === canonical(old)) removeIfEmpty(old);
  return parent;
};

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The remote no longer has `branch` (`git ls-remote` found no such head); false when it cannot tell. */
export function remoteBranchGone(cwd: string, branch: string): boolean {
  if (!branch || branch.startsWith("-")) return false;
  const remote = pushRemoteName(cwd, branch) ?? "origin";
  const found = gitRun(
    cwd,
    ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`],
    GIT_TIMEOUTS.network,
  );
  // --exit-code: 2 = no matching ref; anything else (network, auth) is unknown.
  return found.status === 2;
}

export type MergeCleanup = {
  /** The local branch was deleted. */
  branchDeleted: boolean;
  /** The clean Workit worktree that was on the branch, removed. */
  worktreeRemoved: string | null;
  /** Its out-of-tree worker scratch dirs, removed with it. */
  scratchRemoved: string[];
  /** A worktree or checkout kept for uncommitted changes, with the paths. */
  dirty: { path: string; paths: string[] } | null;
  /** The registered processes stopped before their worktree went or their checkout switched. */
  procsStopped: Array<{ id: string; cmd: string }>;
  /** The checkout this ran in, moved off the merged branch: onto the trunk, or detached at the remote trunk. */
  switched: { path: string; to: string; head: string } | null;
  /** Why anything was kept: one line each. */
  notes: string[];
  /** The ledger row that lists what was removed, when anything was. */
  recorded: { id: string } | { error: string } | null;
};

export type CleanupOptions = {
  actor: LedgerActor;
  /** What ran the cleanup: `pr merge`, `verify-delivery merge`. */
  trigger: string;
  env?: NodeJS.ProcessEnv;
  /** Why the branch must stay because an open PR/MR uses it, or null; the forge is asked only when given. */
  openPr?: (branch: string) => string | null;
};

/** The user's keep for one branch, worktree or process: the decision that recorded it. */
export type KeepDecision = KeepTarget & { decision: string };

/** Every keep the user recorded (`workit ledger decision … --keep`), superseded ones left out. */
export function keepDecisions(cwd: string): KeepDecision[] {
  const ledger = readLedger(cwd);
  if (!ledger.ok) return [];
  return ledger.value.rows.flatMap((row) =>
    row.type !== "decision" || row.superseded || !Array.isArray(row.keep)
      ? []
      : row.keep.flatMap((value) => {
          const parsed = parseKeepTarget(String(value), cwd);
          return parsed ? [{ ...parsed, decision: row.id }] : [];
        }),
  );
}

const keptBy = (
  keeps: readonly KeepDecision[],
  kind: KeepTarget["kind"],
  match: (target: string) => boolean,
): KeepDecision | undefined => keeps.findLast((keep) => keep.kind === kind && match(keep.target));

const procLine = (proc: { id: string; cmd: string; reason: string }): string =>
  `process ${proc.id} (${proc.cmd}) ${proc.reason}`;

/**
 * Stop the registered processes in `dir` (rows under `except` left out)
 * before it goes or switches branch; null when all stopped, else why the
 * place is kept. A row this caller may not stop (kept, another owner, a
 * terminal start, workspace keep) keeps it and nothing is stopped (ruling 1).
 */
async function stopWithin(
  dir: string,
  except: readonly string[],
  options: CleanupOptions,
  env: NodeJS.ProcessEnv,
  out: MergeCleanup,
): Promise<string | null> {
  const caller = options.actor.session ?? null;
  const held = heldWithin(dir, { env, caller, except });
  if (held.length) return held.map(procLine).join("; ");
  const report = await stopProcesses({ within: dir, except }, `delivered (${options.trigger})`, {
    env,
    actor: options.actor,
    caller,
  });
  out.procsStopped.push(...report.stopped.map((proc) => ({ id: proc.id, cmd: proc.cmd })));
  const left = [...report.skipped, ...report.failed];
  return left.length ? left.map(procLine).join("; ") : null;
}

/**
 * Why `branch` is no longer at `head` (a commit landed while processes
 * stopped or the trunk was fetched), or null: the worktree's HEAD and the
 * branch ref must both still be `head`.
 */
const movedFrom = (cwd: string, worktree: string, branch: string, head: string): string | null => {
  const at = gitRun(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const ref = gitRun(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const now = [at.ok ? at.stdout.trim() : "(unreadable)", ref.ok ? ref.stdout.trim() : "(gone)"];
  const moved = now.find((sha) => sha !== head);
  return moved === undefined
    ? null
    : `${branch} moved during cleanup (${head.slice(0, 12)} -> ${moved.slice(0, 12)})`;
};

/** Tracked or untracked, non-ignored changes in a checkout; null when git cannot say. */
const checkoutChanges = (checkout: string): string[] | null => {
  const status = gitRun(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return status.ok ? nulList(status.stdout).filter((entry) => /^.. /u.test(entry)) : null;
};

/**
 * Move the checkout this command runs in off the merged `branch` (ruling 2):
 * clean, nothing under way, no other live session or lease holder, the
 * change on the remote trunk by patch id, the local trunk behind the remote
 * one. Then its processes stop, it switches to the trunk and fast-forwards
 * (or, with the trunk checked out elsewhere, detaches at the remote trunk).
 * Never a reset, a forced checkout or a stash; the directory always stays.
 * Returns why it was kept, or null once it moved.
 */
async function leaveMergedBranch(
  cwd: string,
  entry: WorktreeEntry,
  worktrees: readonly WorktreeEntry[],
  branch: string,
  tip: string,
  options: CleanupOptions,
  env: NodeJS.ProcessEnv,
  out: MergeCleanup,
): Promise<string | null> {
  const checkout = entry.path;
  const busy = operationInProgress(checkout);
  if (busy) return busy;
  const changes = checkoutChanges(checkout);
  if (changes === null) return "git status failed";
  if (changes.length) {
    const paths = changes.map((line) => line.slice(3));
    out.dirty = { path: checkout, paths: paths.slice(0, DIRTY_SHOWN) };
    return `it has ${paths.length} uncommitted change${paths.length === 1 ? "" : "s"} (${listed(paths)}); commit, move or discard them, then switch to the trunk yourself`;
  }
  const live = liveHold(checkout, { env, session: options.actor.session });
  if (live) return live;
  const trunk = defaultTrunk(cwd);
  if (trunk === branch) return `${branch} is the trunk`;
  const remote = pushRemoteName(cwd, trunk) ?? "origin";
  const remoteRef = `refs/remotes/${remote}/${trunk}`;
  const fetched = gitRun(
    cwd,
    ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${trunk}:${remoteRef}`],
    GIT_TIMEOUTS.network,
  );
  if (!fetched.ok) return `could not fetch ${remote}/${trunk} (${firstLine(fetched.stderr)})`;
  if (!mergeProof(cwd, tip, remoteRef))
    return `its change is not on ${remote}/${trunk} by patch id yet`;
  const localTrunk = gitRun(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk}`]);
  if (
    localTrunk.ok &&
    !gitRun(cwd, ["merge-base", "--is-ancestor", localTrunk.stdout.trim(), remoteRef]).ok
  )
    return `local ${trunk} has commits that are not on ${remote}/${trunk}`;
  const nested = worktrees
    .filter((other) => other.path !== checkout && inside(other.path, checkout))
    .map((other) => other.path);
  const procs = await stopWithin(checkout, nested, options, env, out);
  if (procs) return procs;
  // The fetch and the stop take time: a commit or an edit made meanwhile keeps the checkout.
  const moved = movedFrom(cwd, checkout, branch, tip);
  if (moved) return moved;
  const late = checkoutChanges(checkout);
  if (late === null || late.length)
    return late === null ? "git status failed" : "it changed while its processes stopped";
  const trunkElsewhere = worktrees.some(
    (other) => other.path !== checkout && other.branch === `refs/heads/${trunk}`,
  );
  if (trunkElsewhere) {
    const detached = gitRun(checkout, ["switch", "--quiet", "--detach", remoteRef], SLOW);
    if (!detached.ok) return `git switch --detach failed (${firstLine(detached.stderr)})`;
    out.switched = { path: checkout, to: `${remote}/${trunk} (detached)`, head: "" };
    out.notes.push(
      `${checkout} is detached at ${remote}/${trunk}: ${trunk} is checked out in another worktree; \`${RELEASE_COMMAND}\` removes this one once you are done`,
    );
  } else {
    const switched = gitRun(
      checkout,
      localTrunk.ok
        ? ["switch", "--quiet", trunk]
        : ["switch", "--quiet", "--create", trunk, "--track", `${remote}/${trunk}`],
      SLOW,
    );
    if (!switched.ok) return `git switch ${trunk} failed (${firstLine(switched.stderr)})`;
    out.switched = { path: checkout, to: trunk, head: "" };
    const forwarded = gitRun(checkout, ["merge", "--quiet", "--ff-only", remoteRef], SLOW);
    if (!forwarded.ok)
      out.notes.push(
        `switched ${checkout} to ${trunk}, but it did not fast-forward to ${remote}/${trunk} (${firstLine(forwarded.stderr)})`,
      );
  }
  out.switched.head = gitRun(checkout, ["rev-parse", "HEAD"]).stdout.trim();
  return null;
}

/**
 * After a merge of `branch` at `mergedHead`, unless workspace `cleanup:
 * keep` or a keep decision says otherwise: stop the registered processes in
 * its clean worktree and remove it when Workit made it (fanout-marked or
 * under the managed root); move the checkout this runs in off the branch
 * when it is clean (leaveMergedBranch); then delete the local branch once
 * nothing has it checked out. The main checkout when this runs elsewhere,
 * someone else's worktree, a dirty one, one with a process this caller may
 * not stop, a local branch with commits beyond the merged head, and one an
 * open PR uses are kept and named.
 */
export async function cleanupAfterMerge(
  cwd: string,
  branch: string,
  mergedHead: string,
  options: CleanupOptions,
): Promise<MergeCleanup> {
  const env = options.env ?? process.env;
  const out: MergeCleanup = {
    branchDeleted: false,
    worktreeRemoved: null,
    scratchRemoved: [],
    dirty: null,
    procsStopped: [],
    switched: null,
    notes: [],
    recorded: null,
  };
  if (!branch || branch.startsWith("-") || !mergedHead) return out;
  const ref = `refs/heads/${branch}`;
  const tip = gitRun(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (!tip.ok) return out;
  const head = tip.stdout.trim();
  const setting = workspaceCleanup(cwd);
  if (setting.mode === "keep") {
    out.notes.push(
      `kept: workspace cleanup keep${setting.from ? ` (${setting.from})` : ""}${setting.invalid === undefined ? "" : `, read from the unknown value ${JSON.stringify(setting.invalid)} (auto or keep)`}; local ${branch}, its worktrees and their processes stay`,
    );
    return out;
  }
  if (head !== mergedHead && !gitRun(cwd, ["merge-base", "--is-ancestor", head, mergedHead]).ok) {
    out.notes.push(`local ${branch} has commits that were not merged; kept it`);
    return out;
  }
  const keeps = keepDecisions(cwd);
  const branchKept = keptBy(keeps, "branch", (target) => target === branch);
  if (branchKept) {
    out.notes.push(
      `kept: local ${branch}, its worktrees and their processes (decision ${branchKept.decision})`,
    );
    return out;
  }
  const openPr = options.openPr?.(branch) ?? null;
  if (openPr) {
    out.notes.push(`local ${branch} is kept: ${openPr}`);
    return out;
  }
  const worktrees = listWorktrees(cwd);
  const done = async (): Promise<MergeCleanup> => {
    if (out.worktreeRemoved || out.branchDeleted || out.procsStopped.length || out.switched) {
      const row = appendObserved(cwd, {
        type: "cleanup.removed",
        actor: options.actor,
        trigger: options.trigger,
        branch,
        head,
        worktrees: out.worktreeRemoved ? [out.worktreeRemoved] : [],
        branches: out.branchDeleted ? [branch] : [],
        procs: out.procsStopped.map((proc) => proc.id),
        ...(out.switched ? { switched: out.switched } : {}),
      });
      out.recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
    }
    return out;
  };
  // The checkout this runs in: the deepest worktree holding cwd (one nested in the main checkout wins).
  const own = worktrees
    .filter((entry) => inside(cwd, entry.path))
    .toSorted((a, b) => canonical(b.path).length - canonical(a.path).length)[0];
  for (const [index, entry] of worktrees.entries()) {
    if (entry.branch !== ref) continue;
    const worktreeKept = keptBy(
      keeps,
      "worktree",
      (target) => canonical(target) === canonical(entry.path),
    );
    if (worktreeKept) {
      out.notes.push(
        `kept: worktree ${entry.path} and local ${branch} (decision ${worktreeKept.decision})`,
      );
      return done();
    }
    if (hostOwned(entry.path)) {
      out.notes.push(`local ${branch} is checked out in ${entry.path}, ${HOST_OWNED}; kept both`);
      return done();
    }
    if (entry === own) {
      const kept = await leaveMergedBranch(cwd, entry, worktrees, branch, head, options, env, out);
      if (kept) {
        out.notes.push(`local ${branch} is checked out in ${entry.path}: ${kept}; kept both`);
        return done();
      }
      continue;
    }
    if (index === 0) {
      out.notes.push(`local ${branch} is checked out in ${entry.path}; kept it`);
      return done();
    }
    const busy = operationInProgress(entry.path);
    if (busy) {
      out.notes.push(`worktree ${entry.path}: ${busy}; kept it and local ${branch}`);
      return done();
    }
    const place = placeOf(entry.path, env);
    if (place !== "managed" && !isFanoutWorktree(entry.path)) {
      out.notes.push(
        `local ${branch} is checked out in ${entry.path}, not a Workit worktree; kept both`,
      );
      return done();
    }
    const live = liveHold(entry.path, { env, session: options.actor.session });
    if (live) {
      out.notes.push(`worktree ${entry.path}: ${live}; kept it and local ${branch}`);
      return done();
    }
    const state = keepReason(entry.path, repoRegenerable(cwd));
    if (state.held) {
      out.dirty = { path: entry.path, paths: state.held.paths.slice(0, DIRTY_SHOWN) };
      out.notes.push(
        `worktree ${entry.path} has ${state.held.reason}; kept it and local ${branch}. Commit, move or discard them, then \`${RELEASE_COMMAND}\``,
      );
      return done();
    }
    const procs = await stopWithin(entry.path, [], options, env, out);
    if (procs) {
      out.notes.push(`worktree ${entry.path}: ${procs}; kept it and local ${branch}`);
      return done();
    }
    // The stop takes time: a commit or an edit made meanwhile keeps the worktree and branch.
    const moved = movedFrom(cwd, entry.path, branch, head);
    if (moved) {
      out.notes.push(`worktree ${entry.path}: ${moved}; kept it and local ${branch}`);
      return done();
    }
    const after = keepReason(entry.path, repoRegenerable(cwd));
    if (after.held) {
      out.dirty = { path: entry.path, paths: after.held.paths.slice(0, DIRTY_SHOWN) };
      out.notes.push(
        `worktree ${entry.path} has ${after.held.reason}; kept it and local ${branch}. Commit, move or discard them, then \`${RELEASE_COMMAND}\``,
      );
      return done();
    }
    if (!dropMarkers(entry.path, after.markers)) {
      out.notes.push(`worktree ${entry.path} changed meanwhile; kept it and local ${branch}`);
      return done();
    }
    const scratches = workerScratchesOf(cwd, entry.path, env);
    const removed = gitRun(cwd, ["worktree", "remove", entry.path], SLOW);
    if (!removed.ok) {
      out.notes.push(
        `could not remove worktree ${entry.path} (${firstLine(removed.stderr)}); kept local ${branch}`,
      );
      return done();
    }
    out.worktreeRemoved = entry.path;
    out.scratchRemoved = scratches.filter((dir) => removeWorkerScratch(dir, env));
    tidyParent(entry.path, place, env);
  }
  const left = listWorktrees(cwd);
  // A worktree mid-rebase or mid-bisect shows a detached HEAD, so it never
  // names the branch it works on; update-ref (unlike branch -D) would not
  // notice. Any operation under way in any worktree, read from the admin
  // dirs (a locked or prunable worktree's directory may be gone), keeps the
  // branch; an admin dir that cannot be read keeps it too.
  const underway = operationsUnderway(cwd);
  if (underway && "unreadable" in underway)
    out.notes.push(
      `cannot tell whether an operation is under way (${underway.unreadable}); kept local ${branch}`,
    );
  else if (underway)
    out.notes.push(
      `worktree ${underway.where}: ${underway.busy}; kept local ${branch} until it ends`,
    );
  else if (!left.some((entry) => entry.branch === ref)) {
    // Compare-and-delete: a commit that lands after the last check keeps the branch.
    const deleted = gitRun(cwd, ["update-ref", "-d", ref, head]);
    if (deleted.ok) {
      out.branchDeleted = true;
      gitRun(cwd, ["config", "--remove-section", `branch.${branch}`]);
    } else
      out.notes.push(
        `could not delete local ${branch} at ${head.slice(0, 12)}: ${firstLine(deleted.stderr)}; kept it`,
      );
  }
  return done();
}

/** What a merge cleanup did and kept, one line each, for `pr merge` and `verify-delivery merge`. */
export function cleanupLines(cleanup: MergeCleanup, branch: string | null): string[] {
  return [
    ...cleanup.procsStopped.map((proc) => `stopped process ${proc.id} (${proc.cmd})`),
    ...(cleanup.worktreeRemoved ? [`removed worktree ${cleanup.worktreeRemoved}`] : []),
    ...(cleanup.switched
      ? [
          `switched ${cleanup.switched.path} to ${cleanup.switched.to} at ${cleanup.switched.head.slice(0, 12)}`,
        ]
      : []),
    ...(cleanup.branchDeleted ? [`deleted local ${branch}`] : []),
    ...cleanup.notes,
    ...(cleanup.recorded && "error" in cleanup.recorded
      ? [`ledger: cleanup not recorded (${cleanup.recorded.error})`]
      : []),
  ];
}

/** A worktree with no commits of its own is left alone this long after its last use. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/** A commit was made on `branch` (its reflog has more than the creation entry). */
const committedOn = (cwd: string, branch: string): boolean => {
  const log = gitRun(cwd, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"]);
  return (
    log.ok &&
    log.stdout.split("\n").some((line) => /^(commit|merge|cherry-pick|rebase)/u.test(line))
  );
};

/**
 * When the worktree last moved: its admin dir's HEAD (written on checkout and
 * commit; `git status` may rewrite the index, so that is not used). 0 when unknown.
 */
const lastUsedMs = (worktree: string): number => {
  const dir = gitRun(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return 0;
  try {
    return fs.statSync(path.join(dir.stdout.trim(), "HEAD")).mtimeMs;
  } catch {
    return 0;
  }
};

export type SweepCandidate = {
  path: string;
  branch: string | null;
  head: string | null;
  place: WorktreePlace;
  /** merged / squash-merged into the trunk, or stale (its directory is gone). */
  reason: MergeProof | "stale";
  bytes: number;
  /** Untracked old-runtime `.workit/` markers deleted before the worktree goes. */
  markers?: string[];
};

export type SweepKept = { path: string; branch: string | null; reason: string };

export type SweepBranch = { name: string; reason: MergeProof };

export type WorktreeSweep = {
  apply: boolean;
  trunk: string | null;
  /** Worktrees gc removes (with --apply) or would remove. */
  removable: SweepCandidate[];
  /** Local branches whose remote is gone, merged, checked out nowhere. */
  goneBranches: SweepBranch[];
  kept: SweepKept[];
  /** --apply only: what went. */
  removed: string[];
  deletedBranches: string[];
  removedDirs: string[];
  /** --apply only: the removed worktrees' out-of-tree worker scratch dirs that went with them. */
  removedScratch: string[];
  notes: string[];
  recorded: { id: string } | { error: string } | null;
};

const shortBranch = (ref: string | null): string | null =>
  ref?.startsWith("refs/heads/") ? ref.slice(11) : ref;

/** Local branches whose upstream is configured but gone: name → tip. */
function goneUpstreams(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  const refs = gitRun(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)%09%(upstream:track)",
    "refs/heads",
  ]);
  if (!refs.ok) return out;
  for (const line of refs.stdout.split("\n")) {
    const [name, sha, track] = line.split("\t");
    if (name && sha && track === "[gone]") out.set(name, sha);
  }
  return out;
}

/**
 * List (and with `apply`, remove) what finished changes left: clean worktrees
 * in Workit's places whose commit landed on the trunk, stale registrations,
 * and merged local branches whose remote is gone. Every removal is recorded
 * in one ledger row.
 */
export function sweepWorktrees(
  cwd: string,
  options: { apply: boolean; actor: LedgerActor; env?: NodeJS.ProcessEnv },
): WorktreeSweep {
  const env = options.env ?? process.env;
  const trunkName = defaultTrunk(cwd);
  const trunk = trunkRef(cwd, trunkName);
  const out: WorktreeSweep = {
    apply: options.apply,
    trunk,
    removable: [],
    goneBranches: [],
    kept: [],
    removed: [],
    deletedBranches: [],
    removedDirs: [],
    removedScratch: [],
    notes: [],
    recorded: null,
  };
  const patches = new Map<string, Set<string>>();
  const proven = (tip: string | null): MergeProof | null =>
    tip && trunk ? mergeProof(cwd, tip, trunk, patches) : null;
  const trees = listWorktrees(cwd);
  const gone = goneUpstreams(cwd);
  const regenerable = repoRegenerable(cwd);
  for (const [index, entry] of trees.entries()) {
    if (index === 0) continue;
    const branch = shortBranch(entry.branch);
    const keep = (reason: string) => out.kept.push({ path: entry.path, branch, reason });
    if (entry.prunable) {
      out.removable.push({
        ...pick(entry, branch),
        place: placeOf(entry.path, env),
        reason: "stale",
        bytes: 0,
      });
      continue;
    }
    if (inside(cwd, entry.path)) {
      keep("the checkout this command runs in");
      continue;
    }
    if (entry.locked) {
      keep("locked");
      continue;
    }
    if (hostOwned(entry.path)) {
      keep(HOST_OWNED);
      continue;
    }
    const busy = operationInProgress(entry.path);
    if (busy) {
      keep(busy);
      continue;
    }
    const place = placeOf(entry.path, env);
    if (place === "other" && !isFanoutWorktree(entry.path)) {
      keep("not in a Workit worktree or temp location");
      continue;
    }
    const proof = proven(entry.head);
    if (!proof) {
      keep(
        `not merged into ${trunk ?? trunkName}${branch && gone.has(branch) ? " (its remote branch is gone)" : ""}`,
      );
      continue;
    }
    const live = liveHold(entry.path, { env, session: options.actor.session });
    if (live) {
      keep(live);
      continue;
    }
    const state = keepReason(entry.path, regenerable);
    if (state.held) {
      keep(state.held.reason);
      continue;
    }
    // A worktree with no landed work of its own (a branch never committed to)
    // may be a live worker's fresh slice. A detached Workit worktree on a
    // trunk commit is a finished checkout (detached once its branch merged):
    // the live guard above protects one in use.
    const detachedOnTrunk =
      !branch && proof === "merged" && (place === "managed" || isFanoutWorktree(entry.path));
    const finished =
      detachedOnTrunk || (branch && (gone.has(branch) || committedOn(cwd, branch))) || false;
    if (!finished && Date.now() - lastUsedMs(entry.path) < FRESH_MS) {
      keep("no commits of its own and used in the last 24 hours");
      continue;
    }
    out.removable.push({
      ...pick(entry, branch),
      place,
      reason: proof,
      bytes: directoryBytes(entry.path),
      ...(state.markers.length ? { markers: state.markers } : {}),
    });
  }
  const sweptBranches = new Set(out.removable.map((entry) => entry.branch).filter(Boolean));
  const checkedOut = new Set(trees.map((entry) => shortBranch(entry.branch)));
  const isLongLived = gone.size ? longLived(cwd, trunkName) : () => false;
  for (const [name, tip] of gone) {
    if (name === trunkName || sweptBranches.has(name) || checkedOut.has(name)) continue;
    if (isLongLived(name)) {
      out.kept.push({
        path: "",
        branch: name,
        reason: "remote branch gone, but a long-lived branch of the branch policy",
      });
      continue;
    }
    const proof = proven(tip);
    if (proof) out.goneBranches.push({ name, reason: proof });
    else
      out.kept.push({
        path: "",
        branch: name,
        reason: `remote branch gone, but not merged into ${trunk ?? trunkName}`,
      });
  }
  if (!options.apply) return out;

  let stale = false;
  const scratches = new Map(
    out.removable.map((candidate) => [candidate.path, workerScratchesOf(cwd, candidate.path, env)]),
  );
  const dropScratch = (worktree: string) => {
    for (const dir of scratches.get(worktree) ?? [])
      if (removeWorkerScratch(dir, env)) out.removedScratch.push(dir);
  };
  for (const candidate of out.removable) {
    if (candidate.reason === "stale") {
      stale = true;
      continue;
    }
    if (!dropMarkers(candidate.path, candidate.markers ?? [])) {
      out.notes.push(`could not remove ${candidate.path}: its .workit/ changed meanwhile`);
      continue;
    }
    const removed = gitRun(cwd, ["worktree", "remove", candidate.path], SLOW);
    if (!removed.ok) {
      out.notes.push(`could not remove ${candidate.path}: ${firstLine(removed.stderr)}`);
      continue;
    }
    out.removed.push(candidate.path);
    dropScratch(candidate.path);
    const parent = tidyParent(candidate.path, candidate.place, env);
    if (parent) out.removedDirs.push(parent);
    if (
      candidate.branch &&
      !listWorktrees(cwd).some((entry) => entry.branch === `refs/heads/${candidate.branch}`)
    )
      deleteBranch(cwd, candidate.branch, out);
  }
  if (stale) {
    const pruned = gitRun(cwd, ["worktree", "prune"], SLOW);
    if (pruned.ok)
      for (const candidate of out.removable.filter((c) => c.reason === "stale")) {
        out.removed.push(candidate.path);
        dropScratch(candidate.path);
      }
    else out.notes.push(`git worktree prune failed: ${firstLine(pruned.stderr)}`);
  }
  for (const entry of out.goneBranches) deleteBranch(cwd, entry.name, out);
  if (out.removed.length || out.deletedBranches.length) {
    const row = appendObserved(cwd, {
      type: "cleanup.removed",
      actor: options.actor,
      trigger: "gc --worktrees",
      worktrees: out.removed,
      branches: out.deletedBranches,
      dirs: out.removedDirs,
      ...(out.removedScratch.length ? { scratch: out.removedScratch } : {}),
    });
    out.recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
  }
  return out;
}

const pick = (entry: WorktreeEntry, branch: string | null) => ({
  path: entry.path,
  branch,
  head: entry.head,
});

const deleteBranch = (cwd: string, branch: string, out: WorktreeSweep): void => {
  if (branch.startsWith("-")) return;
  const deleted = gitRun(cwd, ["branch", "-D", "--", branch]);
  if (deleted.ok) out.deletedBranches.push(branch);
  else out.notes.push(`could not delete local ${branch}: ${firstLine(deleted.stderr)}`);
};

/** The forge calls the branch sweep makes; a ResolvedForge fits. */
export type BranchForge = {
  forge: Pick<Forge, "findPr" | "prMeta">;
  headRepo: string;
  headProjectId: number | null;
};

export type BranchSweep = {
  apply: boolean;
  trunk: string | null;
  /** Why the merged-PR check did not run (no forge access), or null when it did. */
  forgeSkipped: string | null;
  /** Local branches proven merged: gc deletes them (with --apply) or would. */
  deletable: { name: string; tip: string; reason: string }[];
  kept: { name: string; reason: string }[];
  /** --apply only: what went. */
  deleted: string[];
  notes: string[];
  recorded: { id: string } | { error: string } | null;
};

/** Long-lived by convention, whatever the policy says: gc never deletes them. */
const CONVENTIONAL_LONG_LIVED = ["main", "master", "develop", "production", "staging"];
const CONVENTIONAL_LONG_LIVED_PREFIXES = ["release/", "hotfix/"];

/**
 * The branches the workspace keeps receiving work on: the trunk and default
 * target, git-flow develop and production, every release track's branches,
 * the policy's protected names, and the conventional long-lived names and
 * `release/*`, `hotfix/*` (a repo with no policy or track configured). Never swept.
 */
function longLived(cwd: string, trunkName: string): (name: string) => boolean {
  const names = new Set([trunkName, ...CONVENTIONAL_LONG_LIVED]);
  try {
    const target = resolveBranchPolicyFor(cwd).defaultTargetBranch;
    if (typeof target === "string" && target) names.add(target);
  } catch {
    // an unreadable policy adds nothing; isProtectedTarget fails closed below
  }
  const flow = gitFlowOf(cwd);
  if (flow) for (const name of [flow.develop, flow.production]) names.add(name);
  for (const name of trackBranches(workspaceReleaseTracks(cwd).tracks)) names.add(name);
  return (name) =>
    names.has(name) ||
    CONVENTIONAL_LONG_LIVED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    isProtectedTarget(cwd, name);
}

/** When `branch` last moved (its newest reflog entry, else its tip's commit time), in ms. */
const branchMovedMs = (cwd: string, branch: string): number => {
  const reflog = gitRun(cwd, [
    "log",
    "-g",
    "-n",
    "1",
    "--date=unix",
    "--format=%gd",
    `refs/heads/${branch}`,
    "--",
  ]);
  const stamp = reflog.ok ? /@\{(\d+)\}/u.exec(reflog.stdout)?.[1] : undefined;
  if (stamp) return Number(stamp) * 1000;
  const commit = gitRun(cwd, ["log", "-n", "1", "--format=%ct", `refs/heads/${branch}`, "--"]);
  return commit.ok ? Number(commit.stdout.trim()) * 1000 || 0 : 0;
};

/** Commits on `tip` that are not on `trunk` by patch id (`git cherry` `+` lines); null when git cannot say. */
const unlandedCommits = (cwd: string, trunk: string, tip: string): number | null => {
  const cherry = gitRun(cwd, ["cherry", trunk, tip]);
  return cherry.ok ? cherry.stdout.split("\n").filter((line) => line.startsWith("+")).length : null;
};

type PrProof = { proof: string } | { keep: string } | null;

/** What the forge says of `name` at `tip`: a merged PR into the trunk or a policy branch, an open PR, or nothing. */
function prProof(
  forge: BranchForge,
  name: string,
  tip: string,
  trunkName: string,
  isLongLived: (name: string) => boolean,
): PrProof {
  const found = forge.forge.findPr(name, {
    owner: forge.headRepo.split("/")[0] || null,
    projectId: forge.headProjectId,
    sha: tip,
  });
  if (!found.ok) return { keep: `PR lookup failed (${firstLine(found.error)})` };
  const pr = found.data;
  if (!pr) return null;
  if (pr.state === "open") return { keep: `open PR #${pr.number}` };
  if (pr.state !== "merged" || pr.headSha !== tip) return null;
  const meta = forge.forge.prMeta(pr.number);
  if (!meta.ok) return { keep: `PR #${pr.number} merged, but its base could not be read` };
  const base = meta.data.base;
  if (base === trunkName || isLongLived(base)) return { proof: `merged PR #${pr.number}` };
  return {
    keep: `PR #${pr.number} merged into ${base}, not ${trunkName} or a long-lived branch (a stack parent)`,
  };
}

/**
 * List (and with `apply`, delete) local branches whose work is on the trunk:
 * the tip is the head of a PR merged into the trunk or a long-lived branch
 * (forge connected), no commit is missing from the trunk by patch id (`git
 * cherry`), or mergeProof holds. Kept and named: the trunk and long-lived
 * policy branches, a branch checked out in any worktree (a host's
 * `worktree-agent-*` one included), an open PR, a PR merged into a stack
 * parent, a commit not on the trunk, and a branch with no commits of its own
 * that moved in the last 24 hours. Deletions are recorded in one ledger row.
 */
export function sweepBranches(
  cwd: string,
  options: {
    apply: boolean;
    actor: LedgerActor;
    /** null: no forge access; `forgeSkipped` names why. */
    forge: BranchForge | null;
    forgeSkipped?: string;
    now?: number;
  },
): BranchSweep {
  const trunkName = defaultTrunk(cwd);
  const trunk = trunkRef(cwd, trunkName);
  const out: BranchSweep = {
    apply: options.apply,
    trunk,
    forgeSkipped: options.forge ? null : (options.forgeSkipped ?? "no forge access"),
    deletable: [],
    kept: [],
    deleted: [],
    notes: [],
    recorded: null,
  };
  if (!trunk) {
    out.notes.push(`no trunk ref for ${trunkName}; nothing can be proven merged`);
    return out;
  }
  const refs = gitRun(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    "refs/heads",
  ]);
  if (!refs.ok) {
    out.notes.push(`cannot list local branches: ${firstLine(refs.stderr)}`);
    return out;
  }
  const checkedOut = new Map<string, string>();
  for (const entry of listWorktrees(cwd)) {
    const name = shortBranch(entry.branch);
    if (name) checkedOut.set(name, entry.path);
  }
  const isLongLived = longLived(cwd, trunkName);
  const now = options.now ?? Date.now();
  const patches = new Map<string, Set<string>>();
  for (const line of refs.stdout.split("\n")) {
    const [name, tip] = line.split("\t");
    if (!name || !tip || name === trunkName || name.startsWith("-")) continue;
    const keep = (reason: string) => out.kept.push({ name, reason });
    if (isLongLived(name)) {
      keep("a long-lived branch of the branch policy");
      continue;
    }
    const where = checkedOut.get(name);
    if (where) {
      keep(`checked out in ${where}`);
      continue;
    }
    const unlanded = unlandedCommits(cwd, trunk, tip);
    const own = gitRun(cwd, ["rev-list", "--count", `${trunk}..${tip}`]);
    const noOwn = own.ok && own.stdout.trim() === "0" && !committedOn(cwd, name);
    if (noOwn && now - branchMovedMs(cwd, name) < FRESH_MS) {
      keep("no commits of its own and created or moved in the last 24 hours (fresh)");
      continue;
    }
    const pr = options.forge ? prProof(options.forge, name, tip, trunkName, isLongLived) : null;
    if (pr && "keep" in pr) {
      keep(pr.keep);
      continue;
    }
    let reason: string | null = pr?.proof ?? null;
    if (!reason && unlanded === 0)
      reason =
        own.ok && own.stdout.trim() === "0"
          ? `no commits off ${trunk}`
          : `every commit is on ${trunk} (git cherry)`;
    if (!reason) reason = mergeProof(cwd, tip, trunk, patches);
    if (!reason) {
      keep(
        unlanded === null
          ? `cannot tell whether its commits are on ${trunk}`
          : `${unlanded} commit${unlanded === 1 ? "" : "s"} not on ${trunk} by patch id`,
      );
      continue;
    }
    out.deletable.push({ name, tip, reason });
  }
  if (!options.apply) return out;
  for (const entry of out.deletable) {
    const current = gitRun(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${entry.name}`]);
    if (!current.ok || current.stdout.trim() !== entry.tip) {
      out.notes.push(`${entry.name} moved meanwhile; kept it`);
      continue;
    }
    const deleted = gitRun(cwd, ["branch", "-D", "--", entry.name]);
    if (deleted.ok) out.deleted.push(entry.name);
    else out.notes.push(`could not delete local ${entry.name}: ${firstLine(deleted.stderr)}`);
  }
  if (out.deleted.length) {
    const row = appendObserved(cwd, {
      type: "cleanup.removed",
      actor: options.actor,
      trigger: "gc --branches",
      worktrees: [],
      branches: out.deleted,
      heads: Object.fromEntries(
        out.deletable
          .filter((entry) => out.deleted.includes(entry.name))
          .map((entry) => [entry.name, entry.tip]),
      ),
    });
    out.recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
  }
  return out;
}
