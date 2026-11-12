// #792 item 35: the cd-chain commit check compares a worktree's git dir with
// its store's parent. On Windows the two can differ only in separators or
// drive-letter case and still name the same directory.
import { expect, test } from "bun:test";
import { sameGitDir } from "@/packages/workit-core/src/hooks/raw-git";

test.each([
  ["C:\\repo\\.git", "c:/repo/.git"],
  ["c:\\Repo\\.git\\", "C:\\repo\\.git"],
  ["C:/repo/.git/worktrees/a/..\\..", "C:\\REPO\\.git"],
])("Given win32 paths %s and %s, When compared, Then they are the same dir", (a, b) => {
  expect(sameGitDir(a, b, "win32")).toBe(true);
});

test("Given win32 paths to different dirs, When compared, Then they differ", () => {
  expect(sameGitDir("C:\\repo\\.git", "D:\\repo\\.git", "win32")).toBe(false);
  expect(sameGitDir("C:\\repo\\.git\\worktrees\\a", "C:\\repo\\.git", "win32")).toBe(false);
});

test("Given posix paths, When only case differs, Then they differ; a trailing slash does not", () => {
  expect(sameGitDir("/repo/.git", "/Repo/.git", "linux")).toBe(false);
  expect(sameGitDir("/repo/.git/", "/repo/.git", "linux")).toBe(true);
});
