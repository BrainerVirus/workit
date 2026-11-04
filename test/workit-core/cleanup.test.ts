import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RELEASE_COMMAND,
  cleanupAfterMerge,
  managedWorktreeRoot,
  placeOf,
  remoteBranchGone,
  sweepWorktrees,
} from "@/packages/workit-core/src/core/cleanup";
import { readLedger } from "@/packages/workit-core/src/ledger";

// #653: nothing a finished change made stays on disk. After a merge the
// branch's clean Workit worktree and local branch go, recorded in the ledger;
// `gc --worktrees` sweeps merged leftovers. Dirty or unmerged work is kept.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const actor = { host: "cli", session: "s-1", agentId: null };

const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A repo at <root>/proj on main; the managed root under <root>/cache. */
const setup = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-sweep-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  commit(main, "a.txt", "a\n", "base");
  const env = { ...process.env, XDG_CACHE_HOME: path.join(root, "cache") };
  return { root, main, env };
};

/** A worktree at `dir` on a new `branch` from main, with `extra` committed when given. */
const worktree = (main: string, dir: string, branch: string, extra?: string) => {
  mkdirSync(path.dirname(dir), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", branch, dir, "main");
  if (extra) commit(dir, `${branch.replaceAll("/", "-")}.txt`, extra, `work on ${branch}`);
  return dir;
};

/** Make the worktree look last used two days ago. */
const age = (dir: string) => {
  const head = path.join(git(dir, "rev-parse", "--absolute-git-dir"), "HEAD");
  const then = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(head, then, then);
};

const branchExists = (main: string, branch: string) => git(main, "branch", "--list", branch) !== "";

const cleanupRows = (main: string) => {
  const ledger = readLedger(main);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "cleanup.removed");
};

test("the managed root is <cache>/workit-wt, from XDG_CACHE_HOME or HOME", () => {
  expect(managedWorktreeRoot({ XDG_CACHE_HOME: "/c" })).toBe(path.join("/c", "workit-wt"));
  expect(managedWorktreeRoot({ HOME: "/h" })).toBe(path.join("/h", ".cache", "workit-wt"));
});

test("after a merge, a clean worktree under the managed root and its branch go, and the ledger lists them", () => {
  const env = setup();
  const repoDir = path.join(managedWorktreeRoot(env.env), "proj");
  const dir = worktree(env.main, path.join(repoDir, "slice"), "feature/x", "x\n");
  const head = git(dir, "rev-parse", "HEAD");
  expect(placeOf(dir, env.env)).toBe("managed");

  const out = cleanupAfterMerge(env.main, "feature/x", head, {
    actor,
    trigger: "pr merge",
    env: env.env,
  });

  expect(out).toMatchObject({ branchDeleted: true, dirty: null, notes: [] });
  expect(path.basename(String(out.worktreeRemoved))).toBe("slice");
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(repoDir)).toBe(false);
  expect(branchExists(env.main, "feature/x")).toBe(false);
  const rows = cleanupRows(env.main);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    trigger: "pr merge",
    branch: "feature/x",
    branches: ["feature/x"],
  });
  expect(rows[0]?.worktrees).toEqual([out.worktreeRemoved]);
  expect(out.recorded).toEqual({ id: String(rows[0]?.id) });
});

test("after a merge, a dirty managed worktree is kept with its branch; the note names the paths and the release command", () => {
  const env = setup();
  const dir = worktree(
    env.main,
    path.join(managedWorktreeRoot(env.env), "proj", "slice"),
    "feature/x",
    "x\n",
  );
  const head = git(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "wip.txt"), "unsaved\n");

  const out = cleanupAfterMerge(env.main, "feature/x", head, {
    actor,
    trigger: "pr merge",
    env: env.env,
  });

  expect(out.worktreeRemoved).toBeNull();
  expect(out.branchDeleted).toBe(false);
  expect(out.dirty).toEqual({ path: dir, paths: ["wip.txt"] });
  expect(out.notes).toHaveLength(1);
  expect(out.notes[0]).toContain("wip.txt");
  expect(out.notes[0]).toContain(RELEASE_COMMAND);
  expect(existsSync(path.join(dir, "wip.txt"))).toBe(true);
  expect(branchExists(env.main, "feature/x")).toBe(true);
  expect(out.recorded).toBeNull();
  expect(cleanupRows(env.main)).toHaveLength(0);
});

test("after a merge, a worktree outside the managed root that Workit did not make is kept", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "mine"), "feature/x", "x\n");
  const out = cleanupAfterMerge(env.main, "feature/x", git(dir, "rev-parse", "HEAD"), {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out.worktreeRemoved).toBeNull();
  expect(out.notes).toEqual([expect.stringMatching(/not a Workit worktree; kept both/)]);
  expect(existsSync(dir)).toBe(true);
});

test("after a merge, a local branch with commits beyond the merged head is kept with its worktree", () => {
  const env = setup();
  const dir = worktree(
    env.main,
    path.join(managedWorktreeRoot(env.env), "proj", "slice"),
    "feature/x",
    "x\n",
  );
  const merged = git(dir, "rev-parse", "HEAD");
  commit(dir, "later.txt", "later\n", "after the merge");
  const out = cleanupAfterMerge(env.main, "feature/x", merged, {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out).toMatchObject({ branchDeleted: false, worktreeRemoved: null });
  expect(out.notes).toEqual([expect.stringMatching(/not merged; kept it/)]);
  expect(existsSync(dir)).toBe(true);
});

test("gc --worktrees lists a merged legacy <repo>-wt worktree with its size; --apply removes it, its branch and the empty -wt dir", () => {
  const env = setup();
  const legacy = path.join(env.root, "proj-wt");
  const dir = worktree(env.main, path.join(legacy, "a"), "feature/a", "a work\n");
  git(env.main, "merge", "-q", "--ff-only", "feature/a");

  const dry = sweepWorktrees(env.main, { apply: false, actor, env: env.env });
  expect(dry.removable).toHaveLength(1);
  expect(dry.removable[0]).toMatchObject({
    path: dir,
    branch: "feature/a",
    place: "legacy",
    reason: "merged",
  });
  expect(dry.removable[0]?.bytes).toBeGreaterThan(0);
  expect(dry.removed).toEqual([]);
  expect(existsSync(dir)).toBe(true);
  expect(cleanupRows(env.main)).toHaveLength(0);

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.removed).toEqual([dir]);
  expect(applied.deletedBranches).toEqual(["feature/a"]);
  expect(applied.removedDirs).toEqual([legacy]);
  expect(existsSync(legacy)).toBe(false);
  expect(branchExists(env.main, "feature/a")).toBe(false);
  expect(cleanupRows(env.main)).toEqual([
    expect.objectContaining({
      trigger: "gc --worktrees",
      worktrees: [dir],
      branches: ["feature/a"],
    }),
  ]);
});

test("gc --worktrees never lists an unmerged worktree for removal, and --apply keeps it", () => {
  const env = setup();
  const legacy = path.join(env.root, "workit-wt");
  const dir = worktree(env.main, path.join(legacy, "b"), "feature/b", "unmerged\n");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(applied.removable).toEqual([]);
  expect(applied.kept).toEqual([
    { path: dir, branch: "feature/b", reason: expect.stringMatching(/^not merged into/) },
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(branchExists(env.main, "feature/b")).toBe(true);
});

test("gc --worktrees counts a squash-merged branch as merged", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "c"), "feature/c", "c work\n");
  git(env.main, "merge", "-q", "--squash", "feature/c");
  git(env.main, "commit", "-q", "-m", "feat: c (#1)");

  const dry = sweepWorktrees(env.main, { apply: false, actor, env: env.env });

  expect(dry.removable).toEqual([expect.objectContaining({ path: dir, reason: "squash-merged" })]);
});

test("gc --worktrees keeps a merged worktree with uncommitted changes and names them", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "d"), "feature/d");
  writeFileSync(path.join(dir, "wip.txt"), "unsaved\n");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(applied.removable).toEqual([]);
  expect(applied.kept).toEqual([
    { path: dir, branch: "feature/d", reason: "1 uncommitted change (wip.txt)" },
  ]);
  expect(existsSync(path.join(dir, "wip.txt"))).toBe(true);
});

test("gc --worktrees never removes the checkout it runs in, nor the main checkout", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "here"), "feature/here");

  const applied = sweepWorktrees(dir, { apply: true, actor, env: env.env });

  expect(applied.removable).toEqual([]);
  expect(applied.kept).toEqual([
    { path: dir, branch: "feature/here", reason: "the checkout this command runs in" },
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(env.main)).toBe(true);
});

test("gc --worktrees sweeps a merged scratch worktree in the temp dir and a stale registration", () => {
  const env = setup();
  const scratch = path.join(env.root, "scratch-base");
  git(env.main, "worktree", "add", "-q", "--detach", scratch, "main");
  age(scratch);
  const stale = worktree(env.main, path.join(env.root, "proj-wt", "gone"), "feature/stale");
  rmSync(stale, { recursive: true, force: true });

  const dry = sweepWorktrees(env.main, { apply: false, actor, env: env.env });
  expect(dry.removable).toHaveLength(2);
  expect(dry.removable).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: scratch, branch: null, place: "scratch", reason: "merged" }),
      expect.objectContaining({ path: stale, reason: "stale" }),
    ]),
  );

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.removed).toEqual([scratch, stale]);
  expect(git(env.main, "worktree", "list", "--porcelain")).not.toContain(scratch);
  expect(git(env.main, "worktree", "list", "--porcelain")).not.toContain(stale);
});

test("gc --worktrees prunes a merged local branch whose remote is gone, and keeps an unmerged one", () => {
  const env = setup();
  const bare = path.join(env.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(env.main, "remote", "add", "origin", bare);
  git(env.main, "branch", "feature/g", "main");
  git(env.main, "switch", "-q", "-c", "feature/h");
  commit(env.main, "h.txt", "h\n", "unmerged h");
  git(env.main, "switch", "-q", "main");
  git(env.main, "push", "-q", "-u", "origin", "main", "feature/g", "feature/h");
  git(env.main, "push", "-q", "origin", "--delete", "feature/g", "feature/h");
  git(env.main, "fetch", "-q", "--prune", "origin");

  const dry = sweepWorktrees(env.main, { apply: false, actor, env: env.env });
  expect(dry.trunk).toBe("refs/remotes/origin/main");
  expect(dry.goneBranches).toEqual([{ name: "feature/g", reason: "merged" }]);
  expect(dry.kept).toEqual([
    {
      path: "",
      branch: "feature/h",
      reason: expect.stringMatching(/remote branch gone, but not merged/),
    },
  ]);

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.deletedBranches).toEqual(["feature/g"]);
  expect(branchExists(env.main, "feature/g")).toBe(false);
  expect(branchExists(env.main, "feature/h")).toBe(true);
});

test("remoteBranchGone is true only when the remote answers without the branch", () => {
  const env = setup();
  expect(remoteBranchGone(env.main, "feature/r")).toBe(false);
  const bare = path.join(env.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(env.main, "remote", "add", "origin", bare);
  git(env.main, "push", "-q", "origin", "main:feature/r");
  expect(remoteBranchGone(env.main, "feature/r")).toBe(false);
  git(env.main, "push", "-q", "origin", "--delete", "feature/r");
  expect(remoteBranchGone(env.main, "feature/r")).toBe(true);
});

test("gc --worktrees keeps a fresh worktree with no commits of its own (a live worker's new slice)", () => {
  const env = setup();
  const dir = worktree(
    env.main,
    path.join(managedWorktreeRoot(env.env), "proj", "fresh"),
    "feature/fresh",
  );

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(applied.removable).toEqual([]);
  expect(applied.kept).toEqual([
    {
      path: dir,
      branch: "feature/fresh",
      reason: "no commits of its own and used in the last 24 hours",
    },
  ]);
  expect(existsSync(dir)).toBe(true);

  age(dir);
  const later = sweepWorktrees(env.main, { apply: false, actor, env: env.env });
  expect(later.removable).toEqual([expect.objectContaining({ path: dir, reason: "merged" })]);
});
