import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { ledgerDeps } from "@/packages/workit-cli/src/verbs/ledger";

// #759: the user voids a verdict that is wrong on its face (filed on the wrong
// repo or branch) from a terminal; an agent shell never can.

const dirs: string[] = [];
const interactive = ledgerDeps.interactive;
let terminal = true;
beforeEach(() => {
  terminal = true;
  ledgerDeps.interactive = () => terminal;
});
afterEach(() => {
  ledgerDeps.interactive = interactive;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const featureRepo = (): string => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-ledger-void-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "feature.txt"), "feature\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature work");
  return root;
};

/** The environment of a user's own terminal: no agent marker, no host session. */
const userEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env))
    if (
      name.startsWith("CODEX_") ||
      name.startsWith("WORKIT_SESSION") ||
      ["CLAUDECODE", "OPENCODE", "CURSOR_AGENT", "PI_CODING_AGENT", "AI_AGENT", "AGENT"].includes(
        name,
      )
    )
      delete env[name];
  return env;
};

const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** `workit ledger void …` through the real CLI entry. */
const voidVerdict = (cwd: string, args: string[], env: NodeJS.ProcessEnv) =>
  run(cwd, ["ledger", "void", ...args, "--json"], env);

const reviewer = { ...process.env, WORKIT_SESSION_ID: "s-reviewer" };

/** A stray failed verdict on feature/x, by a non-author session: the gate reads failing_verdict. */
const strayFailure = async (root: string): Promise<string> => {
  const recorded = await run(
    root,
    ["ledger", "verdict", "failed", "--kind", "live", "--how", "other repo's PR", "--json"],
    reviewer,
  );
  expect(recorded.code).toBe(0);
  return recorded.json().data.id as string;
};

const gateReasons = async (root: string): Promise<string[]> =>
  (await run(root, ["ledger", "check", "--branch", "feature/x", "--json"], userEnv())).json().data
    .accepted.reasons;

test("the user voids a stray failed verdict from a terminal: the gate stops counting it and list shows why", async () => {
  const root = featureRepo();
  const stray = await strayFailure(root);
  expect(await gateReasons(root)).toContain("failing_verdict");

  const voided = await voidVerdict(root, [stray, "--reason", "wrong repo"], userEnv());

  expect(voided.code).toBe(0);
  expect(voided.json().data).toMatchObject({
    type: "verdict.voided",
    target: stray,
    reason: "wrong repo",
    observer: "workit_cli",
    branch: "feature/x",
  });
  expect(await gateReasons(root)).not.toContain("failing_verdict");
  const listed = (await run(root, ["ledger", "list", "--json"], userEnv())).json().data.rows as {
    id: string;
    voided?: { by: string; reason: string };
  }[];
  expect(listed.find((row) => row.id === stray)?.voided).toMatchObject({
    reason: "wrong repo",
  });
  const human = await run(root, ["ledger", "list"], userEnv());
  expect(human.stdout).toMatch(/verdict \[feature\/x\] \(voided: wrong repo\)/u);
});

test("an agent shell cannot void a verdict, and neither can a headless one; nothing is written", async () => {
  const root = featureRepo();
  const stray = await strayFailure(root);

  const agent = await voidVerdict(root, [stray, "--reason", "wrong repo"], {
    ...userEnv(),
    CLAUDECODE: "1",
  });
  expect(agent.code).not.toBe(0);
  expect(agent.json().error).toContain("void_refused");
  expect(agent.json().error).toContain("CLAUDECODE");

  terminal = false;
  const headless = await voidVerdict(root, [stray, "--reason", "wrong repo"], userEnv());
  expect(headless.code).not.toBe(0);
  expect(headless.json().error).toContain("void_refused");

  expect(await gateReasons(root)).toContain("failing_verdict");
  const voids = (
    await run(root, ["ledger", "list", "--type", "verdict.voided", "--json"], userEnv())
  ).json().data.rows;
  expect(voids).toEqual([]);
});

test("void needs a --reason and a verdict row", async () => {
  const root = featureRepo();
  const stray = await strayFailure(root);
  const noReason = await voidVerdict(root, [stray], userEnv());
  expect(noReason.code).toBe(2);
  expect(noReason.json().error).toContain("--reason");
  const ruling = await run(
    root,
    ["ledger", "ruling", "x", "--why", "y", "--cost-if-wrong", "z", "--json"],
    reviewer,
  );
  const notVerdict = await voidVerdict(root, [ruling.json().data.id, "--reason", "r"], userEnv());
  expect(notVerdict.code).toBe(2);
  expect(notVerdict.json().error).toContain("not a verdict");
  const twice = await voidVerdict(root, [stray, "--reason", "r"], userEnv());
  expect(twice.code).toBe(0);
  const again = await voidVerdict(root, [stray, "--reason", "r"], userEnv());
  expect(again.code).toBe(2);
  expect(again.json().error).toContain("already voided");
});

test("a hand-appended void row does not retire a verdict", async () => {
  const root = featureRepo();
  const stray = await strayFailure(root);
  const ledgerFile = path.join(
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "workit",
    "ledger",
    "ledger.jsonl",
  );
  appendFileSync(
    ledgerFile,
    `${JSON.stringify({ v: 1, id: "forged", at: new Date().toISOString(), type: "verdict.voided", actor: { host: "x", session: null, agentId: null }, branch: "feature/x", head: null, target: stray, reason: "forged", observer: "workit_cli" })}\n`,
  );
  expect(await gateReasons(root)).toContain("failing_verdict");
});

test("the verdict read names the void path for a failing verdict", async () => {
  const root = featureRepo();
  const stray = await strayFailure(root);
  const read = await run(root, ["ledger", "verdict", "feature/x"], userEnv());
  expect(read.stdout).toContain(`workit ledger void ${stray} --reason`);
});
