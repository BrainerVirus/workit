import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFlags, closest } from "@/packages/workit-cli/src/help";
import { main } from "@/packages/workit-cli/src/main";
import { findVerb } from "@/packages/workit-cli/src/verbs/registry";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// The wrong guesses agents measured (retro F3) either work as aliases or fail
// with one corrective unblock line naming the right form.

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-did-you-mean-config-");
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

const repo = (): string => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wk-did-you-mean-"));
  dirs.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(cwd, ".nohooks")],
  ])
    git(cwd, "config", key, value);
  writeFileSync(path.join(cwd, "README.md"), "# app\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  git(cwd, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(cwd, "f.txt"), "f\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "feat: f");
  return cwd;
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-lead" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("Given `task list --status all`, When run, Then it lists like `task list`; another status is refused", async () => {
  const cwd = repo();
  const plain = await run(cwd, ["task", "list", "--json"]);
  const all = await run(cwd, ["task", "list", "--status", "all", "--json"]);
  expect(all.code, all.stderr + all.stdout).toBe(0);
  expect(all.json()).toEqual(plain.json());
  const open = await run(cwd, ["task", "list", "--status", "open", "--json"]);
  expect(open.code).toBe(2);
  expect(open.json().error).toContain("lists every task");
});

test("Given `ledger verdict --sha <head>`, When run, Then it is recorded as --head; a different sha is refused", async () => {
  const cwd = repo();
  const head = git(cwd, "rev-parse", "HEAD");
  const recorded = await run(cwd, [
    "ledger",
    "verdict",
    "tests-verified",
    "--how",
    "ran it",
    "--self",
    "--sha",
    head.slice(0, 12),
    "--json",
  ]);
  expect(recorded.code, recorded.stderr + recorded.stdout).toBe(0);
  expect(recorded.json().data).toMatchObject({ head, result: "tests-verified" });

  const stale = await run(cwd, [
    "ledger",
    "verdict",
    "tests-verified",
    "--how",
    "ran it",
    "--self",
    "--head",
    "0123456789ab",
    "--json",
  ]);
  expect(stale.code).toBe(2);
  expect(stale.json().error).toContain("is not the head of this checkout");
  expect(stale.json().unblock).toContain("keyed to the branch head");
});

test("Given `ledger verdict --repo`, `pr create --head` and `check --list`, When run, Then each names its corrective form", async () => {
  const cwd = repo();
  const cases: Array<[string[], string, string]> = [
    [["ledger", "verdict", "verified", "--how", "x", "--repo", "r"], "--repo", "--cwd <dir>"],
    [["pr", "create", "--title", "t", "--head", "feature/x"], "--head", "git switch <branch>"],
    [["check", "--list"], "--list", "workit check test|lint|typecheck|check"],
  ];
  for (const [argv, flag, fix] of cases) {
    const result = await run(cwd, [...argv, "--json"]);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.json().error).toBe(`unknown option ${flag}`);
    expect(result.json().unblock).toContain(fix);
  }
});

test("Given `workit status` or `workit context`, When run, Then the unblock names the verb that does it", async () => {
  const cwd = repo();
  const status = await run(cwd, ["status", "--json"]);
  expect(status.code).toBe(2);
  expect(status.json().unblock).toContain("workit task status");
  const context = await run(cwd, ["context", "--json"]);
  expect(context.json().unblock).toContain("workit handoff");
  const typo = await run(cwd, ["ledgr", "--json"]);
  expect(typo.json().unblock).toContain("did you mean workit ledger?");
});

test("Given an unknown flag, When it fails, Then the unblock names the closest valid flag", async () => {
  const cwd = repo();
  const result = await run(cwd, ["ci", "wait", "--timout", "5m", "--json"]);
  expect(result.code).toBe(2);
  expect(result.json()).toMatchObject({
    error: "unknown option --timout",
    unblock: "did you mean --timeout? (workit help ci wait)",
  });
  const far = await run(cwd, ["ci", "wait", "--zzzzzz", "--json"]);
  expect(far.json().unblock).toBe("workit help ci wait");
});

test("Given `fanout brief <s> --fanout <n>` and `ledger standing list --name <n>`, When run, Then both spellings reach the plan", async () => {
  const cwd = repo();
  const file = path.join(path.dirname(cwd), `${path.basename(cwd)}-plan.json`);
  writeFileSync(
    file,
    JSON.stringify({
      name: "alpha",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "mundane",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "GET /a answers 200",
          acceptance: ["Given the app, When GET /a, Then the status is 200"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  dirs.push(file);
  expect((await run(cwd, ["fanout", "plan", file, "--json"])).code).toBe(0);

  const viaFanout = await run(cwd, ["fanout", "brief", "a", "--fanout", "alpha", "--json"]);
  const viaName = await run(cwd, ["fanout", "brief", "a", "--name", "alpha", "--json"]);
  expect(viaFanout.code, viaFanout.stderr + viaFanout.stdout).toBe(0);
  expect(viaFanout.json().data).toEqual(viaName.json().data);

  const listed = await run(cwd, ["ledger", "standing", "list", "--name", "alpha", "--json"]);
  expect(listed.code, listed.stderr + listed.stdout).toBe(0);
  expect(listed.json().data.fanout).toBe("alpha");
  const inline = await run(cwd, ["ledger", "standing", "list", "--name=alpha", "--json"]);
  expect(inline.json().data.fanout).toBe("alpha");
});

test("checkFlags leaves everything after a bare -- alone", () => {
  const entry = findVerb("check");
  if (!entry) throw new Error("check verb missing");
  expect(checkFlags(entry, ["--heavy", "--", "npx", "--bogus"])).toEqual({
    args: ["--heavy", "--", "npx", "--bogus"],
  });
  expect(closest("sha", ["head", "base"])).toBeNull();
});
