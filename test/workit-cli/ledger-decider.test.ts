import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";

// `workit ledger decision --by decider`: a tie-breaker agent's call, recorded with
// each decider's view, never the user's product-choice answer.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-ledger-decider-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "1\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  return root;
};

const run = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-lead", WORKFLOW_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

test("given two deciders that disagree, when the lead records the more reversible pick, then the row carries both views and is listed as a decider call", async () => {
  const root = repo();
  const recorded = await run(root, [
    "ledger",
    "decision",
    "Keep the flag default off",
    "--by",
    "decider",
    "--why",
    "off is reversible by config, on is not",
    "--view",
    "opus: default on, users expect it",
    "--view",
    "sonnet: default off, cheaper to undo",
    "--json",
  ]);
  expect(recorded.code).toBe(0);
  const row = (await run(root, ["ledger", "list", "--type", "decision", "--json"])).json().data
    .rows[0];
  expect(row.by).toBe("decider");
  expect(row.views).toEqual([
    "opus: default on, users expect it",
    "sonnet: default off, cheaper to undo",
  ]);
  const human = await run(root, ["ledger", "list"]);
  expect(human.stdout).toContain("(decider)");
  expect(human.stdout).toContain("[decider] Keep the flag default off");
  expect(human.stdout).toContain("views: opus: default on");
});

test("given a decider decision, when the branch is checked, then it is no verdict", async () => {
  const root = repo();
  await run(root, ["ledger", "decision", "pick B", "--by", "decider", "--why", "reversible"]);
  const verdicts = await run(root, ["ledger", "list", "--type", "verdict", "--json"]);
  expect(verdicts.json().data.rows).toHaveLength(0);
  const check = await run(root, ["ledger", "check", "--json"]);
  expect(JSON.stringify(check.json())).not.toContain('"accepted":true');
});

test("given --by with an unknown actor or --view without --by decider, then the call is refused", async () => {
  const root = repo();
  const user = await run(root, ["ledger", "decision", "x", "--by", "user", "--why", "w"]);
  expect(user.code).not.toBe(0);
  expect(user.stderr).toContain("decider");
  const orphan = await run(root, ["ledger", "decision", "x", "--view", "a", "--why", "w"]);
  expect(orphan.code).not.toBe(0);
  expect(orphan.stderr).toContain("--view needs --by decider");
});
