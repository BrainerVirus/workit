// Nothing a finished change made stays on disk (#653). After a merge, the
// branch's clean worktree (made by `workit fanout worktree create`, or under
// the managed root) and its local branch go, and the ledger says what went.
// `workit gc --worktrees` sweeps what earlier changes left: merged or
// squash-merged clean worktrees in Workit's places (the managed root, legacy
// `<repo>-wt`/`workit-wt` dirs beside a project, the temp dir), stale
// registrations, and local branches whose remote is gone once merged.
// Never forced: a dirty, locked or unmerged worktree, the main checkout and
// the checkout the command runs in are kept and named.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultTrunk, gitRun, nulList, trunkRef } from "../fanout";
import { SCRATCH_DIR, listWorktrees, type WorktreeEntry } from "../fanout-worktree";
import { GIT_TIMEOUTS } from "../git/rev";
import { FANOUT_TOKEN_FILE } from "../hooks/worktree-confine";
import { appendObserved, type LedgerActor } from "../ledger";

const SLOW = GIT_TIMEOUTS.worktree;
/** Dirty paths named in output and ledger rows. */
const DIRTY_SHOWN = 5;
/** Run once a dirty worktree is dealt with; gc removes it when it is merged and clean. */
export const RELEASE_COMMAND = "workit gc --worktrees --apply";

/** Where Workit makes worktrees: `<cache>/workit-wt/<repo>/<slice>`, never beside the project. */
export function managedWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), ".cache");
  return path.join(cache, "workit-wt");
}

const canonical = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(canonical(parent), canonical(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** managed: under the managed root; legacy: `<parent>/<repo>-wt/<x>`; scratch: the temp dir. */
export type WorktreePlace = "managed" | "legacy" | "scratch" | "other";

export function placeOf(worktree: string, env: NodeJS.ProcessEnv = process.env): WorktreePlace {
  if (inside(worktree, managedWorktreeRoot(env))) return "managed";
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

const dirtyNote = (worktree: string, paths: string[] | null): string =>
  paths === null
    ? `worktree ${worktree} has an unreadable state; kept it`
    : `worktree ${worktree} has ${paths.length} uncommitted change${paths.length === 1 ? "" : "s"} (${paths.slice(0, DIRTY_SHOWN).join(", ")}${paths.length > DIRTY_SHOWN ? ", …" : ""}); kept it. Commit, move or discard them, then \`${RELEASE_COMMAND}\``;

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

/** The managed `<repo>` dir or the legacy `-wt` dir that held a removed worktree, once empty. */
const tidyParent = (worktree: string, place: WorktreePlace): string | null => {
  if (place !== "managed" && place !== "legacy") return null;
  const parent = path.dirname(worktree);
  return removeIfEmpty(parent) ? parent : null;
};

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

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
    const dirty = dirtyPaths(entry.path);
    if (dirty === null || dirty.length > 0) {
      out.dirty = {
        path: entry.path,
        paths: (dirty ?? ["unreadable"]).slice(0, DIRTY_SHOWN),
      };
      out.notes.push(`${dirtyNote(entry.path, dirty)}; kept local ${branch}`);
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
    tidyParent(entry.path, place);
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
    const dirty = dirtyPaths(entry.path);
    if (dirty === null || dirty.length > 0) {
      keep(
        dirty === null
          ? "unreadable state"
          : `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} (${dirty.slice(0, DIRTY_SHOWN).join(", ")}${dirty.length > DIRTY_SHOWN ? ", …" : ""})`,
      );
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
    const parent = tidyParent(candidate.path, candidate.place);
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
