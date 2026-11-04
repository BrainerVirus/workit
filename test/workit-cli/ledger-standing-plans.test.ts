// #641: with several fanout plans recorded, `ledger standing` and `fanout
// status` name `--fanout <name>` and the candidates, `--fanout` picks one, and
// a plan led by this session is the default. Real git repositories, the real
// CLI entry.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-standing-plans-config-");
});
afterAll(() => configHome.restore());

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
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-standing-plans-"));
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
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", "chore: base");
  return { root, cwd };
};

const plan = async (cwd: string, root: string, name: string, session: string) => {
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
  const result = await run(cwd, ["fanout", "plan", file, "--json"], session);
  expect(result.code, result.stderr + result.stdout).toBe(0);
};

test("given two fanout plans led by one session, then ledger standing and fanout status name --fanout and both plans, and --fanout picks one", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one", "lead-1");
  await plan(cwd, root, "wave-two", "lead-1");
  for (const argv of [
    ["ledger", "standing", "list", "--json"],
    ["ledger", "standing", "add", "keep going", "--json"],
    ["fanout", "status", "--offline", "--json"],
  ]) {
    const result = await run(cwd, argv);
    expect(result.code, argv.join(" ")).toBe(2);
    const error = result.json().error as string;
    expect(error).toContain("--fanout <name>");
    expect(error).toContain("wave-one");
    expect(error).toContain("wave-two");
    expect(error.match(/--fanout/gu)?.length).toBe(1);
  }
  const listed = await run(cwd, ["ledger", "standing", "list", "--fanout", "wave-two", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.json().data.fanout).toBe("wave-two");
  const status = await run(cwd, [
    "fanout",
    "status",
    "--offline",
    "--fanout",
    "wave-one",
    "--json",
  ]);
  expect(status.code, status.stderr).toBe(0);
  expect(status.json().data.name).toBe("wave-one");
});

test("given two fanout plans with different leads, then each lead's session defaults to its own plan", async () => {
  const { root, cwd } = repo();
  await plan(cwd, root, "wave-one", "lead-1");
  await plan(cwd, root, "wave-two", "lead-2");
  const mine = await run(cwd, ["ledger", "standing", "list", "--json"], "lead-2");
  expect(mine.code, mine.stderr).toBe(0);
  expect(mine.json().data.fanout).toBe("wave-two");
  const status = await run(cwd, ["fanout", "status", "--offline", "--json"], "lead-1");
  expect(status.code, status.stderr).toBe(0);
  expect(status.json().data.name).toBe("wave-one");
  const stranger = await run(cwd, ["fanout", "status", "--offline", "--json"], "other-3");
  expect(stranger.code).toBe(2);
  expect(stranger.json().error).toContain("pick one with --fanout <name>: wave-one, wave-two");
});
