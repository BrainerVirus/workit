import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

// #835: a `workit check` whose checkout is removed while it runs records
// nothing and never recreates the removed path.

const BUN = process.execPath;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repo with one commit and a linked worktree on its own branch. */
const repoWithWorktree = () => {
  const root = temp("wk-orphan-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const worktree = path.join(temp("wk-orphan-wt-"), "slice");
  git(root, "worktree", "add", "-q", "-b", "feature/slice", worktree);
  return { root, worktree };
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKIT_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

/** A command that removes `dir` and then exits 1. */
const removeThenFail = (dir: string): string[] => [
  BUN,
  "-e",
  `require("node:fs").rmSync(${JSON.stringify(dir)}, { recursive: true, force: true }); process.exit(1)`,
];

/** Every file under `dir` (relative paths), or [] when it does not exist. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    : [];

test("G a worktree removed by the checked command, W the check ends, T the path stays gone, nothing is recorded, stderr names the path and the exit code is the command's", async () => {
  const { root, worktree } = repoWithWorktree();
  const store = path.join(root, ".git", "workit");
  const before = filesUnder(store);

  const result = await run(worktree, ["check", "--name", "t", "--", ...removeThenFail(worktree)]);

  expect(result.code).toBe(1);
  expect(existsSync(worktree)).toBe(false);
  expect(result.stderr).toContain(worktree);
  expect(result.stderr).toContain("the result was not recorded");
  // No ledger row, log blob or task landed in the shared store.
  expect(filesUnder(store)).toEqual(before);
});

test("G a worktree removed by a passing command, W the check ends, T exit 0 is kept and --json says it was not recorded", async () => {
  const { root, worktree } = repoWithWorktree();
  const store = path.join(root, ".git", "workit");
  const before = filesUnder(store);

  const result = await run(worktree, [
    "check",
    "--json",
    "--name",
    "t",
    "--",
    BUN,
    "-e",
    `require("node:fs").rmSync(${JSON.stringify(worktree)}, { recursive: true, force: true })`,
  ]);

  expect(result.code).toBe(0);
  expect(existsSync(worktree)).toBe(false);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.ok).toBe(false);
  expect(envelope.data).toMatchObject({ exitCode: 0, recorded: false, removed: worktree });
  expect(envelope.error).toContain("not recorded");
  expect(filesUnder(store)).toEqual(before);
});

test("G a non-git directory removed by the checked command, W the check ends, T no `.workit` store recreates it", async () => {
  const dir = path.join(temp("wk-orphan-plain-"), "work");
  spawnSync("mkdir", [dir]);

  const result = await run(dir, ["check", "--name", "t", "--", ...removeThenFail(dir)]);

  expect(result.code).toBe(1);
  expect(existsSync(dir)).toBe(false);
  expect(result.stderr).toContain("the result was not recorded");
});

test("G a non-git directory that exists, W a check runs there, T it records into <dir>/.workit as before", async () => {
  const dir = temp("wk-orphan-nogit-");

  const result = await run(dir, ["check", "--name", "t", "--", BUN, "-e", "process.exit(0)"]);

  expect(result.code).toBe(0);
  expect(existsSync(path.join(dir, ".workit", "ledger", "ledger.jsonl"))).toBe(true);
  expect(result.stderr).not.toContain("not recorded");
});
