import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { unstagedBackupsCheck } from "@/packages/workit-cli/src/admin/doctor";
import { hideUnstaged } from "@/packages/workit-core/src/git/hide-unstaged";

// #907 follow-up: a `workit git commit` killed while its hooks ran leaves a
// partly staged file at its staged content and the original under
// `<git dir>/workit/unstaged-<pid>-<ms>/`. `workit doctor` reports the folder;
// `workit gc --unstaged [--apply]` puts back what nobody edited since and never
// overwrites an edit.

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STAGED = "A\nb\nc\n";
const ORIGINAL = "A\nb\nC\n";

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repo with f.txt staged in part, then hidden by a commit that was killed (a dead pid). */
const killedCommit = (options: { pid?: number; linked?: boolean } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-gc-unstaged-"));
  roots.push(root);
  let cwd = path.join(root, "repo");
  git(root, "init", "-q", "-b", "main", cwd);
  git(cwd, "config", "user.name", "t");
  git(cwd, "config", "user.email", "t@t");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(cwd, "f.txt"), "a\nb\nc\n");
  git(cwd, "add", "f.txt");
  git(cwd, "commit", "-q", "-m", "chore: f");
  const checkout = cwd;
  if (options.linked) {
    cwd = path.join(root, "linked");
    git(checkout, "worktree", "add", "-q", "-b", "feature/x", cwd);
  }
  writeFileSync(path.join(cwd, "f.txt"), STAGED);
  git(cwd, "add", "f.txt");
  writeFileSync(path.join(cwd, "f.txt"), ORIGINAL);
  const hidden = hideUnstaged(cwd, ["f.txt"]);
  if ("error" in hidden) throw new Error(hidden.error);
  // The commit process died here: its folder names a pid that is gone.
  const store = options.linked
    ? path.join(checkout, ".git", "worktrees", "linked", "workit")
    : path.join(checkout, ".git", "workit");
  const [name] = readdirSync(store);
  const pid = options.pid ?? spawnSync("true").pid;
  const dir = path.join(store, name.replace(/^unstaged-\d+-/u, `unstaged-${pid}-`));
  renameSync(path.join(store, name), dir);
  return { cwd, checkout, dir, file: path.join(cwd, "f.txt") };
};

const gc = async (cwd: string, ...flags: string[]) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "gc-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(["gc", "--unstaged", ...flags], io);
  return { code, stdout, stderr };
};

test("Given a killed commit left a file at its staged content, When workit gc --unstaged runs, Then it only says it would restore, and --apply puts the original back and removes the folder", async () => {
  const killed = killedCommit();
  expect(readFileSync(killed.file, "utf8")).toBe(STAGED);

  const dry = await gc(killed.cwd);
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain(`would restore ${killed.dir}`);
  expect(dry.stdout).toContain("would put back f.txt");
  expect(readFileSync(killed.file, "utf8")).toBe(STAGED);
  expect(existsSync(killed.dir)).toBe(true);

  const applied = await gc(killed.cwd, "--apply");
  expect(applied.code).toBe(0);
  expect(applied.stdout).toContain(`removed ${killed.dir}`);
  expect(readFileSync(killed.file, "utf8")).toBe(ORIGINAL);
  expect(existsSync(killed.dir)).toBe(false);
  expect(git(killed.cwd, "status", "--porcelain")).toBe("MM f.txt");
});

test("Given a killed commit in a linked worktree, When workit gc --unstaged --apply runs from the main checkout, Then it puts the linked worktree's file back", async () => {
  const killed = killedCommit({ linked: true });

  const applied = await gc(killed.checkout, "--apply");
  expect(applied.stdout).toContain(`removed ${killed.dir} (0 min old): put back f.txt`);
  expect(readFileSync(killed.file, "utf8")).toBe(ORIGINAL);
  expect(existsSync(killed.dir)).toBe(false);
});

test("Given the file was edited after the killed commit, When workit gc --unstaged --apply, Then the edit is kept and so is the folder", async () => {
  const killed = killedCommit();
  writeFileSync(killed.file, "edited\n");

  const applied = await gc(killed.cwd, "--apply");
  expect(applied.code).toBe(0);
  expect(applied.stdout).toContain(`kept ${killed.dir}`);
  expect(applied.stdout).toContain("not overwritten: f.txt");
  expect(readFileSync(killed.file, "utf8")).toBe("edited\n");
  expect(readFileSync(path.join(killed.dir, "0"), "utf8")).toBe(ORIGINAL);
});

test("Given the original is already back in the working tree, When workit gc --unstaged --apply, Then the folder is removed and the file left alone", async () => {
  const killed = killedCommit();
  writeFileSync(killed.file, ORIGINAL);

  const dry = await gc(killed.cwd);
  expect(dry.stdout).toContain(`would remove ${killed.dir}`);
  const applied = await gc(killed.cwd, "--apply");
  expect(applied.stdout).toContain(
    `removed ${killed.dir} (0 min old): every file already restored`,
  );
  expect(existsSync(killed.dir)).toBe(false);
  expect(readFileSync(killed.file, "utf8")).toBe(ORIGINAL);
});

test("Given the committing process still runs, When workit gc --unstaged --apply, Then the folder and the file are left alone", async () => {
  const killed = killedCommit({ pid: process.pid });

  const applied = await gc(killed.cwd, "--apply");
  expect(applied.stdout).toContain(`kept ${killed.dir}`);
  expect(applied.stdout).toContain(`commit in progress (pid ${process.pid})`);
  expect(readFileSync(killed.file, "utf8")).toBe(STAGED);
  expect(existsSync(killed.dir)).toBe(true);
});

test("Given no folder, When workit gc --unstaged, Then it says so", async () => {
  const killed = killedCommit();
  await gc(killed.cwd, "--apply");
  const again = await gc(killed.cwd);
  expect(again.stdout).toContain("no unstaged changes set aside by a commit");
});

test("Given a killed commit's folder, When doctor runs, Then unstaged_backups warns with the folder, its age and whether each file differs, naming gc --unstaged", () => {
  const killed = killedCommit();
  const hidden = unstagedBackupsCheck(killed.cwd)!;
  expect(hidden.status).toBe("warn");
  expect(hidden.detail).toContain(`${killed.dir} (0 min old)`);
  expect(hidden.detail).toContain("f.txt differs (working tree still at the staged content)");
  expect(hidden.fix).toContain("workit gc --unstaged --apply");

  writeFileSync(killed.file, ORIGINAL);
  expect(unstagedBackupsCheck(killed.cwd)!.detail).toContain("f.txt matches the working tree");
  writeFileSync(killed.file, "edited\n");
  expect(unstagedBackupsCheck(killed.cwd)!.detail).toContain("f.txt differs (edited since)");
});

test("Given a repository with no folder, When doctor runs, Then unstaged_backups passes; outside a repository it has no row", async () => {
  const killed = killedCommit();
  await gc(killed.cwd, "--apply");
  expect(unstagedBackupsCheck(killed.cwd)).toEqual({
    id: "unstaged_backups",
    status: "pass",
    detail: "no unstaged changes set aside by a commit",
  });
  const outside = mkdtempSync(path.join(os.tmpdir(), "wk-gc-unstaged-out-"));
  roots.push(outside);
  expect(unstagedBackupsCheck(outside)).toBeNull();
});
