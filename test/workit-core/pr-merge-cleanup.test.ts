import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupMergedBranch } from "@/packages/workit-core/src/forge/merge-cleanup";
import { FANOUT_TOKEN_FILE } from "@/packages/workit-core/src/hooks/worktree-confine";

// #384: after `pr merge` deleted the remote head branch, the local branch and
// the slice's clean fanout worktree go too; nothing else does.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const setup = () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-cleanup-")));
  roots.push(root);
  const main = path.join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  git(main, "branch", "feature/x");
  const head = git(main, "rev-parse", "feature/x");
  return { root, main, head };
};

const worktree = (env: { root: string; main: string }, marked: boolean) => {
  const dir = path.join(env.root, "wt");
  git(env.main, "worktree", "add", "-q", dir, "feature/x");
  if (marked) {
    const admin = git(dir, "rev-parse", "--absolute-git-dir");
    writeFileSync(path.join(admin, FANOUT_TOKEN_FILE), "token\n");
  }
  return dir;
};

const branches = (main: string) => git(main, "branch", "--list", "feature/x");

test("a local branch checked out nowhere is deleted", () => {
  const env = setup();
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out).toEqual({ branchDeleted: true, worktreeRemoved: null, notes: [] });
  expect(branches(env.main)).toBe("");
});

test("a clean Workit fanout worktree on the branch is removed with the branch", () => {
  const env = setup();
  const dir = worktree(env, true);
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out).toMatchObject({ branchDeleted: true, notes: [] });
  // git reports the long, forward-slash path; Windows temp dirs may be 8.3 short names.
  expect(path.basename(String(out.worktreeRemoved))).toBe(path.basename(dir));
  expect(existsSync(dir)).toBe(false);
  expect(branches(env.main)).toBe("");
});

test("a dirty fanout worktree is kept with its branch, and the note says so", () => {
  const env = setup();
  const dir = worktree(env, true);
  writeFileSync(path.join(dir, "wip.txt"), "work\n");
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out.branchDeleted).toBe(false);
  expect(out.worktreeRemoved).toBeNull();
  expect(out.notes).toEqual([expect.stringMatching(/1 uncommitted change; kept it and local/)]);
  expect(existsSync(dir)).toBe(true);
  expect(branches(env.main)).not.toBe("");
});

test("a worktree Workit did not make is never removed", () => {
  const env = setup();
  const dir = worktree(env, false);
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out.branchDeleted).toBe(false);
  expect(out.notes).toEqual([expect.stringMatching(/not a Workit fanout worktree/)]);
  expect(existsSync(dir)).toBe(true);
});

test("a branch checked out in the main checkout is kept", () => {
  const env = setup();
  git(env.main, "switch", "-q", "feature/x");
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out.branchDeleted).toBe(false);
  expect(out.notes).toEqual([expect.stringMatching(/checked out in/)]);
});

test("a local branch with commits beyond the merged head is kept", () => {
  const env = setup();
  git(env.main, "switch", "-q", "feature/x");
  writeFileSync(path.join(env.main, "more.txt"), "m\n");
  git(env.main, "add", "-A");
  git(env.main, "commit", "-q", "-m", "more");
  git(env.main, "switch", "-q", "main");
  const out = cleanupMergedBranch(env.main, "feature/x", env.head);
  expect(out.branchDeleted).toBe(false);
  expect(out.notes).toEqual([expect.stringMatching(/not merged; kept it/)]);
  expect(branches(env.main)).not.toBe("");
});
