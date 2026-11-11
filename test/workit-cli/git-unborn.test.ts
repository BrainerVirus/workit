import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #774: a brand-new repository (no commit yet) starts its first work branch and
// commit through workit, with no raw git.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-unborn-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** `git init -b develop` with an uncommitted README.md and no remote. */
const unbornRepo = (): string => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-unborn-")));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "develop");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(cwd, "README.md"), "# new\n");
  return cwd;
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, out: stdout + stderr };
};

test("Given git init -b develop and a file, When workit git branch --kind feature then workit git commit, Then HEAD is feature/scaffold with one commit", async () => {
  const cwd = unbornRepo();
  const branched = await run(["git", "branch", "--kind", "feature", "--slug", "scaffold"], cwd);
  expect(branched.code, branched.out).toBe(0);
  expect(git(cwd, "symbolic-ref", "--short", "HEAD")).toBe("feature/scaffold");

  const committed = await run(["git", "commit", "-m", "chore: scaffold", "--", "README.md"], cwd);
  expect(committed.code, committed.out).toBe(0);
  expect(git(cwd, "symbolic-ref", "--short", "HEAD")).toBe("feature/scaffold");
  expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1");
  expect(git(cwd, "ls-tree", "--name-only", "HEAD")).toBe("README.md");
  // The protected branch stays unborn: the first commit lives on the work branch.
  expect(spawnSync("git", ["rev-parse", "--verify", "-q", "develop"], { cwd }).status).not.toBe(0);
});

test("Given an unborn protected branch, When workit git commit runs, Then the refusal names workit git branch --kind feature --slug <slug>", async () => {
  const cwd = unbornRepo();
  const refused = await run(["git", "commit", "-m", "chore: scaffold", "--", "README.md"], cwd);
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("protected_branch");
  expect(refused.out).toContain("workit git branch --kind feature --slug <slug>");
  expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd }).status).not.toBe(0);
});

test("Given an unborn repo, When workit git branch names a --base that does not exist, Then it is refused and HEAD stays on the unborn branch", async () => {
  const cwd = unbornRepo();
  const refused = await run(["git", "branch", "feature/a", "--base", "release/9"], cwd);
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("base release/9 does not resolve");
  expect(git(cwd, "symbolic-ref", "--short", "HEAD")).toBe("develop");
});
