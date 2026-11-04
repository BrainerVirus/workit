import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as gc } from "@/packages/workit-cli/src/verbs/gc";

// #653: `workit gc --worktrees` lists what finished changes left on disk (a
// dry run by default) and removes it with --apply. The verb is called
// directly: the registry's gc usage line (out of this change's scope) does not
// list --worktrees/--apply yet, so `main` would refuse them.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** <root>/proj on main, a merged worktree at <root>/proj-wt/a and an unmerged one at <root>/proj-wt/b. */
const setup = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-gcwt-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  const merged = path.join(root, "proj-wt", "a");
  const unmerged = path.join(root, "proj-wt", "b");
  git(main, "worktree", "add", "-q", "-b", "feature/a", merged, "main");
  git(main, "worktree", "add", "-q", "-b", "feature/b", unmerged, "main");
  writeFileSync(path.join(unmerged, "b.txt"), "b\n");
  git(unmerged, "add", "-A");
  git(unmerged, "commit", "-q", "-m", "unmerged b");
  return { root, main, merged, unmerged };
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  const io: Io = {
    cwd,
    json: argv.includes("--json"),
    env: { ...process.env, XDG_CACHE_HOME: path.join(cwd, "..", "cache") },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await gc(argv.slice(1), io);
  return { code, stdout };
};

test("gc --worktrees is a dry run: it lists the merged worktree with its size and keeps the unmerged one", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees"], env.main);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("dry run");
  expect(result.stdout).toMatch(
    new RegExp(
      `would remove ${env.merged.replaceAll("\\", "\\\\")} \\[feature/a\\]: merged, \\d+\\.\\d MB`,
    ),
  );
  expect(result.stdout).toContain(`kept ${env.unmerged} [feature/b]: not merged into`);
  expect(result.stdout).not.toContain(`would remove ${env.unmerged}`);
  expect(existsSync(env.merged)).toBe(true);
});

test("gc --worktrees --apply removes the merged worktree, its branch and nothing unmerged", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees", "--apply", "--json"], env.main);
  expect(result.code, result.stdout).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.removed).toEqual([env.merged]);
  expect(data.deletedBranches).toEqual(["feature/a"]);
  expect(existsSync(env.merged)).toBe(false);
  expect(existsSync(env.unmerged)).toBe(true);
  expect(git(env.main, "branch", "--list", "feature/b")).not.toBe("");
});

test("gc --worktrees refuses an unknown argument", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees", "--force"], env.main);
  expect(result.code).toBe(2);
  expect(existsSync(env.merged)).toBe(true);
});
