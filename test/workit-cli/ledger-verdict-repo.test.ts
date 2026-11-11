import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

// #759: a verdict about a branch is filed only in the repo that has the branch.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repo at `dir` on `branch`, one commit past main. */
const repoOn = (dir: string, branch: string): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Workit Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", branch);
  writeFileSync(path.join(dir, `${branch.replaceAll("/", "-")}.txt`), "work\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "work");
  return dir;
};

const workspace = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-verdict-repo-")));
  dirs.push(root);
  return root;
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-reviewer" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const verdictRows = async (cwd: string): Promise<{ branch: string }[]> =>
  (await run(cwd, ["ledger", "list", "--type", "verdict", "--json"])).json().data.rows;

test("a verdict naming a branch only a sibling repo has is refused with branch_not_in_repo and its --cwd retry", async () => {
  const root = workspace();
  const repoA = repoOn(path.join(root, "repo-a"), "feature/x");
  const repoB = repoOn(path.join(root, "repo-b"), "feature/y");

  const refused = await run(repoA, [
    "ledger",
    "verdict",
    "failed",
    "--how",
    "live run",
    "--branch",
    "feature/y",
    "--json",
  ]);

  expect(refused.code).not.toBe(0);
  const body = refused.json();
  expect(body.error).toContain("branch_not_in_repo");
  expect(body.error).toContain("feature/y");
  expect(body.unblock).toContain(`workit --cwd ${repoB} ledger verdict`);
  expect(await verdictRows(repoA)).toEqual([]);
  expect(await verdictRows(repoB)).toEqual([]);
});

test("a branch no sibling has is still refused as branch_not_in_repo, naming the generic --cwd retry", async () => {
  const root = workspace();
  const repoA = repoOn(path.join(root, "repo-a"), "feature/x");

  const refused = await run(repoA, [
    "ledger",
    "verdict",
    "failed",
    "--how",
    "live run",
    "--branch",
    "feature/nowhere",
    "--json",
  ]);

  expect(refused.code).not.toBe(0);
  expect(refused.json().error).toContain("branch_not_in_repo");
  expect(refused.json().unblock).toContain("--cwd <the checkout that has feature/nowhere>");
  expect(await verdictRows(repoA)).toEqual([]);
});

test("a --pr verdict without --branch is refused when this checkout is on another branch, naming both", async () => {
  const root = workspace();
  const repo = repoOn(path.join(root, "repo"), "feature/y");
  git(repo, "update-ref", "refs/pull/9/head", git(repo, "rev-parse", "feature/y"));
  git(repo, "checkout", "-qb", "feature/x", "main");

  const refused = await run(repo, [
    "ledger",
    "verdict",
    "failed",
    "--how",
    "live run",
    "--pr",
    "9",
    "--json",
  ]);

  expect(refused.code).not.toBe(0);
  const body = refused.json();
  expect(body.error).toContain("PR 9 is branch feature/y");
  expect(body.error).toContain("feature/x");
  expect(body.unblock).toContain("--branch feature/y");
  expect(await verdictRows(repo)).toEqual([]);

  // Naming the branch confirms the target: recorded on the PR's branch.
  const named = await run(repo, [
    "ledger",
    "verdict",
    "failed",
    "--how",
    "live run",
    "--pr",
    "9",
    "--branch",
    "feature/y",
    "--json",
  ]);
  expect(named.code).toBe(0);
  expect(named.json().data.branch).toBe("feature/y");
});
