// `workit fanout worktree create|release <slice>` (G4): deterministic worktrees
// for hosts without native worktree isolation (OpenCode, Codex, Cursor, Pi).
//
// create: the slice's worktree at its planned path. A new slice starts
// detached at its planned base and gets its branch through `workit git
// branch` (core gitBranch: branch policy, release tracks); an existing branch
// (MODE: resume) is checked out as it is. It also makes the per-worker
// scratch dir `<worktree>/.workit-scratch`, hidden from git through the
// repository's info/exclude, and records `fanout.worktree.created`.
//
// release: records `git status` of the worktree in the ledger first
// (`fanout.worktree.released`), refuses while it has uncommitted changes
// unless forced, then runs `git worktree remove` (which takes the scratch dir
// with it). The branch is kept. It only removes a worktree that `create` made
// for this fanout, slice and path (its ledger row says so), on the slice's
// branch or detached; never the main checkout, the one the command runs in,
// or a worktree someone else made there, not even with --force. An empty
// directory that existed before `create` is left in place.
import fs from "node:fs";
import path from "node:path";
import { gitBranch } from "./git/ops";
import { GIT_TIMEOUTS, gitCommonDir, pushRemoteName, resolveRef } from "./git/rev";
import { appendObserved, readLedger, type LedgerActor } from "./ledger";
import {
  branchRef,
  fanoutFail,
  gitRun,
  mainCheckout,
  nulList,
  trunkRef,
  type FanoutFile,
  type FanoutResult,
  type Slice,
} from "./fanout";

const SLOW = GIT_TIMEOUTS.worktree;
export const SCRATCH_DIR = ".workit-scratch";
const EXCLUDE_LINE = `/${SCRATCH_DIR}/`;
/** Dirty paths kept in the ledger row: it has a 4 KB line limit. */
const DIRTY_ROW_BYTES = 2000;

/** The first dirty entries that fit the row; dirtyCount keeps the total. */
function rowSample(lines: readonly string[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const entry = line.slice(0, 200);
    bytes += Buffer.byteLength(entry) + 3;
    if (bytes > DIRTY_ROW_BYTES) break;
    out.push(entry);
  }
  return out;
}

type WorktreeEntry = {
  path: string;
  head: string | null;
  /** refs/heads/<name>, or null when detached. */
  branch: string | null;
  locked: boolean;
};

const canonical = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

const samePath = (a: string, b: string): boolean => {
  const left = canonical(a);
  const right = canonical(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
};

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(canonical(parent), canonical(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** `git worktree list --porcelain -z`; the first entry is the main worktree. */
function listWorktrees(cwd: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of gitRun(cwd, ["worktree", "list", "--porcelain", "-z"]).stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), head: null, branch: null, locked: false };
      out.push(current);
    } else if (!current) continue;
    else if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field.startsWith("branch ")) current.branch = field.slice(7);
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
  }
  return out;
}

/** The slice's worktree path: absolute since plan time; an older relative one is the main checkout's. */
const slicePath = (cwd: string, slice: Slice): string =>
  path.isAbsolute(slice.worktree)
    ? slice.worktree
    : path.resolve(mainCheckout(cwd), slice.worktree);

/** Timestamps of the admin dir and the ledger have second granularity on some filesystems. */
const CLOCK_SLACK_MS = 2000;

/**
 * The live `fanout.worktree.created` row for this fanout, slice and path:
 * the newest one, unless a later release removed that worktree (a row is
 * void once its worktree is gone), and only while the worktree at the path
 * is the one it recorded: git's admin dir for it (`.git/worktrees/<id>`) was
 * made no earlier than the row. Anything else is someone else's worktree.
 */
function createdRow(cwd: string, plan: FanoutFile, slice: Slice, target: string) {
  const ledger = readLedger(cwd);
  if (!ledger.ok) return null;
  const atPath = (row: Record<string, unknown>) =>
    row.fanout === plan.name &&
    row.slice === slice.id &&
    typeof row.path === "string" &&
    samePath(row.path, target);
  const rows = ledger.value.rows;
  const row = rows.findLast(
    (candidate) => candidate.type === "fanout.worktree.created" && atPath(candidate),
  );
  if (!row) return null;
  const removedSince = rows.some(
    (candidate) =>
      candidate.seq > row.seq &&
      candidate.type === "fanout.worktree.released" &&
      candidate.outcome === "removed" &&
      atPath(candidate),
  );
  if (removedSince) return null;
  const made = adminDirTime(target);
  if (made === null || made + CLOCK_SLACK_MS < Date.parse(row.at)) return null;
  return row;
}

/** When git made the worktree's admin dir (birth time, else mtime); null when unknown. */
function adminDirTime(worktree: string): number | null {
  const dir = gitRun(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return null;
  try {
    const stat = fs.statSync(dir.stdout.trim());
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  } catch {
    return null;
  }
}

function findSlice(plan: FanoutFile, id: string): FanoutResult<Slice> {
  const slice = plan.slices.find((candidate) => candidate.id === id);
  return slice
    ? { ok: true, data: slice }
    : fanoutFail(
        "invalid_input",
        `${id}: not a slice of fanout ${plan.name}`,
        `slices: ${plan.slices.map((candidate) => candidate.id).join(", ")}`,
      );
}

/** Hide the scratch dir from git status and `git add -A` in every worktree. */
function excludeScratch(cwd: string): void {
  const common = gitCommonDir(cwd);
  if (!common) return;
  const file = path.join(common, "info", "exclude");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  if (text.split(/\r?\n/u).includes(EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${text && !text.endsWith("\n") ? "\n" : ""}# workit fanout: per-worker scratch dirs\n${EXCLUDE_LINE}\n`,
  );
}

export type CreateOutcome = {
  fanout: string;
  slice: string;
  branch: string;
  base: string;
  path: string;
  scratch: string;
  head: string;
  /** new: the branch was created from its base; resume: the existing branch was checked out. */
  mode: "new" | "resume";
  /** False when the worktree already existed on the slice's branch. */
  created: boolean;
  notes: string[];
};

function ensureScratch(worktree: string): string {
  const scratch = path.join(worktree, SCRATCH_DIR);
  fs.mkdirSync(scratch, { recursive: true });
  return scratch;
}

export function createSliceWorktree(
  cwd: string,
  plan: FanoutFile,
  input: { slice: string; actor: LedgerActor },
): FanoutResult<CreateOutcome> {
  const found = findSlice(plan, input.slice);
  if (!found.ok) return found;
  const slice = found.data;
  if (!slice.worktree)
    return fanoutFail(
      "invalid_input",
      `slice ${slice.id} has no worktree path`,
      "re-plan it with workit fanout plan",
    );
  const target = slicePath(cwd, slice);
  const worktrees = listWorktrees(cwd);
  const localRef = `refs/heads/${slice.branch}`;
  const existing = worktrees.find((entry) => samePath(entry.path, target));
  const base = {
    fanout: plan.name,
    slice: slice.id,
    branch: slice.branch,
    base: slice.base,
    path: target,
  };
  if (existing) {
    if (existing.branch !== null && existing.branch !== localRef)
      return fanoutFail(
        "blocked",
        `${target} is a worktree on ${existing.branch.replace(/^refs\/heads\//u, "")}, not ${slice.branch}`,
        `release it first, or set slice ${slice.id}'s worktree to another path`,
      );
    if (!createdRow(cwd, plan, slice, target))
      return fanoutFail(
        "blocked",
        `${target} is a worktree that workit fanout worktree create did not make for slice ${slice.id}`,
        `remove it yourself (git worktree remove ${target}) once you know what it holds`,
      );
    excludeScratch(cwd);
    return {
      ok: true,
      data: {
        ...base,
        scratch: ensureScratch(target),
        head: existing.head ?? "",
        mode: resolveRef(cwd, localRef) ? "resume" : "new",
        created: false,
        notes: ["the worktree already exists; nothing was changed"],
      },
    };
  }
  const elsewhere = worktrees.find((entry) => entry.branch === localRef);
  if (elsewhere)
    return fanoutFail(
      "blocked",
      `${slice.branch} is checked out at ${elsewhere.path}: never two live workers on one branch`,
      `stop that worker, then workit fanout worktree release ${slice.id} (or git worktree remove ${elsewhere.path})`,
    );
  let dirExisted = false;
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory() || fs.readdirSync(target).length > 0)
      return fanoutFail(
        "blocked",
        `${target} exists and is ${stat.isDirectory() ? "not empty" : "not a directory"} (not a worktree of this repository)`,
        `move it away, or set slice ${slice.id}'s worktree to another path`,
      );
    dirExisted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return fanoutFail("failed", `cannot read ${target}: ${(error as Error).message}`);
  }

  const notes: string[] = [];
  let mode: CreateOutcome["mode"] = "resume";
  if (resolveRef(cwd, localRef)) {
    const added = gitRun(cwd, ["worktree", "add", target, slice.branch], SLOW);
    if (!added.ok) return worktreeFailed(added.stderr);
  } else {
    const remote = pushRemoteName(cwd) ?? "origin";
    const remoteRef = `refs/remotes/${remote}/${slice.branch}`;
    if (resolveRef(cwd, remoteRef)) {
      // The branch exists on the remote only: resume it from there.
      const added = gitRun(cwd, ["worktree", "add", "-b", slice.branch, target, remoteRef], SLOW);
      if (!added.ok) return worktreeFailed(added.stderr);
      notes.push(`resumed ${slice.branch} from ${remote}/${slice.branch}`);
    } else {
      mode = "new";
      const parent = plan.slices.find((other) => other.branch === slice.base);
      const from =
        slice.base === plan.trunk
          ? trunkRef(cwd, plan.trunk)
          : parent
            ? branchRef(cwd, parent.branch)
            : branchRef(cwd, slice.base);
      if (!from)
        return fanoutFail(
          "not_found",
          `base ${slice.base} of slice ${slice.id} does not resolve here`,
          parent
            ? `start slice ${parent.id} first (its branch ${parent.branch} is the base)`
            : `git fetch origin ${slice.base}`,
        );
      const added = gitRun(cwd, ["worktree", "add", "--detach", target, from], SLOW);
      if (!added.ok) return worktreeFailed(added.stderr);
      const branched = gitBranch(target, { name: slice.branch, base: slice.base });
      if (!branched.ok) {
        // The worktree was made by this call a moment ago and is clean.
        gitRun(cwd, ["worktree", "remove", target], SLOW);
        return fanoutFail(
          branched.code,
          `workit git branch ${slice.branch} refused: ${branched.error}`,
          branched.unblock ??
            `fix the branch name in the plan, then workit fanout worktree create ${slice.id}`,
        );
      }
      notes.push(...branched.data.notes);
    }
  }
  excludeScratch(cwd);
  const scratch = ensureScratch(target);
  const head = gitRun(target, ["rev-parse", "HEAD"]).stdout.trim();
  const baseSha = mode === "new" ? head : null;
  appendObserved(cwd, {
    type: "fanout.worktree.created",
    actor: input.actor,
    fanout: plan.name,
    slice: slice.id,
    branch: slice.branch,
    path: target,
    scratch,
    mode,
    head,
    dirExisted,
    planCreatedAt: plan.createdAt,
    ...(baseSha ? { baseSha } : {}),
  });
  return { ok: true, data: { ...base, scratch, head, mode, created: true, notes } };
}

const worktreeFailed = (stderr: string) =>
  fanoutFail(
    "failed",
    `git worktree add failed: ${stderr.trim().split("\n")[0] || "unknown error"}`,
  );

export type ReleaseOutcome = {
  fanout: string;
  slice: string;
  branch: string;
  path: string;
  head: string | null;
  /** `git status --porcelain` lines recorded before removal (the scratch dir excluded). */
  dirty: string[];
  forced: boolean;
  removed: boolean;
  /** Local commits not on the remote branch; null when it cannot tell. */
  unpushed: number | null;
  notes: string[];
};

export function releaseSliceWorktree(
  cwd: string,
  plan: FanoutFile,
  input: { slice: string; force: boolean; actor: LedgerActor },
): FanoutResult<ReleaseOutcome> {
  const found = findSlice(plan, input.slice);
  if (!found.ok) return found;
  const slice = found.data;
  const target = slicePath(cwd, slice);
  const worktrees = listWorktrees(cwd);
  const index = worktrees.findIndex((entry) => samePath(entry.path, target));
  const out: ReleaseOutcome = {
    fanout: plan.name,
    slice: slice.id,
    branch: slice.branch,
    path: target,
    head: null,
    dirty: [],
    forced: input.force,
    removed: false,
    unpushed: null,
    notes: [],
  };
  if (index < 0) {
    if (fs.existsSync(target))
      return fanoutFail(
        "blocked",
        `${target} is not a worktree of this repository; nothing was removed`,
        "remove it yourself once you know what it holds",
      );
    out.notes.push(`no worktree at ${target}; nothing to release`);
    return { ok: true, data: out };
  }
  const entry = worktrees[index];
  if (index === 0)
    return fanoutFail("blocked", `${target} is the main checkout; it is never released`);
  if (inside(cwd, entry.path))
    return fanoutFail(
      "blocked",
      `this command runs inside ${entry.path}`,
      `run it from the main checkout: workit --cwd <main checkout> fanout worktree release ${slice.id}`,
    );
  if (entry.branch !== null && entry.branch !== `refs/heads/${slice.branch}`)
    return fanoutFail(
      "blocked",
      `${entry.path} is on ${entry.branch.replace(/^refs\/heads\//u, "")}, not slice ${slice.id}'s ${slice.branch}; nothing was removed`,
    );
  const made = createdRow(cwd, plan, slice, entry.path);
  if (!made)
    return fanoutFail(
      "blocked",
      `${entry.path} was not made by workit fanout worktree create for slice ${slice.id} (no ledger row); nothing was removed`,
      `remove it yourself (git worktree remove ${entry.path}) once you know what it holds`,
    );
  out.head = entry.head;
  const status = gitRun(entry.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!status.ok)
    return fanoutFail(
      "failed",
      `git status in ${entry.path} failed: ${status.stderr.trim().split("\n")[0]}`,
      "nothing was removed; inspect the worktree by hand",
    );
  const entries = porcelainEntries(status.stdout);
  const inScratch = (line: string) => line.slice(3).startsWith(`${SCRATCH_DIR}/`);
  out.dirty = entries.filter((line) => !inScratch(line));
  out.unpushed = unpushedCount(cwd, slice.branch);
  const refused = out.dirty.length > 0 && !input.force;
  // Record first: once the worktree is gone its state cannot be read back.
  const recorded = appendObserved(cwd, {
    type: "fanout.worktree.released",
    actor: input.actor,
    fanout: plan.name,
    slice: slice.id,
    branch: slice.branch,
    path: entry.path,
    head: entry.head,
    uncommittedCount: out.dirty.length,
    uncommitted: rowSample(out.dirty),
    forced: input.force,
    outcome: refused ? "refused" : "removed",
  });
  if (!recorded.ok)
    return fanoutFail(
      "unavailable",
      `cannot record the worktree state in the ledger (${recorded.error}); nothing was removed`,
    );
  if (refused)
    return fanoutFail(
      "blocked",
      `${entry.path} has ${out.dirty.length} uncommitted change${out.dirty.length === 1 ? "" : "s"} (${out.dirty.slice(0, 3).join(", ")}${out.dirty.length > 3 ? ", …" : ""}); recorded in the ledger, nothing removed`,
      `commit them on ${slice.branch} (workit git commit), or pass --force to drop them`,
      { ...out },
    );
  const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), entry.path];
  let removed = gitRun(cwd, args, SLOW);
  if (!removed.ok && entries.some(inScratch)) {
    // The scratch dir shows as untracked (its info/exclude line was removed):
    // clear it, the only thing in the way, and try once more.
    removeScratch(entry.path);
    removed = gitRun(cwd, args, SLOW);
  }
  if (!removed.ok)
    return fanoutFail(
      "failed",
      `git worktree remove failed: ${removed.stderr.trim().split("\n")[0]}`,
      entry.locked ? `git worktree unlock ${entry.path}, then release again` : undefined,
      { ...out },
    );
  out.removed = true;
  if (made.dirExisted === true) fs.mkdirSync(entry.path, { recursive: true });
  if (out.unpushed)
    out.notes.push(`${slice.branch} is kept with ${out.unpushed} commit(s) not on the remote`);
  return { ok: true, data: out };
}

/** `XY path` entries from porcelain v1 -z (a rename's source path is folded in). */
function porcelainEntries(stdout: string): string[] {
  const fields = nulList(stdout);
  const out: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    out.push(entry);
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return out;
}

function unpushedCount(cwd: string, branch: string): number | null {
  const remote = pushRemoteName(cwd) ?? "origin";
  const local = resolveRef(cwd, `refs/heads/${branch}`);
  if (!local) return null;
  const tracking = resolveRef(cwd, `refs/remotes/${remote}/${branch}`);
  if (!tracking) return null;
  const count = gitRun(cwd, ["rev-list", "--count", `${tracking}..${local}`]);
  return count.ok ? Number(count.stdout.trim()) : null;
}

/** Remove `<worktree>/.workit-scratch` only: a symlink is unlinked, never followed. */
function removeScratch(worktree: string): void {
  const scratch = path.join(worktree, SCRATCH_DIR);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(scratch);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(scratch);
  else fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 });
}
