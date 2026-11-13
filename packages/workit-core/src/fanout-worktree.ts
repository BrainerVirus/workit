// `workit fanout worktree create|release <slice>` (G4): deterministic worktrees
// for hosts without native worktree isolation (OpenCode, Codex, Cursor, Pi).
//
// create: the slice's worktree at its planned path. A new slice starts
// detached at its planned base and gets its branch through `workit git
// branch` (core gitBranch: branch policy, release tracks); an existing branch
// (MODE: resume) is checked out as it is. It also makes the worker's scratch
// dir outside the working tree, `<state>/scratch/<repo dir>/<slice>` (0700),
// so no repo tool (Prettier, ESLint, Jest) ever scans it and no repo has to
// ignore a Workit file, and records `fanout.worktree.created`. Judges'
// probes stay in `<worktree>/.workit-scratch`, hidden from git through the
// repository's info/exclude (hooks/worktree-confine.ts).
//
// release: records `git status` of the worktree in the ledger first
// (`fanout.worktree.released`), refuses while it has uncommitted changes
// unless forced, then runs `git worktree remove` (which takes an in-tree
// `.workit-scratch` with it) and removes the worker's out-of-tree scratch
// dir. The branch is kept. It only removes a worktree that `create` made
// for this fanout, slice and path, on the slice's branch or detached; never
// the main checkout, the one the command runs in, or a worktree someone else
// made there, not even with --force. "Made by create" is exact: create writes
// a random token into git's admin dir for the worktree
// (`.git/worktrees/<id>/workit-fanout-token`) and records it with the admin
// dir's id and inode; release and adopt need all three to match. A worktree
// removed by hand and re-added at the path gets a new admin dir without the
// token, on any filesystem (no birth time needed). A row from before the
// token is matched by time only, so release refuses --force for it. An empty
// directory that existed before `create` is left in place.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitBranch } from "./git/ops";
import { GIT_TIMEOUTS, gitCommonDir, pushRemoteName, resolveRef } from "./git/rev";
import type { ResolvedForge } from "./forge/resolve";
import { appendObserved, readLedger, type LedgerActor } from "./ledger";
import { detectLanding, forgeBreaker, sliceStart } from "./fanout-landed";
import { recordSliceStack } from "./fanout-stack";
import { FANOUT_TOKEN_FILE } from "./hooks/worktree-confine";
import { linkWorktreeDependencies, type LinkedDependencies } from "./worktree-deps";
import { stateDir } from "./core/workit-paths.mjs";
import {
  branchRef,
  fanoutFail,
  gitRun,
  mainCheckout,
  nulList,
  trunkRef,
  worktreeRoot,
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

export type WorktreeEntry = {
  path: string;
  head: string | null;
  /** refs/heads/<name>, or null when detached. */
  branch: string | null;
  locked: boolean;
  /** git would prune it: its directory is gone. */
  prunable: boolean;
};

const canonical = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

export const samePath = (a: string, b: string): boolean => {
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
export function listWorktrees(cwd: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of gitRun(cwd, ["worktree", "list", "--porcelain", "-z"]).stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = {
        path: field.slice(9),
        head: null,
        branch: null,
        locked: false,
        prunable: false,
      };
      out.push(current);
    } else if (!current) continue;
    else if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field.startsWith("branch ")) current.branch = field.slice(7);
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
  }
  return out;
}

/** The slice's worktree path: absolute since plan time; an older relative one is the main checkout's. */
export const slicePath = (cwd: string, slice: Slice): string =>
  path.isAbsolute(slice.worktree)
    ? slice.worktree
    : path.resolve(mainCheckout(cwd), slice.worktree);

/** Timestamps of the admin dir and the ledger have second granularity on some filesystems. */
const CLOCK_SLACK_MS = 2000;

/**
 * The live `fanout.worktree.created` row for this fanout, slice and path:
 * the newest one, unless a later release removed that worktree (a row is
 * void once its worktree is gone), and only while the worktree at the path
 * is the one it recorded. `exact`: the admin dir's token, id and inode match
 * the row. A row without a token (written before it) matches when the admin
 * dir is no older than the row, which a re-added worktree also passes, so it
 * is never exact. Anything else is someone else's worktree.
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
  const admin = adminDir(target);
  if (!admin) return null;
  if (typeof row.adminToken === "string")
    return row.adminToken === admin.token && row.adminId === admin.id && row.adminIno === admin.ino
      ? { row, exact: true }
      : null;
  const made = admin.birthMs ?? admin.mtimeMs;
  if (made + CLOCK_SLACK_MS < Date.parse(row.at)) return null;
  return { row, exact: false };
}

/** The filesystem calls identity relies on; tests stub them. */
export const worktreeDeps = {
  stat: (file: string): fs.BigIntStats => fs.statSync(file, { bigint: true }),
};

type AdminDir = {
  path: string;
  /** `<id>` of `.git/worktrees/<id>`. */
  id: string;
  ino: string;
  /** The token create wrote there, or null. */
  token: string | null;
  birthMs: number | null;
  mtimeMs: number;
};

/** Git's admin dir for the worktree: what tells this worktree from a later one at the path. */
function adminDir(worktree: string): AdminDir | null {
  const dir = gitRun(worktree, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return null;
  const file = dir.stdout.trim();
  let token: string | null = null;
  try {
    token = fs.readFileSync(path.join(file, FANOUT_TOKEN_FILE), "utf8").trim() || null;
  } catch {
    token = null;
  }
  try {
    const stat = worktreeDeps.stat(file);
    return {
      path: file,
      id: path.basename(file),
      ino: stat.ino.toString(),
      token,
      birthMs: stat.birthtimeNs > 0n ? Number(stat.birthtimeMs) : null,
      mtimeMs: Number(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

/** Mark the admin dir of a worktree create just made; null when it cannot. */
function markAdminDir(worktree: string): (AdminDir & { token: string }) | null {
  const admin = adminDir(worktree);
  if (!admin) return null;
  const token = randomBytes(16).toString("hex");
  try {
    fs.writeFileSync(path.join(admin.path, FANOUT_TOKEN_FILE), `${token}\n`);
  } catch {
    return null;
  }
  return { ...admin, token };
}

export function findSlice(plan: FanoutFile, id: string): FanoutResult<Slice> {
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
export function excludeScratch(cwd: string): void {
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
  /** node_modules linked from the main checkout (worktree-deps.ts); null when none were. */
  dependencies: LinkedDependencies | null;
  /** The install command to run in the worktree when its lockfile differs from the main checkout's. */
  install: string | null;
  /** The `workit stack` this slice was recorded in when it started on its parent slice's branch. */
  stack: { name: string; slices: string[] } | null;
  notes: string[];
};

/** Lockfiles in the order a package manager is picked, with its frozen install for a directory. */
const LOCKFILES: ReadonlyArray<[string, (dir: string) => string]> = [
  ["bun.lock", (dir) => `bun install --frozen-lockfile --cwd ${dir}`],
  ["bun.lockb", (dir) => `bun install --frozen-lockfile --cwd ${dir}`],
  ["pnpm-lock.yaml", (dir) => `pnpm install --frozen-lockfile --dir ${dir}`],
  ["yarn.lock", (dir) => `yarn install --frozen-lockfile --cwd ${dir}`],
  ["package-lock.json", (dir) => `npm ci --prefix ${dir}`],
];

/** Equal content once CRLF is read as LF (git's autocrlf rewrites checkouts). */
const sameText = (a: Buffer, b: Buffer): boolean =>
  a.equals(b) ||
  a.toString("utf8").replaceAll("\r\n", "\n") === b.toString("utf8").replaceAll("\r\n", "\n");

const readBytes = (file: string): Buffer | null => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Link the main checkout's node_modules into `worktree` only when every
 * lockfile is identical in both (line endings aside: a Windows checkout with
 * core.autocrlf writes the worktree's copy with CRLF): a stale main checkout would otherwise
 * hand the worktree the wrong dependency versions (#426). When one differs,
 * nothing is linked and `install` is the command the worker runs instead. The
 * same holds when the main checkout's install is older than its bun.lock.
 */
function worktreeDependencies(
  main: string,
  worktree: string,
): {
  linked: LinkedDependencies | null;
  install: string | null;
  notes: string[];
} {
  for (const [name, install] of LOCKFILES) {
    const ours = readBytes(path.join(main, name));
    const theirs = readBytes(path.join(worktree, name));
    if (ours === null && theirs === null) continue;
    if (ours !== null && theirs !== null && sameText(ours, theirs)) continue;
    if (fs.existsSync(path.join(worktree, "node_modules"))) break;
    const command = install(worktree);
    return {
      linked: null,
      install: command,
      notes: [
        `${name} differs from the main checkout's (${main}), so its node_modules was not linked; install dependencies first: ${command}`,
      ],
    };
  }
  const stale = staleBunInstall(main);
  if (stale && !fs.existsSync(path.join(worktree, "node_modules"))) {
    const command = `bun install --frozen-lockfile --cwd ${worktree}`;
    return {
      linked: null,
      install: command,
      notes: [
        `the main checkout's node_modules (${main}) do not match its bun.lock (${stale}), so they were not linked; install dependencies first: ${command}`,
      ],
    };
  }
  return { ...linkWorktreeDependencies(main, worktree), install: null };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keysOf = (value: unknown): string[] => (isObject(value) ? Object.keys(value) : []);

/** A bun.lock `os`/`cpu` field (`"none"`, a name, a list, `!name`) excludes `current`. */
function excludes(field: unknown, current: string): boolean {
  const values = typeof field === "string" ? [field] : Array.isArray(field) ? field : null;
  if (!values?.length) return false;
  const names = values.filter((value): value is string => typeof value === "string");
  if (names.includes("none")) return true;
  if (names.includes(`!${current}`)) return true;
  const allowed = names.filter((name) => !name.startsWith("!"));
  return allowed.length > 0 && !allowed.includes(current);
}

/**
 * The bun.lock packages an install may leave out on this machine (W2.14):
 * one whose `os`/`cpu` excludes this platform, and one reached only from such
 * packages or as a peer (`@emnapi/*` under a wasm32 binding). This
 * platform's own optional binding stays required, and so does a package
 * nothing names, so a stale install is still caught.
 */
function optionalOnly(
  packages: Record<string, unknown>,
  workspaces: Record<string, unknown>,
): Set<string> {
  const meta = (key: string): Record<string, unknown> => {
    const entry = packages[key];
    return Array.isArray(entry) && isObject(entry[2]) ? entry[2] : {};
  };
  const resolve = (from: string | null, name: string): string =>
    from !== null && `${from}/${name}` in packages ? `${from}/${name}` : name;
  const optional = new Set<string>();
  for (const key of Object.keys(packages)) {
    const info = meta(key);
    if (excludes(info.os, process.platform) || excludes(info.cpu, process.arch)) optional.add(key);
  }
  // Required edges: what workspaces and installed packages depend on outright.
  const required = new Set<string>();
  for (const workspace of Object.values(workspaces))
    for (const field of ["dependencies", "devDependencies"])
      for (const name of keysOf(isObject(workspace) ? workspace[field] : null))
        required.add(resolve(null, name));
  // Walk from the roots through what bun installs here: dependencies and
  // optional dependencies, never into a package for another platform.
  const queue = [...required];
  const reached = new Set<string>();
  while (queue.length) {
    const key = queue.pop() as string;
    if (reached.has(key) || optional.has(key) || !(key in packages)) continue;
    reached.add(key);
    for (const field of ["dependencies", "optionalDependencies"])
      for (const name of keysOf(meta(key)[field])) queue.push(resolve(key, name));
  }
  const named = new Set<string>();
  for (const key of Object.keys(packages)) {
    const info = meta(key);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
      for (const name of keysOf(info[field])) named.add(resolve(key, name));
  }
  for (const workspace of Object.values(workspaces))
    if (isObject(workspace))
      for (const field of ["optionalDependencies", "peerDependencies"])
        for (const name of keysOf(workspace[field])) named.add(resolve(null, name));
  for (const key of named) if (!reached.has(key) && !required.has(key)) optional.add(key);
  return optional;
}

/** Packages checked against node_modules at most (a lockfile is read whole once). */
const STALE_SCAN = 5000;

/**
 * Why the main checkout's node_modules were installed for another bun.lock
 * (#493), or null when every top-level package bun.lock pins is installed at
 * its version. Bun keeps no install marker, so the installed package.json
 * versions are the record: a checkout fast-forwarded without `bun install`
 * shows here even though its lockfile equals the worktree's.
 */
function staleBunInstall(main: string): string | null {
  if (!fs.existsSync(path.join(main, "node_modules"))) return null;
  const text = readBytes(path.join(main, "bun.lock"))?.toString("utf8");
  if (!text) return null;
  let packages: Record<string, unknown>;
  let parsedWorkspaces: Record<string, unknown>;
  try {
    // bun.lock is JSON with trailing commas.
    const parsed = JSON.parse(text.replace(/,(\s*[}\]])/gu, "$1")) as {
      packages?: unknown;
      workspaces?: unknown;
    };
    if (!parsed.packages || typeof parsed.packages !== "object") return null;
    packages = parsed.packages as Record<string, unknown>;
    parsedWorkspaces = isObject(parsed.workspaces) ? parsed.workspaces : {};
  } catch {
    return null;
  }
  const optional = optionalOnly(packages, parsedWorkspaces);
  const problems: string[] = [];
  let scanned = 0;
  for (const [key, entry] of Object.entries(packages)) {
    if (scanned++ >= STALE_SCAN || problems.length >= 3) break;
    const spec = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : null;
    if (!spec) continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    // Only hoisted packages under their own name, at a registry version.
    if (name !== key || version.includes(":")) continue;
    const manifest = readBytes(path.join(main, "node_modules", key, "package.json"));
    if (!manifest) {
      // bun skips an optional dependency for another platform (W2.14).
      if (!optional.has(key)) problems.push(`${key} missing`);
      continue;
    }
    let installed: unknown;
    try {
      installed = (JSON.parse(manifest.toString("utf8")) as { version?: unknown }).version;
    } catch {
      installed = null;
    }
    if (installed !== version)
      problems.push(`${key} ${String(installed ?? "?")} installed, bun.lock has ${version}`);
  }
  return problems.length ? problems.join("; ") : null;
}

/**
 * `<state>/scratch`: the workers' scratch dirs. Beside the managed worktrees,
 * never inside `<state>/worktrees` (gc and cleanup expect only checkouts there).
 */
export const scratchRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(stateDir(env), "scratch");

/**
 * A worker's scratch dir, outside every working tree so no repo tool scans it:
 * `<state>/scratch/<repo dir>/<worker>`, where the repo dir is the managed
 * worktree root's name (`<repo>` or `<repo>-<hash>`) and the worker is the
 * slice id (`<slice>+try<n>` for a race attempt).
 */
export const workerScratch = (
  cwd: string,
  worker: string,
  env: NodeJS.ProcessEnv = process.env,
): string => path.join(scratchRoot(env), path.basename(worktreeRoot(cwd, env)), worker);

const underRoot = (dir: string, root: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** `dir` names a place under the scratch root (whatever is there now). */
export const isWorkerScratch = (dir: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  underRoot(dir, scratchRoot(env));

/**
 * Why `dir` cannot be this user's scratch dir, or null: it must sit under the
 * scratch root through real directories only (no symlink on the way) and,
 * where it exists, be made of directories this user owns.
 */
function scratchProblem(dir: string, env: NodeJS.ProcessEnv): string | null {
  const root = path.resolve(scratchRoot(env));
  const target = path.resolve(dir);
  if (!underRoot(target, root)) return `${dir} is not under ${root}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (let probe = target; ; probe = path.dirname(probe)) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return `cannot read ${probe}: ${(error as Error).message}`;
    }
    if (stat?.isSymbolicLink()) return `${probe} is a symlink`;
    if (stat && !stat.isDirectory()) return `${probe} is not a directory`;
    if (stat && uid !== null && stat.uid !== uid) return `${probe} belongs to another user`;
    if (probe === root) return null;
  }
}

const scratchBlocked = (problem: Error) =>
  fanoutFail(
    "blocked",
    `the worker scratch dir is not safe to use: ${problem.message}`,
    "move that path away (Workit makes it as a real directory this user owns), then run create again",
  );

/** Make the worker's scratch dir (mode 0700); an Error when its place is not safe to use. */
function ensureScratch(dir: string): string | Error {
  const problem = scratchProblem(dir, process.env);
  if (problem) return new Error(problem);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * The worker scratch dirs of the worktree at `worktree`: the one its default
 * place names, and those `create` recorded for it (its
 * `fanout.worktree.created` rows), under the scratch root only. An old
 * in-tree `.workit-scratch` is not one of them: it goes with the worktree.
 */
export function workerScratchesOf(
  cwd: string,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const root = scratchRoot(env);
  const out = new Set<string>();
  // A slice's default place, `<worktree root>/<slice>`, maps to its scratch by name.
  if (samePath(path.dirname(worktree), worktreeRoot(cwd, env)))
    out.add(workerScratch(cwd, path.basename(worktree), env));
  const ledger = readLedger(cwd);
  for (const row of ledger.ok ? ledger.value.rows : [])
    if (
      row.type === "fanout.worktree.created" &&
      typeof row.scratch === "string" &&
      typeof row.path === "string" &&
      underRoot(row.scratch, root) &&
      samePath(row.path, worktree)
    )
      out.add(row.scratch);
  return [...out];
}

/**
 * Remove a worker's out-of-tree scratch dir: only a real directory this user
 * owns under the scratch root, reached through no symlink (rm unlinks a
 * symlink inside it, never follows one). Its repo dir goes too once empty.
 * True when it was removed.
 */
export function removeWorkerScratch(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (scratchProblem(dir, env) || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  const parent = path.dirname(path.resolve(dir));
  if (parent !== path.resolve(scratchRoot(env)))
    try {
      fs.rmdirSync(parent);
    } catch {
      // Another worker's scratch is still there.
    }
  return true;
}

export function createSliceWorktree(
  cwd: string,
  plan: FanoutFile,
  input: {
    slice: string;
    actor: LedgerActor;
    /** The forge for landing lookups (a dependency merged by squash); asked only when needed. */
    forge?: () => ResolvedForge | null;
  },
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
  const scratch = workerScratch(cwd, slice.id);
  const unsafe = scratchProblem(scratch, process.env);
  if (unsafe) return scratchBlocked(new Error(unsafe));
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
    const kept = ensureScratch(scratch);
    if (kept instanceof Error) return scratchBlocked(kept);
    const deps = worktreeDependencies(mainCheckout(cwd), target);
    return {
      ok: true,
      data: {
        ...base,
        scratch,
        head: existing.head ?? "",
        mode: resolveRef(cwd, localRef) ? "resume" : "new",
        created: false,
        dependencies: deps.linked,
        install: deps.install,
        stack: null,
        notes: [
          deps.linked
            ? "the worktree already exists; only its missing dependencies were linked"
            : "the worktree already exists; nothing was changed",
          ...deps.notes,
        ],
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

  const landed = landedBranch(cwd, plan, slice, input.forge);
  if (landed) return landed;
  const notes: string[] = [];
  let mode: CreateOutcome["mode"] = "resume";
  let stack: CreateOutcome["stack"] = null;
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
      const landedOn = dependenciesLanded(cwd, plan, slice, input.forge);
      if (landedOn) {
        base.base = plan.trunk;
        notes.push(landedOn);
      }
      const parent = landedOn
        ? undefined
        : plan.slices.find((other) => other.branch === slice.base);
      const from =
        base.base === plan.trunk
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
      const branched = gitBranch(target, {
        name: slice.branch,
        base: base.base,
      });
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
      if (parent) {
        const recorded = recordSliceStack(cwd, plan, slice);
        if (recorded?.ok) {
          stack = { name: recorded.name, slices: recorded.slices };
          notes.push(
            `stacked on ${parent.id}: stack ${recorded.name} is ${recorded.slices.join(" -> ")}; once ${parent.branch} merges (a squash too), workit stack sync --name ${recorded.name} rebases ${slice.branch} onto ${plan.trunk} without ${parent.id}'s commits`,
          );
        } else if (recorded) notes.push(`${recorded.error}; record it with: ${recorded.unblock}`);
      }
    }
  }
  excludeScratch(cwd);
  const made = ensureScratch(scratch);
  if (made instanceof Error) return scratchBlocked(made);
  const deps = worktreeDependencies(mainCheckout(cwd), target);
  notes.push(...deps.notes);
  const head = gitRun(target, ["rev-parse", "HEAD"]).stdout.trim();
  const baseSha = mode === "new" ? head : null;
  const admin = markAdminDir(target);
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
    sliceHash: slice.hash,
    ...(admin ? { adminId: admin.id, adminIno: admin.ino, adminToken: admin.token } : {}),
    ...(baseSha ? { baseSha } : {}),
    ...(base.base === slice.base ? {} : { startBase: base.base }),
    ...(deps.install ? { install: deps.install } : {}),
    ...(stack ? { stack: stack.name } : {}),
  });
  return {
    ok: true,
    data: {
      ...base,
      scratch,
      head,
      mode,
      created: true,
      dependencies: deps.linked,
      install: deps.install,
      stack,
      notes,
    },
  };
}

/**
 * When every slice this one depends on has landed (a squash merge leaves the
 * dependency branch at its pre-squash tip), the note saying so: the new
 * branch then starts from the trunk. Null while any dependency is open.
 */
function dependenciesLanded(
  cwd: string,
  plan: FanoutFile,
  slice: Slice,
  forge: (() => ResolvedForge | null) | undefined,
): string | null {
  if (slice.base === plan.trunk || slice.dependsOn.length === 0) return null;
  const deps = slice.dependsOn.map((id) => plan.slices.find((other) => other.id === id));
  if (deps.some((dep) => !dep)) return null;
  const trunk = trunkRef(cwd, plan.trunk);
  if (!trunk) return null;
  const ledger = readLedger(cwd);
  const rows = ledger.ok ? ledger.value.rows : [];
  const ctx = { cwd, trunk, forge: forgeBreaker(forge?.() ?? null).forge };
  const landed: string[] = [];
  for (const dep of deps as Slice[]) {
    const landing = detectLanding(ctx, dep, {
      head: branchRef(cwd, dep.branch),
      createdFrom: sliceStart(cwd, rows, plan.name, dep),
      parentHead: null,
      fanout: plan.name,
      since: dep.hashSince || plan.createdAt || null,
      sliceHash: dep.hash || null,
      rows,
    });
    if (!landing.landed) return null;
    landed.push(
      `${dep.branch} landed (${landing.how ?? "pr_merged"}${landing.pr ? ` #${landing.pr.number}` : ""})`,
    );
  }
  return `${landed.join(", ")}: started from ${plan.trunk}, not from ${slice.base}'s pre-merge tip`;
}

/**
 * An existing slice branch (local or remote) that already landed, by its
 * merged PR or git's trunk and squash checks, is old work under a reused
 * name: refused, naming the first free `<branch>-<n>`. A branch with commits
 * newer than its merged head is not landed and is resumed.
 */
function landedBranch(
  cwd: string,
  plan: FanoutFile,
  slice: Slice,
  forge: (() => ResolvedForge | null) | undefined,
): FanoutResult<never> | null {
  const head = branchRef(cwd, slice.branch);
  const trunk = trunkRef(cwd, plan.trunk);
  if (!head || !trunk) return null;
  const ledger = readLedger(cwd);
  const rows = ledger.ok ? ledger.value.rows : [];
  const landing = detectLanding(
    { cwd, trunk, forge: forgeBreaker(forge?.() ?? null).forge },
    slice,
    {
      head,
      createdFrom: sliceStart(cwd, rows, plan.name, slice),
      parentHead: null,
      fanout: plan.name,
      since: slice.hashSince || plan.createdAt || null,
      sliceHash: slice.hash || null,
      rows,
    },
  );
  if (!landing.landed) return null;
  let free = `${slice.branch}-2`;
  for (let n = 3; branchRef(cwd, free); n++) free = `${slice.branch}-${n}`;
  const how = landing.pr ? `PR #${landing.pr.number} merged` : `landed (${landing.how})`;
  return fanoutFail(
    "blocked",
    `${slice.branch} already ${how} on ${plan.trunk}: a slice never reuses a landed branch`,
    `set slice ${slice.id}'s branch to ${free} in the plan, then workit fanout plan <plan.json> and workit fanout worktree create ${slice.id}`,
    { branch: slice.branch, landed: landing.how, pr: landing.pr?.number ?? null, freeBranch: free },
  );
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
  /** The worker's out-of-tree scratch dirs removed with the worktree. */
  scratch: string[];
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
    scratch: [],
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
      `run it from the main checkout: workit fanout --cwd <main checkout> worktree release ${slice.id}`,
    );
  if (entry.branch !== null && entry.branch !== `refs/heads/${slice.branch}`)
    return fanoutFail(
      "blocked",
      `${entry.path} is on ${entry.branch.replace(/^refs\/heads\//u, "")}, not slice ${slice.id}'s ${slice.branch}; nothing was removed`,
    );
  const owned = createdRow(cwd, plan, slice, entry.path);
  if (!owned)
    return fanoutFail(
      "blocked",
      `${entry.path} was not made by workit fanout worktree create for slice ${slice.id} (no ledger row); nothing was removed`,
      `remove it yourself (git worktree remove ${entry.path}) once you know what it holds`,
    );
  if (input.force && !owned.exact)
    return fanoutFail(
      "blocked",
      `${entry.path} was created before workit recorded worktree identity, so it cannot be told from a worktree someone re-added there; --force is refused and nothing was removed`,
      `release it without --force, or remove it yourself (git worktree remove ${entry.path}) once you know what it holds`,
    );
  const made = owned.row;
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
  const scratches = workerScratchesOf(cwd, entry.path);
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
  out.scratch = scratches.filter((dir) => removeWorkerScratch(dir));
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
