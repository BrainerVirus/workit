import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHooks, stripAbsoluteLefthook } from "@/scripts/install-hooks";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

setDefaultTimeout(60_000);

// The pre-commit format job must never leave the index differing from the
// commit. `git commit -- <paths>` (what `workit git commit` runs) hooks
// against a temporary index, so a hook that *fixes* files commits the fix but
// leaves the real index with the unformatted copy (status MM). The job checks
// instead, and the installed hook never points into another checkout.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, args: string[]) {
  // Not the outer hook's index when this test runs inside a commit.
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY, LEFTHOOK_EXCLUDE: "commitlint" };
  delete env.GIT_INDEX_FILE;
  const run = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

/** A temp clone with the repo's hook config and a linked worktree, hooks installed. */
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "workit-hooks-"));
  dirs.push(base);
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  mkdirSync(main);
  git(main, ["init", "-q", "-b", "main"]);
  for (const file of ["lefthook.yml", ".oxfmtrc.json", "package.json"])
    copyFileSync(path.join(REPO_ROOT, file), path.join(main, file));
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "--no-verify", "-m", "chore: base"]);
  git(main, ["worktree", "add", "-q", "-b", "feature/x", wt]);
  for (const dir of [main, wt])
    symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
  installHooks(main);
  return { main, wt };
}

const WIDE = "export const a = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };\n";

test("a formatted file committed with paths from a linked worktree leaves status clean", () => {
  const { wt } = fixture();
  writeFileSync(path.join(wt, "a.ts"), WIDE);
  expect(git(wt, ["add", "a.ts"]).status).toBe(0);
  const commit = git(wt, ["commit", "-m", "feat: a", "--", "a.ts"]);
  expect(commit.status).toBe(0);
  expect(git(wt, ["status", "--porcelain", "--untracked-files=no"]).out).toBe("");
  const check = spawnSync(
    path.join(REPO_ROOT, "node_modules/.bin/oxfmt"),
    ["--check", "--config", path.join(wt, ".oxfmtrc.json"), "a.ts"],
    { cwd: wt, encoding: "utf8" },
  );
  expect(check.status).toBe(0);
});

test("an unformatted file is refused and the index stays what was staged", () => {
  const { wt } = fixture();
  writeFileSync(path.join(wt, "b.ts"), "export const b =   {one:1,\n two:2};\n");
  expect(git(wt, ["add", "b.ts"]).status).toBe(0);
  const staged = git(wt, ["diff", "--cached"]).out;
  const commit = git(wt, ["commit", "-m", "feat: b", "--", "b.ts"]);
  expect(commit.status).not.toBe(0);
  expect(commit.out).toContain("bun run format");
  expect(git(wt, ["rev-parse", "--verify", "-q", "HEAD:b.ts"]).status).not.toBe(0);
  expect(git(wt, ["diff", "--cached"]).out).toBe(staged);
  expect(readFileSync(path.join(wt, "b.ts"), "utf8")).toContain("{one:1,");
});

test("hooks:install leaves no absolute lefthook path in the shared hooks", () => {
  const { main } = fixture();
  const hook = readFileSync(path.join(main, ".git/hooks/pre-commit"), "utf8");
  expect(hook).toContain("call_lefthook");
  expect(hook).not.toMatch(/^\s*elif \/\S*lefthook\S* -h/m);
  expect(hook).toContain("$dir/node_modules/lefthook-");
});

test("stripAbsoluteLefthook removes the stale-path branch and nothing else", () => {
  const script = [
    "  elif lefthook -h >/dev/null 2>&1",
    "  then",
    '    lefthook "$@"',
    "  elif /old/wt/node_modules/lefthook-linux-x64/bin/lefthook -h >/dev/null 2>&1",
    "  then",
    '    /old/wt/node_modules/lefthook-linux-x64/bin/lefthook "$@"',
    "  else",
    "",
  ].join("\n");
  expect(stripAbsoluteLefthook(script)).toBe(
    ["  elif lefthook -h >/dev/null 2>&1", "  then", '    lefthook "$@"', "  else", ""].join("\n"),
  );
});
