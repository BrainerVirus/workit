import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupAfterMerge,
  managedWorktreeRoot,
  sweepWorktrees,
} from "@/packages/workit-core/src/core/cleanup";
import { checkoutKey, liveProbe } from "@/packages/workit-core/src/core/live-session";
import { bootId, leaseDir, processStart } from "@/packages/workit-core/src/core/resources";
import { spawnHeavyTimeout } from "@/test/shared/timeouts";

// #835: build output (`bin/`, `target/`) and an older runtime's exact
// `.workit/` markers no longer keep a merged worktree; a worktree a live
// heavy-lease holder or another live session is in is never swept; a clean
// detached Workit worktree on a trunk commit is.

setDefaultTimeout(spawnHeavyTimeout());

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const actor = { host: "cli", session: "s-1", agentId: null };

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

/** <root>/proj on main ignoring bin/ and target/; a merged worktree at <root>/proj-wt/m. */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-gclo-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(main, ".gitignore"), "bin/\ntarget/\n");
  commit(main, "a.txt", "a\n");
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    WORKIT_STATE_DIR: path.join(root, "state"),
  };
  const merged = path.join(root, "proj-wt", "m");
  mkdirSync(path.dirname(merged), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "feature/m", merged, "main");
  commit(merged, "m.txt", "m\n");
  git(main, "merge", "-q", "--ff-only", "feature/m");
  return { root, main, env, merged };
};

const put = (dir: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
};

/** The 3.x workspace marker an older runtime left, pointing at the shared store. */
const WORKSPACE_MARKER = JSON.stringify({
  schemaVersion: 3,
  id: "w-1",
  runtime: { createdWith: "7.7.0" },
  store: { format: "workit-store", version: 1 },
  critical: ["store"],
});
const MOVED_MARKER = JSON.stringify({ format: "workit-store", version: 1, createdWith: "7.7.0" });

const LEFTOVERS = [
  { name: "an ignored bin/", files: { "bin/tool": "built\n" }, kept: null },
  { name: "an ignored target/", files: { "target/debug/x": "built\n" }, kept: null },
  {
    name: "an ignored .workit/ of exact markers (generated .gitignore of *)",
    files: {
      ".workit/.gitignore": "*\n",
      ".workit/workspace.json": WORKSPACE_MARKER,
      ".workit/store.moved.json": MOVED_MARKER,
    },
    kept: null,
  },
  {
    name: "an untracked .workit/ holding only the workspace marker",
    files: { ".workit/workspace.json": WORKSPACE_MARKER },
    kept: null,
  },
  {
    name: "an ignored .workit/ holding a marker and a notes file",
    files: {
      ".workit/.gitignore": "*\n",
      ".workit/workspace.json": WORKSPACE_MARKER,
      ".workit/notes.md": "mine\n",
    },
    kept: "ignored files that are not regenerable",
  },
  {
    name: "an untracked .workit/workspace.json with an extra field",
    files: { ".workit/workspace.json": JSON.stringify({ ...JSON.parse(WORKSPACE_MARKER), x: 1 }) },
    kept: "1 uncommitted change (.workit/workspace.json)",
  },
] as const;

for (const item of LEFTOVERS)
  test(`Given a merged worktree whose leftovers are ${item.name}, When gc --worktrees --apply runs, Then it is ${item.kept ? "kept" : "removed"}`, () => {
    const env = setup();
    put(env.merged, item.files);
    const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
    if (item.kept) {
      expect(applied.removed).toEqual([]);
      expect(applied.kept).toEqual([
        expect.objectContaining({
          branch: "feature/m",
          reason: expect.stringContaining(item.kept),
        }),
      ]);
      expect(existsSync(env.merged)).toBe(true);
    } else {
      expect(applied.removed).toHaveLength(1);
      expect(applied.deletedBranches).toEqual(["feature/m"]);
      expect(existsSync(env.merged)).toBe(false);
    }
  });

test("after a merge, a worktree whose only leftover is an untracked old .workit/ marker goes with its branch", () => {
  const env = setup();
  const dir = path.join(managedWorktreeRoot(env.env), "proj", "slice");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(env.main, "worktree", "add", "-q", "-b", "feature/x", dir, "main");
  commit(dir, "x.txt", "x\n");
  put(dir, { ".workit/workspace.json": WORKSPACE_MARKER, "bin/out": "built\n" });
  const out = cleanupAfterMerge(env.main, "feature/x", git(dir, "rev-parse", "HEAD"), {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out).toMatchObject({ branchDeleted: true, dirty: null, notes: [] });
  expect(existsSync(dir)).toBe(false);
});

/** A heavy-lease slot held by this test process, its cwd inside `dir`. */
const holdLease = (env: NodeJS.ProcessEnv, dir: string) => {
  const leases = leaseDir(env);
  mkdirSync(leases, { recursive: true });
  writeFileSync(
    path.join(leases, "slot-0.json"),
    JSON.stringify({
      id: "lease-1",
      pid: process.pid,
      processStart: processStart(process.pid),
      bootId: bootId(),
      check: "test",
      cwd: path.join(dir, "packages"),
      session: "other",
      startedAt: new Date().toISOString(),
      scope: null,
    }),
  );
};

/** Another session's live-session marker for checkout `dir`, its heartbeat `ageMs` old. */
const liveMarker = (
  env: NodeJS.ProcessEnv,
  dir: string,
  ageMs: number,
  pid: number = process.pid,
  pidStart: string | null = liveProbe.start(process.pid),
) => {
  const file = path.join(
    env.WORKIT_STATE_DIR as string,
    "live-sessions",
    `${createHash("sha256").update(checkoutKey(dir)).digest("hex").slice(0, 32)}.json`,
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      session: "other-session",
      leads: ["other-session"],
      host: "claude_code",
      pid,
      pidStart,
      machine: os.hostname(),
      checkout: dir,
      heartbeatAt: new Date(Date.now() - ageMs).toISOString(),
    }),
  );
};

test("Given a merged worktree with a live heavy-lease holder inside it, Then gc --worktrees --apply keeps it with that reason", () => {
  const env = setup();
  holdLease(env.env, env.merged);
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.removed).toEqual([]);
  expect(applied.kept).toEqual([
    expect.objectContaining({
      branch: "feature/m",
      reason: `a heavy lease holder runs in it (test, pid ${process.pid})`,
    }),
  ]);
  expect(existsSync(env.merged)).toBe(true);
});

test("Given another session's marker whose pid is the same running process but whose heartbeat is an hour old, Then the worktree is kept as live", () => {
  const env = setup();
  liveMarker(env.env, env.merged, 60 * 60 * 1000);
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.removed).toEqual([]);
  expect(applied.kept).toEqual([
    expect.objectContaining({
      reason: `another live session works in it (other-session, pid ${process.pid})`,
    }),
  ]);
  expect(existsSync(env.merged)).toBe(true);
});

test("Given a marker whose pid now belongs to another process (start time differs), Then it is not live and the merged worktree goes", () => {
  const env = setup();
  liveMarker(env.env, env.merged, 0, process.pid, "not-the-recorded-start");
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.removed).toHaveLength(1);
});

test("Given the sweeping session's own marker, Then it does not hold the worktree", () => {
  const env = setup();
  liveMarker(env.env, env.merged, 0);
  const applied = sweepWorktrees(env.main, {
    apply: true,
    actor: { ...actor, session: "other-session" },
    env: env.env,
  });
  expect(applied.removed).toHaveLength(1);
});

test("after a merge, a worktree another live session is in is kept with its branch", () => {
  const env = setup();
  const dir = path.join(managedWorktreeRoot(env.env), "proj", "busy");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(env.main, "worktree", "add", "-q", "-b", "feature/busy", dir, "main");
  commit(dir, "b.txt", "b\n");
  liveMarker(env.env, dir, 60 * 60 * 1000);
  const out = cleanupAfterMerge(env.main, "feature/busy", git(dir, "rev-parse", "HEAD"), {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out).toMatchObject({ branchDeleted: false, worktreeRemoved: null });
  expect(out.notes).toEqual([expect.stringContaining("another live session works in it")]);
  expect(existsSync(dir)).toBe(true);
});

test("Given a clean detached Workit worktree on a trunk commit with no live session, When gc --worktrees --apply runs, Then it is removed", () => {
  const env = setup();
  const dir = path.join(managedWorktreeRoot(env.env), "proj", "detached");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(env.main, "worktree", "add", "-q", "--detach", dir, "main");
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.kept).toEqual([]);
  expect(applied.removable.map((item) => [item.branch, item.reason])).toContainEqual([
    null,
    "merged",
  ]);
  expect(applied.removed).toHaveLength(2);
  expect(existsSync(dir)).toBe(false);
});

test("Given a merged host-isolated worktree (.claude/worktrees/agent-*) in the temp dir, Then gc --worktrees --apply never removes its directory", () => {
  const env = setup();
  const agent = path.join(env.main, ".claude", "worktrees", "agent-z");
  mkdirSync(path.dirname(agent), { recursive: true });
  git(env.main, "worktree", "add", "-q", "-b", "worktree-agent-z", agent, "main");
  commit(agent, "z.txt", "z\n");
  git(env.main, "merge", "-q", "--ff-only", "worktree-agent-z");
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.kept).toContainEqual(
    expect.objectContaining({
      branch: "worktree-agent-z",
      reason: "a host-owned worktree (.claude/worktrees); the host removes it",
    }),
  );
  expect(existsSync(agent)).toBe(true);
});

/** A clean detached managed worktree on main's tip, as `git worktree add --detach` leaves it. */
const detachedOnMain = (env: ReturnType<typeof setup>, name: string) => {
  const dir = path.join(managedWorktreeRoot(env.env), "proj", name);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(env.main, "worktree", "add", "-q", "--detach", dir, "main");
  return dir;
};

test("Given a clean detached Workit worktree paused mid-rebase on a trunk commit, Then gc --worktrees --apply keeps it: a rebase is in progress", () => {
  const env = setup();
  const dir = detachedOnMain(env, "rebasing");
  // `--exec false` stops after replaying the last trunk commit: HEAD stays on the trunk.
  try {
    execFileSync("git", ["rebase", "--exec", "false", "HEAD~1"], { cwd: dir, stdio: "ignore" });
  } catch {
    // the failing exec pauses the rebase
  }
  expect(existsSync(path.join(git(dir, "rev-parse", "--absolute-git-dir"), "rebase-merge"))).toBe(
    true,
  );
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.kept).toContainEqual(
    expect.objectContaining({ branch: null, reason: "a rebase is in progress" }),
  );
  expect(existsSync(dir)).toBe(true);
});

test("Given a clean detached Workit worktree with a bisect started on a trunk commit, Then gc --worktrees --apply keeps it: a bisect is in progress", () => {
  const env = setup();
  const dir = detachedOnMain(env, "bisecting");
  git(dir, "bisect", "start");
  const applied = sweepWorktrees(env.main, { apply: true, actor, env: env.env });
  expect(applied.kept).toContainEqual(
    expect.objectContaining({ branch: null, reason: "a bisect is in progress" }),
  );
  expect(existsSync(dir)).toBe(true);
});

test("after a merge, a worktree with a bisect in progress is kept with its branch", () => {
  const env = setup();
  const dir = path.join(managedWorktreeRoot(env.env), "proj", "bisect-slice");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(env.main, "worktree", "add", "-q", "-b", "feature/bis", dir, "main");
  commit(dir, "bis.txt", "bis\n");
  git(dir, "bisect", "start");
  const out = cleanupAfterMerge(env.main, "feature/bis", git(dir, "rev-parse", "HEAD"), {
    actor,
    trigger: "pr merge",
    env: env.env,
  });
  expect(out).toMatchObject({ branchDeleted: false, worktreeRemoved: null });
  expect(out.notes).toEqual([expect.stringContaining("a bisect is in progress")]);
  expect(existsSync(dir)).toBe(true);
});
