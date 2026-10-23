import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, parseGlobals } from "@/packages/workit-cli/src/main";

// `workit --session <id> …`: the global form of WORKIT_SESSION_ID, for hosts
// (Cursor) whose allowlist cannot match a command that starts with an env
// assignment. It is the env var's equal: the flag wins over the variable, and
// where the host checks the session it cannot claim another one.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const repo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-session-flag-"));
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

/** The shell with no host or session variable of its own, plus `extra`. */
const shell = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_WORKSPACE_ROOT: "" };
  for (const key of [
    "WORKIT_HOST",
    "WORKIT_SESSION_ID",
    "OPENCODE_SESSION_ID",
    "PI_SESSION_ID",
    "CODEX_THREAD_ID",
  ])
    delete env[key];
  return { ...env, ...extra };
};

const run = async (cwd: string, env: NodeJS.ProcessEnv, argv: string[]) => {
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

/** The session of the decision row `ledger decision` just recorded. */
const decisionSession = async (cwd: string, env: NodeJS.ProcessEnv) => {
  const listed = await run(cwd, env, ["ledger", "list", "--type", "decision", "--json"]);
  return listed.json().data.rows[0].actor.session;
};

test("G --session before the command, T it is consumed as a global; after the command it stays the verb's own flag", () => {
  expect(parseGlobals(["--session", "s-1", "ledger", "decision"])).toEqual({
    json: false,
    cwd: null,
    session: "s-1",
    rest: ["ledger", "decision"],
  });
  expect(parseGlobals(["--session=s-2", "check"]).session).toBe("s-2");
  expect(parseGlobals(["ledger", "verdict", "--session", "lead:v1"]).rest).toEqual([
    "ledger",
    "verdict",
    "--session",
    "lead:v1",
  ]);
  expect(parseGlobals(["--session"]).error).toBe("--session requires an id");
});

test("G a shell with no host session, W `workit --session <id> ledger decision` runs, T the row is recorded under that id and the flag beats WORKIT_SESSION_ID", async () => {
  const root = repo();
  const env = shell({});
  const recorded = await run(root, env, [
    "--session",
    "cursor-conv-1",
    "ledger",
    "decision",
    "pick A",
    "--why",
    "reversible",
  ]);
  expect(recorded.code).toBe(0);
  expect(await decisionSession(root, env)).toBe("cursor-conv-1");

  const other = repo();
  const both = shell({ WORKIT_SESSION_ID: "from-env" });
  await run(other, both, ["--session", "from-flag", "ledger", "decision", "pick B", "--why", "w"]);
  expect(await decisionSession(other, both)).toBe("from-flag");
  await run(other, both, ["ledger", "decision", "pick C", "--why", "w"]);
  const rows = (await run(other, both, ["ledger", "list", "--type", "decision", "--json"])).json()
    .data.rows;
  expect(rows.map((row: { actor: { session: string } }) => row.actor.session).toSorted()).toEqual([
    "from-env",
    "from-flag",
  ]);
});

test("G a host whose session is checked (Claude Code, OpenCode), W --session names another session, T it is refused like the env var; its own id is accepted", async () => {
  const root = repo();
  const claude = shell({ WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "real-session" });
  const forged = await run(root, claude, [
    "--session",
    "someone-else",
    "ledger",
    "decision",
    "pick A",
    "--why",
    "w",
  ]);
  expect(forged.code).not.toBe(0);
  expect(forged.stderr).toContain("forged_session");
  const own = await run(root, claude, [
    "--session",
    "real-session",
    "ledger",
    "decision",
    "pick A",
    "--why",
    "w",
  ]);
  expect(own.code).toBe(0);

  const opencode = shell({ OPENCODE_SESSION_ID: "oc-real", WORKIT_HOST: "opencode" });
  const refused = await run(root, opencode, [
    "--session",
    "oc-other",
    "ledger",
    "decision",
    "pick B",
    "--why",
    "w",
  ]);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("forged_session");
});
