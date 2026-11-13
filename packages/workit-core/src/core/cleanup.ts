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
import { appendObserved, type LedgerActor } from "../ledger";
import { gitFlowOf, isProtectedTarget, resolveBranchPolicyFor } from "./branch";
import { LIVE_SESSION_TTL_MS, checkoutKey, liveProbe } from "./live-session";
import { workspaceReleaseTracks, trackBranches } from "./release-tracks";
import { leaseDir, parseLease, staleReason } from "./resources";
import { isWorkitMarkerPath } from "./task-store";
import { legacyWorktreesDir, stateDir, worktreesDir } from "./workit-paths.mjs";
import { matchWorkspace } from "./workspaces";

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
  /** A worktree kept for uncommitted changes, with the paths. */
  dirty: { path: string; paths: string[] } | null;
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
};

/**
 * After a merge of `branch` at `mergedHead`: remove its clean worktree when
 * Workit made it (fanout-marked or under the managed root), then delete the
 * local branch once nothing has it checked out. The main checkout, the one
 * this runs in, someone else's worktree, a dirty one, and a local branch
 * with commits beyond the merged head are kept and named.
 */
export function cleanupAfterMerge(
  cwd: string,
  branch: string,
  mergedHead: string,
  options: CleanupOptions,
): MergeCleanup {
  const env = options.env ?? process.env;
  const out: MergeCleanup = {
    branchDeleted: false,
    worktreeRemoved: null,
    scratchRemoved: [],
    dirty: null,
    notes: [],
    recorded: null,
  };
  if (!branch || branch.startsWith("-") || !mergedHead) return out;
  const ref = `refs/heads/${branch}`;
  const tip = gitRun(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (!tip.ok) return out;
  const head = tip.stdout.trim();
  if (head !== mergedHead && !gitRun(cwd, ["merge-base", "--is-ancestor", head, mergedHead]).ok) {
    out.notes.push(`local ${branch} has commits that were not merged; kept it`);
    return out;
  }
  for (const [index, entry] of listWorktrees(cwd).entries()) {
    if (entry.branch !== ref) continue;
    if (index === 0 || inside(cwd, entry.path)) {
      out.notes.push(`local ${branch} is checked out in ${entry.path}; kept it`);
      return out;
    }
    if (hostOwned(entry.path)) {
      out.notes.push(`local ${branch} is checked out in ${entry.path}, ${HOST_OWNED}; kept both`);
      return out;
    }
    const place = placeOf(entry.path, env);
    if (place !== "managed" && !isFanoutWorktree(entry.path)) {
      out.notes.push(
        `local ${branch} is checked out in ${entry.path}, not a Workit worktree; kept both`,
      );
      return out;
    }
    const live = liveHold(entry.path, { env, session: options.actor.session });
    if (live) {
      out.notes.push(`worktree ${entry.path}: ${live}; kept it and local ${branch}`);
      return out;
    }
    const state = keepReason(entry.path, repoRegenerable(cwd));
    if (state.held) {
      out.dirty = { path: entry.path, paths: state.held.paths.slice(0, DIRTY_SHOWN) };
      out.notes.push(
        `worktree ${entry.path} has ${state.held.reason}; kept it and local ${branch}. Commit, move or discard them, then \`${RELEASE_COMMAND}\``,
      );
      return out;
    }
    if (!dropMarkers(entry.path, state.markers)) {
      out.notes.push(`worktree ${entry.path} changed meanwhile; kept it and local ${branch}`);
      return out;
    }
    const scratches = workerScratchesOf(cwd, entry.path, env);
    const removed = gitRun(cwd, ["worktree", "remove", entry.path], SLOW);
    if (!removed.ok) {
      out.notes.push(
        `could not remove worktree ${entry.path} (${firstLine(removed.stderr)}); kept local ${branch}`,
      );
      return out;
    }
    out.worktreeRemoved = entry.path;
    out.scratchRemoved = scratches.filter((dir) => removeWorkerScratch(dir, env));
    tidyParent(entry.path, place, env);
  }
  if (!listWorktrees(cwd).some((entry) => entry.branch === ref)) {
    const deleted = gitRun(cwd, ["branch", "-D", "--", branch]);
    if (deleted.ok) out.branchDeleted = true;
    else out.notes.push(`could not delete local ${branch}: ${firstLine(deleted.stderr)}`);
  }
  if (out.worktreeRemoved || out.branchDeleted) {
    const row = appendObserved(cwd, {
      type: "cleanup.removed",
      actor: options.actor,
      trigger: options.trigger,
      branch,
      head,
      worktrees: out.worktreeRemoved ? [out.worktreeRemoved] : [],
      branches: out.branchDeleted ? [branch] : [],
    });
    out.recorded = row.ok ? { id: String(row.value.id) } : { error: row.error };
  }
  return out;
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
  for (const [name, tip] of gone) {
    if (name === trunkName || sweptBranches.has(name) || checkedOut.has(name)) continue;
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

/**
 * The branches the workspace keeps receiving work on: the trunk and default
 * target, git-flow develop and production, every release track's branches,
 * and the policy's protected names. Never swept.
 */
function longLived(cwd: string, trunkName: string): (name: string) => boolean {
  const names = new Set([trunkName]);
  try {
    const target = resolveBranchPolicyFor(cwd).defaultTargetBranch;
    if (typeof target === "string" && target) names.add(target);
  } catch {
    // an unreadable policy adds nothing; isProtectedTarget fails closed below
  }
  const flow = gitFlowOf(cwd);
  if (flow) for (const name of [flow.develop, flow.production]) names.add(name);
  for (const name of trackBranches(workspaceReleaseTracks(cwd).tracks)) names.add(name);
  return (name) => names.has(name) || isProtectedTarget(cwd, name);
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
