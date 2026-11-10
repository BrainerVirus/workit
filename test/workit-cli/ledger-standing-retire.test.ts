// #775: a fanout plan whose slices have all landed or been released is
// retired, so `ledger standing add` needs no --fanout while one plan stays
// active. A plan whose landing cannot be read stays a candidate. Real git
// repositories, the real CLI entry.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
const previousState = process.env.WORKIT_STATE_DIR;
beforeAll(() => {
  configHome = useConfigHome("wk-standing-retire-config-");
});
afterAll(() => {
  configHome.restore();
  if (previousState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = previousState;
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const run = async (cwd: string, argv: string[], session = "lead-1") => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const repo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-standing-retire-"));
  dirs.push(root);
  const cwd = path.join(root, "app");
  const hooks = path.join(root, "hooks");
  mkdirSync(cwd);
  mkdirSync(hooks);
  // Slice worktrees go under this test's own state dir.
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
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
  return { root, cwd };
};

const plan = async (cwd: string, root: string, name: string) => {
  const file = path.join(root, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      name,
      trunk: "main",
      slices: [
        {
          id: `${name}-a`,
          branch: `feature/${name}-a`,
          tier: "mundane",
          reason: "parallel",
          scope: [`${name}.ts`],
          goal: `GET /${name} answers 200`,
          acceptance: [`Given the app, When GET /${name}, Then the status is 200`],
          verify: ["workit check test"],
          forbidden: ["no new packages"],
        },
      ],
    }),
  );
  const result = await run(cwd, ["fanout", "plan", file, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

/** Land the plan's one slice: a commit on its branch, merged into main. */
const land = (cwd: string, name: string) => {
  git(cwd, "switch", "-q", "-c", `feature/${name}-a`);
  writeFileSync(path.join(cwd, `${name}.ts`), "export {};\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", `feat: ${name}`);
  git(cwd, "switch", "-q", "main");
  git(cwd, "merge", "-q", "--ff-only", `feature/${name}-a`);
};

test("given one landed plan and one active plan, when ledger standing add runs without --fanout, then the order is recorded for the active plan", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one");
  land(cwd, "wave-one");
  await plan(cwd, root, "wave-two");
  const added = await run(cwd, ["ledger", "standing", "add", "Never push", "--json"]);
  expect(added.code, added.stderr + added.stdout).toBe(0);
  expect(added.json().data.fanout).toBe("wave-two");
  const listed = await run(cwd, ["ledger", "standing", "list", "--json"], "other-3");
  expect(listed.code, listed.stderr + listed.stdout).toBe(0);
  expect(listed.json().data.fanout).toBe("wave-two");
});

test("given one released plan and one active plan, when ledger standing add runs without --fanout, then the order is recorded for the active plan", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one");
  for (const action of ["create", "release"]) {
    const result = await run(cwd, ["fanout", "worktree", action, "wave-one-a", "--json"]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
  }
  await plan(cwd, root, "wave-two");
  const added = await run(cwd, ["ledger", "standing", "add", "Never push", "--json"]);
  expect(added.code, added.stderr + added.stdout).toBe(0);
  expect(added.json().data.fanout).toBe("wave-two");
});

test("given two active plans, then the refusal names both and --fanout", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one");
  await plan(cwd, root, "wave-two");
  const refused = await run(cwd, ["ledger", "standing", "add", "Never push", "--json"]);
  expect(refused.code).toBe(2);
  const error = refused.json().error as string;
  expect(error).toContain("pick one with --fanout <name>: wave-one, wave-two");
});

test("given a plan whose slice branch is unborn and unreleased, then it stays a candidate", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one");
  await plan(cwd, root, "wave-two");
  // wave-one's branch exists but has no commits of its own: not landed.
  git(cwd, "branch", "feature/wave-one-a");
  const refused = await run(cwd, ["ledger", "standing", "add", "Never push", "--json"]);
  expect(refused.code).toBe(2);
  expect(refused.json().error).toContain("wave-one, wave-two");
});
