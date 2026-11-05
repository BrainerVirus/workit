import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
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
import { loadCheckConfig } from "@/packages/workit-core/src/check-config";
import {
  RELEASE_COMMAND,
  cleanupAfterMerge,
  managedWorktreeRoot,
  managedWorktreeRoots,
  placeOf,
  remoteBranchGone,
  sweepWorktrees,
} from "@/packages/workit-core/src/core/cleanup";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { spawnHeavyTimeout } from "@/test/shared/timeouts";

// #653: nothing a finished change made stays on disk. After a merge the
// branch's clean Workit worktree and local branch go, recorded in the ledger;
// `gc --worktrees` sweeps merged leftovers. Dirty or unmerged work is kept.

// Each test builds one or more git repos and worktrees.
setDefaultTimeout(spawnHeavyTimeout());

// On Windows a git child that just exited can still hold a handle in the repo
// for a moment, so the first rm fails EBUSY (2026-11-04, #415); rmSync retries.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * A path in one comparable form: git prints `/` and long names, while a
 * Windows temp dir may come back as an 8.3 short name with `\`.
 */
const key = (target: string): string => {
  let real: string;
  try {
    real = realpathSync.native(target);
  } catch {
    real = path.resolve(target);
  }
  const slashed = real.replaceAll("\\", "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};

/** `value` with every absolute path string in `key` form. */
const norm = (value: unknown): unknown => {
  if (typeof value === "string") return path.isAbsolute(value) ? key(value) : value;
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, norm(inner)]));
  return value;
};

const actor = { host: "cli", session: "s-1", agentId: null };

const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** A repo at <root>/proj on main; the managed root under <root>/state, the pre-move one under <root>/cache. */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-sweep-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(path.join(main, ".gitignore"), ".env\nnode_modules/\n.workit-scratch/\n");
  commit(main, "a.txt", "a\n", "base");
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    WORKIT_STATE_DIR: path.join(root, "state"),
  };
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

test("the managed root is <state>/worktrees; the pre-move <cache>/workit-wt is still a managed root", () => {
  expect(managedWorktreeRoot({ WORKIT_STATE_DIR: "/s" })).toBe(path.join("/s", "worktrees"));
  expect(managedWorktreeRoots({ WORKIT_STATE_DIR: "/s", XDG_CACHE_HOME: "/c" })).toEqual([
    path.join("/s", "worktrees"),
    path.join("/c", "workit-wt"),
  ]);
  expect(managedWorktreeRoots({ WORKIT_STATE_DIR: "/s", HOME: "/h" })[1]).toBe(
    path.join("/h", ".cache", "workit-wt"),
  );
});

test("Given merged clean worktrees under both managed roots, When gc --worktrees --apply, Then both go; an unmerged or dirty one in either root stays", () => {
  const env = setup();
  const [current, old] = managedWorktreeRoots(env.env) as [string, string];
  const done = [
    worktree(env.main, path.join(current, "proj", "a"), "feature/a", "a\n"),
    worktree(env.main, path.join(old, "proj", "b"), "feature/b", "b\n"),
  ];
  for (const branch of ["feature/a", "feature/b"])
    git(env.main, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
  const dirty = [
    worktree(env.main, path.join(current, "proj", "c"), "feature/c", "c\n"),
    worktree(env.main, path.join(old, "proj", "d"), "feature/d", "d\n"),
  ];
  git(env.main, "merge", "-q", "--no-ff", "-m", "merge c", "feature/c");
  git(env.main, "merge", "-q", "--no-ff", "-m", "merge d", "feature/d");
  for (const dir of dirty) writeFileSync(path.join(dir, "wip.txt"), "unsaved\n");
  const unmerged = [
    worktree(env.main, path.join(current, "proj", "e"), "feature/e", "e\n"),
    worktree(env.main, path.join(old, "proj", "f"), "feature/f", "f\n"),
  ];
  for (const dir of [...done, ...dirty, ...unmerged]) expect(placeOf(dir, env.env)).toBe("managed");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(applied.removed.map(key).toSorted()).toEqual(done.map(key).toSorted());
  for (const dir of done) expect(existsSync(dir)).toBe(false);
  for (const dir of [...dirty, ...unmerged]) expect(existsSync(dir)).toBe(true);
  expect(norm(applied.kept)).toEqual(
    expect.arrayContaining([
      ...dirty.map((dir) =>
        expect.objectContaining({ path: key(dir), reason: expect.stringContaining("wip.txt") }),
      ),
      ...unmerged.map((dir) =>
        expect.objectContaining({ path: key(dir), reason: expect.stringMatching(/^not merged/) }),
      ),
    ]),
  );
});

test("gc --worktrees --apply removes the pre-move root once its last worktree is gone", () => {
  const env = setup();
  const old = managedWorktreeRoots(env.env)[1];
  const dir = worktree(env.main, path.join(old, "proj", "a"), "feature/a", "a\n");
  git(env.main, "merge", "-q", "--ff-only", "feature/a");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(norm(applied.removed)).toEqual([key(dir)]);
  expect(norm(applied.removedDirs)).toEqual([key(path.join(old, "proj"))]);
  expect(existsSync(old)).toBe(false);
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
  expect(norm(out.dirty)).toEqual({ path: key(dir), paths: ["wip.txt"] });
  expect(out.notes).toHaveLength(1);
  expect(out.notes[0]).toContain("wip.txt");
  expect(out.notes[0]).toContain(RELEASE_COMMAND);
  expect(existsSync(path.join(dir, "wip.txt"))).toBe(true);
  expect(branchExists(env.main, "feature/x")).toBe(true);
  expect(out.recorded).toBeNull();
  expect(norm(cleanupRows(env.main))).toHaveLength(0);
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
  expect(norm(dry.removable)).toHaveLength(1);
  expect(norm(dry.removable[0])).toMatchObject({
    path: key(dir),
    branch: "feature/a",
    place: "legacy",
    reason: "merged",
  });
  expect(dry.removable[0]?.bytes).toBeGreaterThan(0);
  expect(dry.removed).toEqual([]);
  expect(existsSync(dir)).toBe(true);
  expect(norm(cleanupRows(env.main))).toHaveLength(0);

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(norm(applied.removed)).toEqual([key(dir)]);
  expect(norm(applied.deletedBranches)).toEqual(["feature/a"]);
  expect(norm(applied.removedDirs)).toEqual([key(legacy)]);
  expect(existsSync(legacy)).toBe(false);
  expect(branchExists(env.main, "feature/a")).toBe(false);
  expect(norm(cleanupRows(env.main))).toEqual([
    expect.objectContaining({
      trigger: "gc --worktrees",
      worktrees: [key(dir)],
      branches: ["feature/a"],
    }),
  ]);
});

test("gc --worktrees never lists an unmerged worktree for removal, and --apply keeps it", () => {
  const env = setup();
  const legacy = path.join(env.root, "workit-wt");
  const dir = worktree(env.main, path.join(legacy, "b"), "feature/b", "unmerged\n");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(norm(applied.removable)).toEqual([]);
  expect(norm(applied.kept)).toEqual([
    { path: key(dir), branch: "feature/b", reason: expect.stringMatching(/^not merged into/) },
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

  expect(norm(dry.removable)).toEqual([
    expect.objectContaining({ path: key(dir), reason: "squash-merged" }),
  ]);
});

test("gc --worktrees keeps a merged worktree with uncommitted changes and names them", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "d"), "feature/d");
  writeFileSync(path.join(dir, "wip.txt"), "unsaved\n");

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(norm(applied.removable)).toEqual([]);
  expect(norm(applied.kept)).toEqual([
    { path: key(dir), branch: "feature/d", reason: "1 uncommitted change (wip.txt)" },
  ]);
  expect(existsSync(path.join(dir, "wip.txt"))).toBe(true);
});

test("gc --worktrees never removes the checkout it runs in, nor the main checkout", () => {
  const env = setup();
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "here"), "feature/here");

  const applied = sweepWorktrees(dir, { apply: true, actor, env: env.env });

  expect(norm(applied.removable)).toEqual([]);
  expect(norm(applied.kept)).toEqual([
    { path: key(dir), branch: "feature/here", reason: "the checkout this command runs in" },
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
  expect(norm(dry.removable)).toHaveLength(2);
  expect(norm(dry.removable)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: key(scratch),
        branch: null,
        place: "scratch",
        reason: "merged",
      }),
      expect.objectContaining({ path: key(stale), reason: "stale" }),
    ]),
  );

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(norm(applied.removed)).toEqual([key(scratch), key(stale)]);
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
  expect(norm(dry.kept)).toEqual([
    {
      path: "",
      branch: "feature/h",
      reason: expect.stringMatching(/remote branch gone, but not merged/),
    },
  ]);

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(norm(applied.deletedBranches)).toEqual(["feature/g"]);
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

  expect(norm(applied.removable)).toEqual([]);
  expect(norm(applied.kept)).toEqual([
    {
      path: key(dir),
      branch: "feature/fresh",
      reason: "no commits of its own and used in the last 24 hours",
    },
  ]);
  expect(existsSync(dir)).toBe(true);

  age(dir);
  const later = sweepWorktrees(env.main, { apply: false, actor, env: env.env });
  expect(norm(later.removable)).toEqual([
    expect.objectContaining({ path: key(dir), reason: "merged" }),
  ]);
});

/** Write `files` (relative path → text) into the worktree, creating directories. */
const put = (dir: string, files: string[]) => {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "x\n");
  }
};

const IGNORED_CASES = [
  { name: "only .env", files: [".env"], kept: [".env"] },
  {
    name: "only node_modules and the scratch dir",
    files: ["node_modules/x/i.js", ".workit-scratch/y"],
    kept: null,
  },
  {
    name: ".env beside node_modules and the scratch dir",
    files: [".env", "node_modules/x/i.js", ".workit-scratch/y"],
    kept: [".env"],
  },
] as const;

for (const item of IGNORED_CASES)
  test(`after a merge, a managed worktree holding ${item.name} (gitignored) is ${item.kept ? "kept and named" : "removed"}`, () => {
    const env = setup();
    const dir = worktree(
      env.main,
      path.join(managedWorktreeRoot(env.env), "proj", "slice"),
      "feature/x",
      "x\n",
    );
    put(dir, [...item.files]);

    const out = cleanupAfterMerge(env.main, "feature/x", git(dir, "rev-parse", "HEAD"), {
      actor,
      trigger: "pr merge",
      env: env.env,
    });

    if (item.kept) {
      expect(out).toMatchObject({ worktreeRemoved: null, branchDeleted: false });
      expect(norm(out.dirty)).toEqual({ path: key(dir), paths: [...item.kept] });
      expect(out.notes).toEqual([
        expect.stringContaining("ignored files that are not regenerable (.env)"),
      ]);
      expect(out.notes[0]).not.toContain("node_modules");
      expect(existsSync(path.join(dir, ".env"))).toBe(true);
    } else {
      expect(out).toMatchObject({ branchDeleted: true, dirty: null, notes: [] });
      expect(existsSync(dir)).toBe(false);
    }
  });

for (const item of IGNORED_CASES)
  test(`gc --worktrees --apply on a merged worktree holding ${item.name} (gitignored) ${item.kept ? "keeps it and names them" : "removes it"}`, () => {
    const env = setup();
    const dir = worktree(env.main, path.join(env.root, "proj-wt", "i"), "feature/i", "i work\n");
    git(env.main, "merge", "-q", "--ff-only", "feature/i");
    put(dir, [...item.files]);

    const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

    if (item.kept) {
      expect(norm(applied.removable)).toEqual([]);
      expect(norm(applied.kept)).toEqual([
        {
          path: key(dir),
          branch: "feature/i",
          reason: "ignored files that are not regenerable (.env)",
        },
      ]);
      expect(existsSync(path.join(dir, ".env"))).toBe(true);
    } else {
      expect(norm(applied.removed)).toEqual([key(dir)]);
      expect(existsSync(dir)).toBe(false);
    }
  });

/** Commit `.workit/checks.json` with `cleanup`, and ignore `packages/<pkg>/skills/`, on main. */
const declareRegenerable = (main: string, cleanup: unknown) => {
  mkdirSync(path.join(main, ".workit"), { recursive: true });
  writeFileSync(
    path.join(main, ".workit", "checks.json"),
    JSON.stringify({ checks: { test: ["true"] }, cleanup }),
  );
  writeFileSync(
    path.join(main, ".gitignore"),
    ".env\nnode_modules/\n.workit-scratch/\npackages/*/skills/\n",
  );
  mkdirSync(path.join(main, "packages", "x"), { recursive: true });
  writeFileSync(path.join(main, "packages", "x", "index.ts"), "export {};\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "chore: regenerable skills");
};

for (const declared of [true, false])
  test(`Given a merged worktree whose only untracked files are under packages/x/skills, When cleanup runs ${declared ? "with" : "without"} cleanup.regenerable, Then the worktree is ${declared ? "removed" : "kept"}`, () => {
    const env = setup();
    declareRegenerable(env.main, declared ? { regenerable: ["packages/*/skills"] } : undefined);
    const dir = worktree(
      env.main,
      path.join(managedWorktreeRoot(env.env), "proj", "slice"),
      "feature/x",
      "x\n",
    );
    put(dir, ["packages/x/skills/a/SKILL.md", "packages/x/skills/b/SKILL.md"]);

    const out = cleanupAfterMerge(env.main, "feature/x", git(dir, "rev-parse", "HEAD"), {
      actor,
      trigger: "pr merge",
      env: env.env,
    });

    if (declared) {
      expect(out).toMatchObject({ branchDeleted: true, dirty: null, notes: [] });
      expect(existsSync(dir)).toBe(false);
    } else {
      expect(out.worktreeRemoved).toBeNull();
      expect(out.notes).toEqual([
        expect.stringContaining("ignored files that are not regenerable (packages/x/skills/)"),
      ]);
      expect(existsSync(dir)).toBe(true);
    }
  });

test("gc --worktrees honours cleanup.regenerable, and a .env nested under a regenerable dir goes with it", () => {
  const env = setup();
  declareRegenerable(env.main, { regenerable: ["packages/*/skills/"] });
  const dir = worktree(env.main, path.join(env.root, "proj-wt", "r"), "feature/r", "r\n");
  git(env.main, "merge", "-q", "--ff-only", "feature/r");
  put(dir, ["packages/x/skills/a/SKILL.md", "packages/x/skills/sub/.env"]);

  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });

  expect(norm(applied.removed)).toEqual([key(dir)]);
  expect(existsSync(dir)).toBe(false);
});

test("Given cleanup.regenerable that is not a list of glob strings, Then the checks config is invalid and names the key; cleanup keeps the worktree", () => {
  for (const cleanup of [
    { regenerable: [7] },
    { regenerable: "packages/*/skills" },
    { regenerable: ["/abs/skills"] },
    { regenerable: ["packages/{a,b}/skills"] },
    // Bare trailing wildcards would discard an ignored .env.
    { regenerable: ["*"] },
    { regenerable: ["**"] },
    { regenerable: ["dist/**"] },
    { regenerables: ["x"] },
  ]) {
    const env = setup();
    declareRegenerable(env.main, cleanup);
    const config = loadCheckConfig(env.main);
    expect(config.error, JSON.stringify(cleanup)).toMatch(/cleanup\.regenerable/);
  }
  const env = setup();
  declareRegenerable(env.main, { regenerable: [7] });
  const dir = worktree(
    env.main,
    path.join(managedWorktreeRoot(env.env), "proj", "slice"),
    "feature/x",
    "x\n",
  );
  put(dir, ["packages/x/skills/a/SKILL.md"]);
  const out = cleanupAfterMerge(env.main, "feature/x", git(dir, "rev-parse", "HEAD"), {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out.worktreeRemoved).toBeNull();
  expect(existsSync(dir)).toBe(true);
});
