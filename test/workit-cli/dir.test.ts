// `workit dir <kind>`: per-clone dirs under <git-common-dir>/workit (the same
// for every worktree, created on demand) and the user-level resolver's dirs.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { REPO_DIR_KINDS } from "@/packages/workit-core/src/core/repo-paths";
import { workitDir } from "@/packages/workit-core/src/core/workit-paths.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-dir-")));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};
const repo = () => {
  const root = tempDir();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
};
const cli = async (cwd: string, argv: string[], env: Record<string, string> = {}) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_WORKSPACE_ROOT: "", ...env },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
};

test("Given a clone and its linked worktree, When `workit dir plans|retros|handoffs|notes` runs in each, Then both print the clone's <git-common-dir>/workit/<kind> and it exists", async () => {
  const root = repo();
  const worktree = path.join(tempDir(), "wt");
  git(root, "worktree", "add", "-q", "-b", "feature/x", worktree);
  for (const kind of ["plans", "retros", "handoffs", "notes"]) {
    const expected = path.join(root, ".git", "workit", kind);
    expect(existsSync(expected)).toBe(false);
    const fromWorktree = await cli(worktree, ["dir", kind]);
    expect(fromWorktree).toMatchObject({ code: 0, stdout: `${expected}\n` });
    expect(existsSync(expected)).toBe(true);
    expect((await cli(root, ["dir", kind])).stdout).toBe(`${expected}\n`);
  }
  expect(existsSync(path.join(worktree, ".workit"))).toBe(false);
  expect(existsSync(path.join(root, ".workit"))).toBe(false);
});

test("Given `workit dir notes --json` in a linked worktree, Then the path is under the git dir, not any working tree", async () => {
  const root = repo();
  const worktree = path.join(tempDir(), "wt");
  git(root, "worktree", "add", "-q", "-b", "feature/n", worktree);
  const result = await cli(worktree, ["dir", "notes", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { kind: "notes", scope: "clone", path: path.join(root, ".git", "workit", "notes") },
  });
  const status = spawnSync("git", ["status", "--porcelain", "--ignored", "-uall"], {
    cwd: worktree,
    encoding: "utf8",
  });
  expect(status.stdout).toBe("");
});

test("Given `workit dir state --json`, Then it prints the resolver's state dir in an ok envelope and creates nothing", async () => {
  const root = repo();
  const env = { XDG_STATE_HOME: path.join(tempDir(), "state"), WORKIT_STATE_DIR: "" };
  const result = await cli(root, ["dir", "state", "--json"], env);
  expect(result.code).toBe(0);
  const expected = workitDir("state", { ...process.env, ...env });
  expect(expected).toBe(path.join(env.XDG_STATE_HOME, "workit"));
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { kind: "state", scope: "user", path: expected },
  });
  expect(existsSync(expected)).toBe(false);
});

test("Given an unknown or missing kind, Then `workit dir` refuses with its usage (exit 2)", async () => {
  const root = repo();
  const unknown = await cli(root, ["dir", "scratch"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("unknown kind scratch");
  expect(unknown.stderr).toContain("plans|retros|handoffs|notes|config|state|data|cache|runtime");
  expect((await cli(root, ["dir"])).code).toBe(2);
  expect((await cli(root, ["dir", "plans", "extra"])).code).toBe(2);
});

test("Given docs/agents/file-locations.md, Then its repository table lists .workit/, every per-clone store dir and the judges' probe dir, and the state row names the worker scratch dir", () => {
  const doc = readFileSync(
    path.join(import.meta.dir, "../../docs/agents/file-locations.md"),
    "utf8",
  );
  const section = doc.slice(doc.indexOf("## Repository locations"), doc.indexOf("## Not Workit"));
  const rows = section.split("\n").filter((line) => line.startsWith("| `"));
  const named = rows.map((line) => line.split("|")[1].trim());
  expect(named).toContain("`.workit/`");
  for (const kind of ["ledger", "blobs", ...REPO_DIR_KINDS])
    expect(named).toContain(`\`<git-common-dir>/workit/${kind}\``);
  expect(named).toContain("`<worktree>/.workit-scratch`");
  for (const kind of REPO_DIR_KINDS) expect(section).toContain(`workit dir ${kind}`);
  const state = doc.split("\n").find((line) => line.startsWith("| state "));
  expect(state).toContain("`scratch/<repo>/<slice>`");
  expect(doc).toContain("never asks a repository to ignore");
});
