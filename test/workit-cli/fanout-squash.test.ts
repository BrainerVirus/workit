import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #506 and #493 on real git repositories, offline (git decides landings):
// a dependency that landed by squash no longer anchors its dependent slice,
// and a main checkout whose node_modules no longer match its bun.lock is
// never linked into a slice worktree.

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-fanout-squash-config-");
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

const repo = (files: Record<string, string> = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-fanout-squash-"));
  dirs.push(root);
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(cwd, name), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
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
  const file = path.join(root, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ name: "squash", trunk: "main", slices }));
  const result = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

const create = async (cwd: string, id: string) => {
  const result = await run(cwd, ["fanout", "worktree", "create", id, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return result.json().data;
};

const commitIn = (dir: string, file: string, text: string) => {
  writeFileSync(path.join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-qm", `feat: ${file}`);
};

/** a lands on main by squash; b depends on a. */
const squashLanded = async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, [slice("a", ["a.ts"]), slice("b", ["b.ts"], { dependsOn: ["a"] })]);
  const a = await create(cwd, "a");
  commitIn(a.path, "a.ts", "export const a = 1;\n");
  commitIn(a.path, "a.ts", "export const a = 2;\n");
  git(cwd, "merge", "--squash", "-q", "feature/a");
  git(cwd, "commit", "-qm", "feat: a (#1)");
  return { root, cwd, preSquash: git(cwd, "rev-parse", "feature/a") };
};

test("fanout worktree create: given b depends on a and a landed on main by squash, when b's worktree is made, then it starts from main, not from a's pre-squash tip (#506)", async () => {
  const { cwd, preSquash } = await squashLanded();
  const b = await create(cwd, "b");
  const trunk = git(cwd, "rev-parse", "main");
  expect(b.head).toBe(trunk);
  expect(b.base).toBe("main");
  expect(
    spawnSync("git", ["merge-base", "--is-ancestor", preSquash, "HEAD"], { cwd: b.path }).status,
  ).toBe(1);
  expect(b.notes.join("\n")).toContain("feature/a landed");
  const brief = await run(cwd, ["fanout", "brief", "b", "--json"]);
  expect(brief.code, brief.stderr + brief.stdout).toBe(0);
  expect(brief.json().data.base).toBe("main");
  expect(brief.json().data.text).toContain("branch: feature/b   base: main");
});

test("fanout worktree create: given b depends on a and a has not landed, when b's worktree is made, then it starts from a's tip", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, [slice("a", ["a.ts"]), slice("b", ["b.ts"], { dependsOn: ["a"] })]);
  const a = await create(cwd, "a");
  commitIn(a.path, "a.ts", "export const a = 1;\n");
  const b = await create(cwd, "b");
  expect(b.head).toBe(git(cwd, "rev-parse", "feature/a"));
  expect(b.base).toBe("feature/a");
});

test("fanout check: given a landed by squash and b restacked onto main, then a reads landed and b has no 'edits outside its scope' from a's files (#506)", async () => {
  const { cwd } = await squashLanded();
  // b was started before a landed, on a's branch, then moved onto main.
  git(cwd, "branch", "feature/b", "feature/a");
  const b = path.join(path.dirname(cwd), "b-checkout");
  git(cwd, "worktree", "add", "-q", b, "feature/b");
  commitIn(b, "b.ts", "export const b = 1;\n");
  git(b, "rebase", "-q", "--onto", "main", "feature/a", "feature/b");
  const result = await run(cwd, ["fanout", "check", "--offline", "--json"]);
  const data = result.json().data;
  const byId = Object.fromEntries(
    data.slices.map((check: { id: string }) => [check.id, check]),
  ) as Record<string, { status: string; outOfScope: string[]; reasons: string[] }>;
  expect(byId.a.status).toBe("landed");
  expect(byId.b.outOfScope).toEqual([]);
  expect(byId.b.reasons.join("\n")).not.toContain("outside its scope");
});

test("fanout check: given b still on a's pre-squash tip after a landed, then b's diff is only its own change", async () => {
  const { cwd } = await squashLanded();
  git(cwd, "branch", "feature/b", "feature/a");
  const b = path.join(path.dirname(cwd), "b-checkout");
  git(cwd, "worktree", "add", "-q", b, "feature/b");
  commitIn(b, "b.ts", "export const b = 1;\n");
  const result = await run(cwd, ["fanout", "check", "--offline", "--json"]);
  const check = result.json().data.slices.find((item: { id: string }) => item.id === "b") as {
    outOfScope: string[];
    changed: number;
  };
  expect(check.outOfScope).toEqual([]);
  expect(check.changed).toBe(1);
});

// ---------------------------------------------------------------------------
// #493: stale node_modules

const LOCK = (version: string) =>
  `{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": {\n    "left-pad": ["left-pad@${version}", "", {}, "sha512-x"],\n    "@scope/tool": ["@scope/tool@2.0.0", "", {}, "sha512-y"],\n    "linked": ["linked@workspace:packages/linked"],\n  }\n}\n`;

const install = (cwd: string, versions: Record<string, string>) => {
  for (const [name, version] of Object.entries(versions)) {
    const dir = path.join(cwd, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }
};

test("fanout worktree create: given the main checkout's node_modules were installed for an older bun.lock, then nothing is linked and the install command is named (#493)", async () => {
  const { root, cwd } = repo({ "bun.lock": LOCK("1.3.0") });
  install(cwd, { "left-pad": "1.2.0", "@scope/tool": "2.0.0" });
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const a = await create(cwd, "a");
  expect(a.dependencies).toBeNull();
  expect(a.install).toBe(`bun install --frozen-lockfile --cwd ${a.path}`);
  expect(a.notes.join("\n")).toContain("left-pad 1.2.0 installed, bun.lock has 1.3.0");
  expect(existsSync(path.join(a.path, "node_modules"))).toBe(false);
});

test("fanout worktree create: given a package bun.lock lists is missing from the main checkout's node_modules, then nothing is linked (#493)", async () => {
  const { root, cwd } = repo({ "bun.lock": LOCK("1.3.0") });
  install(cwd, { "left-pad": "1.3.0" });
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const a = await create(cwd, "a");
  expect(a.dependencies).toBeNull();
  expect(a.notes.join("\n")).toContain("@scope/tool missing");
});

test("fanout worktree create: given the main checkout's node_modules match its bun.lock, then they are linked", async () => {
  const { root, cwd } = repo({ "bun.lock": LOCK("1.3.0") });
  install(cwd, { "left-pad": "1.3.0", "@scope/tool": "2.0.0" });
  await plan(cwd, root, [slice("a", ["a.ts"])]);
  const a = await create(cwd, "a");
  expect(a.install).toBeNull();
  expect(a.dependencies).not.toBeNull();
  expect(existsSync(path.join(a.path, "node_modules", "left-pad", "package.json"))).toBe(true);
});
