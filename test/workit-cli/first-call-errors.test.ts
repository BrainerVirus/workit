// Retro 2026-11-17 C8+C9: a wrong flag, verb or plan field recovers in one
// call. Each refusal below carries what the next call needs (the usage line,
// the real flag, the command with the agent's own arguments, every valid
// value), so a weak model does not have to ask `workit help` first.
import "@/test/shared/state-isolation";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-first-call-")));
let configHome: ConfigHome;
const policy = (preset: string) =>
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset } }),
  );
beforeAll(() => {
  configHome = useConfigHome("wk-first-call-config-");
  policy("github-flow");
});
afterAll(() => {
  configHome.restore();
  rmSync(scratch, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

let count = 0;
/** A main-only repo on feature/base with one tracked file. */
const repo = (): string => {
  const root = path.join(scratch, `repo-${(count += 1)}`);
  git(scratch, "init", "-q", "-b", "main", root);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "switch", "-q", "-c", "feature/base");
  return root;
};

const env = () => ({
  ...process.env,
  WORKIT_WORKSPACE_ROOT: "",
  WORKIT_STATE_DIR: path.join(scratch, "state"),
});

const run = async (argv: string[], cwd = scratch) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: env(),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("Given `workit fanout worktree create x --branch y`, When run, Then stderr holds the usage line, says the branch comes from the plan and the plan is chosen with --name, exit non-zero", async () => {
  const result = await run(["fanout", "worktree", "create", "x", "--branch", "y"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("unknown option --branch");
  expect(result.stderr).toContain("branch and base come from the plan");
  expect(result.stderr).toContain("--name <plan>");
  expect(result.stderr).toContain(
    "usage: workit fanout worktree create|release <slice> [--name <n>] [--force]",
  );
  for (const flag of ["--base", "--plan"]) {
    const other = await run(["fanout", "worktree", "create", "x", flag, "y", "--json"]);
    expect(other.code, flag).toBe(2);
    expect(other.json().unblock, flag).toContain("--name <plan>");
  }
});

test("Given `workit ledger ruling … --cost x`, When run, Then the unblock names --cost-if-wrong and the ruling's usage line", async () => {
  const result = await run(["ledger", "ruling", "a", "--why", "b", "--cost", "x", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json().error).toBe("unknown option --cost");
  expect(result.json().unblock).toContain('--cost-if-wrong "<cost>"');
  expect(result.json().unblock).toContain('usage: workit ledger ruling "<what>" --why "<why>"');
});

test("Given any unknown option with no registered fix, When run, Then the unblock still carries the usage line", async () => {
  const result = await run(["ci", "wait", "--zzzzzz", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json().unblock).toBe(
    "workit help ci wait; usage: workit ci wait [--pr <n> | --branch <b>] [--head <sha>] [--timeout 20m] [--interval 30s]",
  );
});

test("Given `issue comment --body` and `pr reply --body`, When run, Then the unblock says the text goes through --body-file -", async () => {
  for (const argv of [
    ["issue", "comment", "3", "--body", "x"],
    ["pr", "reply", "--thread", "t", "--body", "x"],
  ]) {
    const result = await run([...argv, "--json"]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.json().unblock, argv.join(" ")).toContain("--body-file -");
  }
});

test.each([
  [["git", "switch", "-c", "feature/x"], "workit git branch feature/x creates it"],
  [["git", "checkout", "-b", "feature/y"], "workit git branch feature/y creates it"],
  [["git", "switch", "--create=feature/z"], "workit git branch feature/z creates it"],
  [["git", "switch", "main"], "git switch main"],
  [["git", "status"], "read-only git runs raw, no workit verb: run git status --short"],
  [["git", "diff", "--stat"], "read-only git runs raw, no workit verb: run git diff --stat"],
  [["git", "log", "--oneline", "-3"], "run git log --oneline -3 directly"],
  [["git", "pull", "--ff-only"], "workit git rebase"],
  [["git", "restore", "--staged", "a.txt"], "workit git unstage"],
  [["pr", "comment", "3"], "workit pr reply --thread <id>"],
])(
  "Given workit %p, When run, Then the unblock names the command with the typed arguments",
  async (argv, hint) => {
    const result = await run([...argv, "--json"]);
    expect(result.code).toBe(2);
    expect(result.json().error).toBe(`unknown ${argv[0]} subcommand "${argv[1]}"`);
    expect(result.json().unblock).toContain(hint);
  },
);

test("Given bare `workit dir`, When run, Then it lists every kind with what it holds, exit 0", async () => {
  const result = await run(["dir"]);
  expect(result.code).toBe(0);
  for (const kind of [
    "plans",
    "retros",
    "handoffs",
    "notes",
    "config",
    "state",
    "data",
    "cache",
    "runtime",
  ])
    expect(result.stdout).toMatch(new RegExp(`^${kind} +\\S`, "mu"));
  const json = await run(["dir", "--json"]);
  expect(json.json().data.kinds).toContainEqual({
    kind: "notes",
    scope: "clone",
    meaning: expect.stringContaining("notes"),
  });
});

test("Given a plan whose reason and tier hold no valid value, When `workit fanout plan` runs, Then each error lists every valid value and names the nearest", async () => {
  const cwd = repo();
  const plan = path.join(scratch, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "enums",
      slices: [
        { id: "a", branch: "feature/a", scope: ["a.txt"], tier: "standad", reason: "urgent" },
        { branch: "feature/b", scope: ["b.txt"], tier: "hard", reason: "paralel" },
      ],
    }),
  );
  const result = await run(["fanout", "plan", plan], cwd);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(
    'slice a: reason must be one of explore|parallel|backstop|high-risk-verify (got "urgent")',
  );
  expect(result.stderr).toContain(
    'slice a: tier must be one of mundane|standard|hard (got "standad"; nearest: standard)',
  );
  expect(result.stderr).toContain('(got "paralel"; nearest: parallel)');
});

test("Given `git branch --kind docs` with no --slug, When run, Then the error lists the valid kinds first", async () => {
  const result = await run(["git", "branch", "--kind", "docs", "--json"], repo());
  expect(result.code).toBe(2);
  expect(result.json().error).toContain("--kind must be feature, bugfix, release, hotfix");
});

test("Given tracked dirt, When `workit git branch` refuses, Then the first line names --carry and the unblock is the same command with --carry", async () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "a.txt"), "two\n");
  const result = await run(["git", "branch", "feature/next", "--base", "main", "--json"], cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toMatch(/^dirty_worktree: pass --carry .*: a\.txt$/u);
  expect(result.json().unblock).toStartWith("workit git branch feature/next --base main --carry");
});

test("Given a git-flow policy in a main-only clone, When `workit git branch feature/x` runs without --base, Then it branches from main and says develop is missing", async () => {
  const cwd = repo();
  policy("gitflow");
  try {
    const result = await run(["git", "branch", "feature/one", "--json"], cwd);
    expect(result.code).toBe(0);
    const data = result.json().data;
    expect(data.baseRef).toBe("refs/heads/main");
    expect(data.notes.join("\n")).toContain("develop does not exist here");
    const head = spawnSync("git", ["rev-parse", "HEAD", "main"], { cwd, encoding: "utf8" });
    const [tip, trunk] = head.stdout.trim().split("\n");
    expect(tip).toBe(trunk);
  } finally {
    policy("github-flow");
  }
});

test("Given a git-flow policy in a main-only clone, When `workit git branch` names --base develop, Then it is still refused naming --base main", async () => {
  const cwd = repo();
  policy("gitflow");
  try {
    const result = await run(["git", "branch", "feature/two", "--base", "develop", "--json"], cwd);
    expect(result.code).not.toBe(0);
    expect(result.json().error).toContain("develop");
  } finally {
    policy("github-flow");
  }
});

test("Given a repo whose subject style is Conventional, When `workit git commit -m 'wip: half done'` runs, Then it commits as `chore: wip half done` and says so", async () => {
  const cwd = repo();
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "github-flow" },
      commitPolicy: { preset: "conventional" },
    }),
  );
  try {
    writeFileSync(path.join(cwd, "a.txt"), "half\n");
    const result = await run(
      ["git", "commit", "-m", "wip: half done", "--json", "--", "a.txt"],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(result.json().data.message).toStartWith("chore: wip half done");
    expect(result.json().data.notes.join("\n")).toContain("rewrote the wip subject");
  } finally {
    policy("github-flow");
  }
});
