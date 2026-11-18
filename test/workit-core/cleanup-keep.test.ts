// #835: what the delivery end keeps. A keep decision (`workit ledger decision
// … --keep branch:|worktree:`) leaves that branch or worktree and names the
// decision; the checkout the command runs in leaves the merged branch only
// once the change is on the remote trunk by patch id and its local trunk is
// behind the remote one; a linked worktree whose trunk is checked out
// elsewhere is detached at the remote trunk.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RELEASE_COMMAND,
  cleanupAfterMerge,
  keepDecisions,
  managedWorktreeRoot,
} from "@/packages/workit-core/src/core/cleanup";
import { readLedger, recordDecision } from "@/packages/workit-core/src/ledger";
import { useConfigHome } from "../shared/grant-home";
import { spawnHeavyTimeout } from "../shared/timeouts";

setDefaultTimeout(spawnHeavyTimeout());

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

/** A repo at <root>/proj on main with a bare origin, and feature/x one commit off main. */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-keep-")));
  roots.push(root);
  const main = path.join(root, "proj");
  const bare = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(path.join(main, ".gitignore"), ".workit-scratch/\n");
  commit(main, "a.txt", "a\n", "base");
  git(main, "remote", "add", "origin", bare);
  git(main, "push", "-q", "origin", "main");
  git(main, "switch", "-q", "-c", "feature/x");
  const head = commit(main, "x.txt", "x\n", "feature");
  git(main, "switch", "-q", "main");
  const env = { ...process.env, WORKIT_STATE_DIR: path.join(root, "state") };
  return { root, main, bare, head, env };
};

/** The forge's squash of feature/x onto origin/main; returns the new remote main. */
const squash = (world: ReturnType<typeof setup>) => {
  const clone = path.join(world.root, "squash");
  execFileSync("git", ["clone", "-q", world.bare, clone]);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  git(clone, "fetch", "-q", world.main, "feature/x");
  git(clone, "merge", "-q", "--squash", "FETCH_HEAD");
  git(clone, "commit", "-q", "-m", "feat: x (#1)");
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
};

const slice = (world: ReturnType<typeof setup>) => {
  const dir = path.join(managedWorktreeRoot(world.env), "proj", "slice");
  mkdirSync(path.dirname(dir), { recursive: true });
  git(world.main, "worktree", "add", "-q", dir, "feature/x");
  return dir;
};

const keep = (cwd: string, value: string) => {
  const row = recordDecision(
    { cwd, actor, branch: null },
    { what: "keep it", why: "the user: keep it for the demo", keep: [value] },
  );
  if (!row.ok) throw new Error(row.error);
  return row.value.id;
};

const cleanup = (world: ReturnType<typeof setup>, cwd = world.main) =>
  cleanupAfterMerge(cwd, "feature/x", world.head, { actor, trigger: "pr merge", env: world.env });

const branchExists = (cwd: string, branch: string) => git(cwd, "branch", "--list", branch) !== "";

test("Given a keep decision for branch:feature/x, Then its worktree and branch stay and the note names the decision", async () => {
  const world = setup();
  const dir = slice(world);
  const id = keep(world.main, "branch:feature/x");
  const out = await cleanup(world);
  expect(out).toMatchObject({ branchDeleted: false, worktreeRemoved: null, recorded: null });
  expect(out.notes).toEqual([
    `kept: local feature/x, its worktrees and their processes (decision ${id})`,
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(branchExists(world.main, "feature/x")).toBe(true);
});

test("Given a keep decision for worktree:<path>, Then that worktree and its branch stay and the note names the decision", async () => {
  const world = setup();
  const dir = slice(world);
  const id = keep(world.main, `worktree:${dir}`);
  const out = await cleanup(world);
  expect(out.worktreeRemoved).toBeNull();
  expect(out.notes).toEqual([`kept: worktree ${dir} and local feature/x (decision ${id})`]);
  expect(existsSync(dir)).toBe(true);
});

test("Given a keep decision that a later one supersedes, Then cleanup no longer honours it", async () => {
  const world = setup();
  slice(world);
  const id = keep(world.main, "branch:feature/x");
  const later = recordDecision(
    { cwd: world.main, actor, branch: null, supersedes: id },
    { what: "done with it", why: "the user: clean it up" },
  );
  expect(later.ok).toBe(true);
  expect(keepDecisions(world.main)).toEqual([]);
  const out = await cleanup(world);
  expect(out.branchDeleted).toBe(true);
});

test("Given a bad --keep value or one from a decider, Then the decision is refused", () => {
  const world = setup();
  const context = { cwd: world.main, actor, branch: null };
  const bad = recordDecision(context, { what: "w", why: "y", keep: ["tag:v1"] });
  expect(bad.ok ? "" : bad.error).toContain(
    "--keep takes branch:<name>, worktree:<path> or proc:<id>",
  );
  const decider = recordDecision(context, {
    what: "w",
    why: "y",
    by: "decider",
    keep: ["branch:feature/x"],
  });
  expect(decider.ok ? "" : decider.error).toContain("does not take --by decider");
  const ledger = readLedger(world.main);
  expect(ledger.ok && ledger.value.rows.filter((row) => row.type === "decision")).toEqual([]);
});

test("Given the main checkout on the merged branch whose change is not on origin/main yet, Then it stays on the branch with the reason", async () => {
  const world = setup();
  git(world.main, "switch", "-q", "feature/x");
  const out = await cleanup(world);
  expect(out.branchDeleted).toBe(false);
  expect(out.switched).toBeNull();
  expect(out.notes.join("\n")).toContain("its change is not on origin/main by patch id yet");
  expect(git(world.main, "branch", "--show-current")).toBe("feature/x");
});

test("Given the main checkout on the merged branch with a local main ahead of origin/main, Then it stays on the branch with the reason", async () => {
  const world = setup();
  squash(world);
  commit(world.main, "local.txt", "local\n", "local only");
  git(world.main, "switch", "-q", "feature/x");
  const out = await cleanup(world);
  expect(out.branchDeleted).toBe(false);
  expect(out.notes.join("\n")).toContain("local main has commits that are not on origin/main");
  expect(git(world.main, "branch", "--show-current")).toBe("feature/x");
});

test("Given a linked worktree on the merged branch running the command while main is checked out elsewhere, Then it is detached at origin/main, the branch goes, and the note names the release command", async () => {
  const world = setup();
  const remoteMain = squash(world);
  const dir = slice(world);
  const out = await cleanup(world, dir);
  expect(out.branchDeleted).toBe(true);
  expect(out.switched).toEqual({ path: dir, to: "origin/main (detached)", head: remoteMain });
  expect(out.notes.join("\n")).toContain(RELEASE_COMMAND);
  expect(existsSync(dir)).toBe(true);
  expect(git(dir, "rev-parse", "HEAD")).toBe(remoteMain);
  expect(branchExists(world.main, "feature/x")).toBe(false);
});

test("Given an open PR the forge reports for the branch, Then cleanupAfterMerge keeps the branch and its worktree with the forge's reason", async () => {
  const world = setup();
  const dir = slice(world);
  const asked: string[] = [];
  const out = await cleanupAfterMerge(world.main, "feature/x", world.head, {
    actor,
    trigger: "pr merge",
    env: world.env,
    openPr: (branch) => {
      asked.push(branch);
      return "open PR #13 targets it";
    },
  });
  expect(asked).toEqual(["feature/x"]);
  expect(out).toMatchObject({ branchDeleted: false, worktreeRemoved: null, recorded: null });
  expect(out.notes).toEqual(["local feature/x is kept: open PR #13 targets it"]);
  expect(existsSync(dir)).toBe(true);
  expect(branchExists(world.main, "feature/x")).toBe(true);
});

test("Given workspace cleanup with a value Workit does not know, Then nothing is removed and the note names the value", async () => {
  const world = setup();
  const dir = slice(world);
  const home = useConfigHome("wk-keep-config-");
  try {
    writeFileSync(
      path.join(home.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [
          { name: "w", glob: `${world.root.replaceAll("\\", "/")}/**`, cleanup: "kepp" },
        ],
      }),
    );
    const out = await cleanup(world);
    expect(out.notes).toEqual([
      'kept: workspace cleanup keep (w), read from the unknown value "kepp" (auto or keep); local feature/x, its worktrees and their processes stay',
    ]);
  } finally {
    home.restore();
  }
  expect(existsSync(dir)).toBe(true);
});
