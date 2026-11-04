// #312: a verifier subagent resumed after its lead crashed no longer has the
// token its SubagentStart hook gave it. A token is issued once (re-issuing
// would let anyone supersede that reviewer's failure), so the refusal names
// the way back: rerun with the token if the context still shows it, else the
// lead spawns a fresh verifier, whose SubagentStart prints the whole command.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { recordIssuedSession } from "@/packages/workit-core/src/host-session";
import { unboundRecovery } from "@/packages/workit-core/src/ledger";

// Issued ids live in the user state dir: this file gets its own.
const runState = process.env.WORKIT_STATE_DIR;
const ownState = mkdtempSync(path.join(os.tmpdir(), "wk-state-unbound-"));
beforeAll(() => {
  process.env.WORKIT_STATE_DIR = ownState;
});
afterAll(() => {
  if (runState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = runState;
  rmSync(ownState, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-unbound-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "# app\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature");
  return root;
};

const run = async (argv: string[], cwd: string, env: Record<string, string>) => {
  let stdout = "";
  const base = { ...process.env };
  for (const key of [
    "WORKIT_SESSION_ID",
    "WORKIT_SESSION_TOKEN",
    "WORKIT_HOST",
    "CODEX_THREAD_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
  ])
    delete base[key];
  const io: Partial<Io> = {
    cwd,
    env: { ...base, ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, json: () => JSON.parse(stdout) };
};

const verdict = (session: string, token?: string) => [
  "ledger",
  "verdict",
  "verified",
  "--kind",
  "unit",
  "--branch",
  "feature/x",
  "--session",
  session,
  ...(token ? [`--token=${token}`] : []),
  "--how",
  "re-ran the unit suite",
  "--json",
];

test("Given a verifier resumed after its lead crashed (its token lost), When it records a verdict, Then the refusal names the recovery: rerun with --token, else a fresh verifier", async () => {
  const root = repo();
  const id = "lead-crashed:verifier-a1";
  const token = recordIssuedSession(root, "lead-crashed", id) as string;
  expect(token).toBeString();
  const env = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead-crashed" };

  const lost = await run(verdict(id), root, env);
  expect(lost.code).not.toBe(0);
  const body = lost.json();
  expect(body.error).toContain("unbound_session");
  expect(body.unblock).toContain(`no command rebinds ${id}`);
  expect(body.unblock).toContain("--token=<that token>");
  expect(body.unblock).toContain("the lead spawns a fresh verifier for feature/x");

  // With the token still in its context, the resumed verifier records.
  const kept = await run(verdict(id, token), root, env);
  expect(kept.code).toBe(0);
});

test("unboundRecovery names the id and the branch", () => {
  const text = unboundRecovery("lead:v9", "fix/a");
  expect(text).toContain("no command rebinds lead:v9");
  expect(text).toContain("fresh verifier for fix/a");
});
