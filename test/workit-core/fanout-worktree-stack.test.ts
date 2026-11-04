// W2.37: a slice that depends on another is a stack. `fanout worktree create`
// starts it on its parent slice's branch and records the stack, `fanout
// status` shows the order, and once the parent is squash-merged `workit stack
// sync` rebases the child onto the trunk without the parent's commits. Real
// git repositories with a bare origin, the real CLI entry, no forge.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { readStack } from "@/packages/workit-core/src/stack";

// Each test drives several real git worktrees; Windows runners take ~20 s.
setDefaultTimeout(60_000);
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-stack-config-");
});
afterAll(() => configHome.restore());

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd }).status === 0;

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-fanout-stack-"));
  dirs.push(root);
  const bare = path.join(root, "origin.git");
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  git(cwd, "remote", "add", "origin", bare);
  git(cwd, "push", "-q", "-u", "origin", "main");
  return { root, cwd };
};

const slice = (id: string, scope: string[], extra: Record<string, unknown> = {}) => ({
  id,
  branch: `feature/${id}`,
  tier: "mundane",
  reason: "parallel",
  scope,
  goal: `GET /${id} answers 200`,
  acceptance: [`Given the app, When GET /${id}, Then the status is 200`],
  verify: ["workit check test"],
  forbidden: ["no edits outside SCOPE"],
  ...extra,
});

const plan = async (cwd: string, root: string, slices: unknown[]) => {
  const file = path.join(root, "plan.json");
  writeFileSync(file, JSON.stringify({ name: "wave", trunk: "main", slices }));
  const result = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

const create = async (cwd: string, id: string) => {
  const result = await run(cwd, ["fanout", "worktree", "create", id, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return result.json().data as {
    path: string;
    base: string;
    head: string;
    stack: { name: string; slices: string[] } | null;
    notes: string[];
  };
};

const commitIn = (dir: string, file: string, text: string) => {
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-qm", `feat: ${file}`);
};

// A Windows checkout writes these with CRLF (core.autocrlf).
const text = (file: string): string => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

test("given b depends on a, when the worktrees are made, then b branches from a's branch, the stack is recorded and fanout status shows it", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, [slice("a", ["a.ts"]), slice("b", ["b.ts"], { dependsOn: ["a"] })]);
  const a = await create(cwd, "a");
  expect(a.stack).toBeNull();
  commitIn(a.path, "a.ts", "export const a = 1;\n");
  const b = await create(cwd, "b");
  expect(b.base).toBe("feature/a");
  expect(b.head).toBe(git(cwd, "rev-parse", "feature/a"));
  expect(b.stack).toEqual({ name: "wave/a", slices: ["a", "b"] });
  expect(b.notes.join("\n")).toContain("workit stack sync --name wave/a");
  const stack = readStack(cwd, "wave/a");
  if (!stack.ok) throw new Error(stack.error);
  expect(stack.data?.branches.map((entry) => [entry.branch, entry.parent])).toEqual([
    ["feature/a", "main"],
    ["feature/b", "feature/a"],
  ]);

  const status = await run(cwd, ["fanout", "status", "--offline", "--json"]);
  expect(status.code, status.stderr).toBe(0);
  expect(status.json().data.stacks).toEqual([{ name: "wave/a", slices: ["a", "b"] }]);
  const human = await run(cwd, ["fanout", "status", "--offline"]);
  expect(human.stdout).toContain("stack wave/a: a -> b");
});

test("given a chain a <- b <- c and a fork a <- d, then c extends a's stack, d gets its own, and status shows a planned chain before it is recorded", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, [
    slice("a", ["a.ts"]),
    slice("b", ["b.ts"], { dependsOn: ["a"] }),
    slice("c", ["c.ts"], { dependsOn: ["b"] }),
    slice("d", ["d.ts"], { dependsOn: ["a"] }),
  ]);
  const before = await run(cwd, ["fanout", "status", "--offline", "--json"]);
  expect(before.json().data.stacks).toEqual([
    { name: null, slices: ["a", "b", "c"] },
    { name: null, slices: ["a", "d"] },
  ]);
  const a = await create(cwd, "a");
  commitIn(a.path, "a.ts", "export const a = 1;\n");
  const b = await create(cwd, "b");
  commitIn(b.path, "b.ts", "export const b = 1;\n");
  expect((await create(cwd, "c")).stack).toEqual({ name: "wave/a", slices: ["a", "b", "c"] });
  expect((await create(cwd, "d")).stack).toEqual({ name: "wave/d", slices: ["a", "d"] });
  const after = await run(cwd, ["fanout", "status", "--offline", "--json"]);
  expect(after.json().data.stacks).toEqual([
    { name: "wave/a", slices: ["a", "b", "c"] },
    { name: "wave/d", slices: ["a", "d"] },
  ]);
});

test("given a squash-merged to the trunk, when workit stack sync runs, then b is rebased onto the trunk without a's commits", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, [slice("a", ["a.ts"]), slice("b", ["b.ts"], { dependsOn: ["a"] })]);
  const a = await create(cwd, "a");
  commitIn(a.path, "a.ts", "export const a = 1;\n");
  const b = await create(cwd, "b");
  commitIn(b.path, "b.ts", "export const b = 1;\n");
  // a moves on after b started (a review fix): its later commit lands in the squash too.
  commitIn(a.path, "a.ts", "export const a = 2;\n");
  const preSquash = git(cwd, "rev-parse", "feature/a");
  const bOwn = git(cwd, "rev-parse", "feature/b");
  // The forge's squash merge: one commit on main, pushed to origin.
  git(cwd, "merge", "--squash", "-q", "feature/a");
  git(cwd, "commit", "-qm", "feat: a (#1)");
  git(cwd, "push", "-q", "origin", "main");

  const status = await run(cwd, ["fanout", "status", "--offline", "--json"]);
  expect(status.json().data.notes.join("\n")).toContain(
    "a landed under b: workit stack sync --name wave/a",
  );

  const synced = await run(cwd, ["stack", "sync", "--local", "--name", "wave/a", "--json"]);
  expect(synced.code, synced.stderr + synced.stdout).toBe(0);
  expect(synced.json().data.merged).toEqual([{ branch: "feature/a", pr: null }]);
  const trunk = git(cwd, "rev-parse", "main");
  expect(isAncestor(cwd, trunk, "feature/b")).toBe(true);
  expect(isAncestor(cwd, preSquash, "feature/b")).toBe(false);
  expect(git(cwd, "rev-list", "--count", "main..feature/b")).toBe("1");
  expect(git(cwd, "log", "-1", "--format=%s", "feature/b")).toBe("feat: b.ts");
  expect(git(cwd, "rev-parse", "feature/b")).not.toBe(bOwn);
  // The worktree holding b moved with it and reads a's squashed content.
  expect(text(path.join(b.path, "a.ts"))).toBe("export const a = 2;\n");
  expect(text(path.join(b.path, "b.ts"))).toBe("export const b = 1;\n");
});
