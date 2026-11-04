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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCheckConfig } from "../check-config";
import { defaultTrunk, gitRun, nulList, trunkRef } from "../fanout";
import { SCRATCH_DIR, listWorktrees, type WorktreeEntry } from "../fanout-worktree";
import { GIT_TIMEOUTS, pushRemoteName } from "../git/rev";
import { FANOUT_TOKEN_FILE } from "../hooks/worktree-confine";
import { appendObserved, type LedgerActor } from "../ledger";
import { legacyWorktreesDir, worktreesDir } from "./workit-paths.mjs";
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

/** Uncommitted paths (the scratch dir left out); null when git cannot say. */
export function dirtyPaths(worktree: string): string[] | null {
  const status = gitRun(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!status.ok) return null;
  const out: string[] = [];
  const fields = nulList(status.stdout);
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index];
    // A rename's source follows as its own field.
    if (line[0] === "R" || line[0] === "C") index++;
    const file = line.slice(3);
    if (!file.startsWith(`${SCRATCH_DIR}/`)) out.push(file);
  }
  return out;
}

/** Ignored paths under these directories are rebuilt by a tool; removing them loses nothing. */
const REGENERABLE = new Set([
  "node_modules",
  SCRATCH_DIR,
  "dist",
  "build",
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
  return nulList(listed.stdout).filter((file) => !regenerablePath(file, regenerable));
}

const IGNORED_REASON = "ignored files that are not regenerable";

const listed = (paths: readonly string[]): string =>
  `${paths.slice(0, DIRTY_SHOWN).join(", ")}${paths.length > DIRTY_SHOWN ? `, … (${paths.length} in all)` : ""}`;

/** Why the worktree must stay (uncommitted or valuable ignored files), or null when it may go. */
function keepReason(
  worktree: string,
  regenerable: readonly string[],
): { paths: string[]; reason: string } | null {
  const dirty = dirtyPaths(worktree);
  if (dirty === null) return { paths: ["unreadable"], reason: "unreadable state" };
  if (dirty.length > 0)
    return {
      paths: dirty,
      reason: `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} (${listed(dirty)})`,
    };
  const ignored = ignoredKeepers(worktree, regenerable);
  if (ignored === null) return { paths: ["unreadable"], reason: "unreadable state" };
  if (ignored.length > 0)
    return { paths: ignored, reason: `${IGNORED_REASON} (${listed(ignored)})` };
  return null;
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
    const place = placeOf(entry.path, env);
    if (place !== "managed" && !isFanoutWorktree(entry.path)) {
      out.notes.push(
        `local ${branch} is checked out in ${entry.path}, not a Workit worktree; kept both`,
      );
      return out;
    }
    const held = keepReason(entry.path, repoRegenerable(cwd));
    if (held) {
      out.dirty = { path: entry.path, paths: held.paths.slice(0, DIRTY_SHOWN) };
      out.notes.push(
        `worktree ${entry.path} has ${held.reason}; kept it and local ${branch}. Commit, move or discard them, then \`${RELEASE_COMMAND}\``,
      );
      return out;
    }
    const removed = gitRun(cwd, ["worktree", "remove", entry.path], SLOW);
    if (!removed.ok) {
      out.notes.push(
        `could not remove worktree ${entry.path} (${firstLine(removed.stderr)}); kept local ${branch}`,
      );
      return out;
    }
    out.worktreeRemoved = entry.path;
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
    const held = keepReason(entry.path, regenerable);
    if (held) {
      keep(held.reason);
      continue;
    }
    // A worktree with no landed work of its own (detached, or a branch never
    // committed to) may be a live worker's fresh slice or a session's scratch base.
    const finished = (branch && (gone.has(branch) || committedOn(cwd, branch))) || false;
    if (!finished && Date.now() - lastUsedMs(entry.path) < FRESH_MS) {
      keep("no commits of its own and used in the last 24 hours");
      continue;
    }
    out.removable.push({
      ...pick(entry, branch),
      place,
      reason: proof,
      bytes: directoryBytes(entry.path),
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
  for (const candidate of out.removable) {
    if (candidate.reason === "stale") {
      stale = true;
      continue;
    }
    const removed = gitRun(cwd, ["worktree", "remove", candidate.path], SLOW);
    if (!removed.ok) {
      out.notes.push(`could not remove ${candidate.path}: ${firstLine(removed.stderr)}`);
      continue;
    }
    out.removed.push(candidate.path);
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
      out.removed.push(...out.removable.filter((c) => c.reason === "stale").map((c) => c.path));
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
