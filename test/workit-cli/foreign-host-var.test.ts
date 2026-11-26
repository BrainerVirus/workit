// #981: a foreign host's session variable set inside a Claude Code shell
// (`OPENCODE_SESSION_ID=nobody-7 workit ledger verdict …`) must not act as a
// nested host whose shell vouches for the session: the lead would judge its
// own branch as an invented, independent-looking session.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { appendObserved } from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

const featureRepo = (author: string): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-foreign-host-"));
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
  appendObserved(root, {
    type: "commit.recorded",
    session: author,
    actor: { host: "claude_code", session: author, agentId: null },
    branch: "feature/x",
  });
  return root;
};

const run = async (cwd: string, argv: string[], env: NodeJS.ProcessEnv) => {
  let stdout = "";
  const code = await main(argv, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  return { code, stdout };
};

const claudeLead = { WORKIT_HOST: "claude_code", WORKIT_SESSION_ID: "lead", CLAUDECODE: "1" };
/** Whether the merge gate (`ledger check`) takes an independent verdict on the branch. */
const gateAccepts = async (root: string): Promise<boolean> =>
  JSON.parse((await run(root, ["ledger", "check", "--json"], claudeLead)).stdout).data.accepted
    .accepted;
const verdict = (root: string, env: NodeJS.ProcessEnv) =>
  run(root, ["ledger", "verdict", "verified", "--how", "x", "--json"], env);

for (const variable of ["OPENCODE_SESSION_ID", "PI_SESSION_ID", "CODEX_THREAD_ID"]) {
  test(`Given a Claude Code lead's shell, When it records a verdict with ${variable}=nobody-7, Then it is refused and the merge gate takes no independent verdict`, async () => {
    const root = featureRepo("lead");
    const recorded = await verdict(root, { ...claudeLead, [variable]: "nobody-7" });
    expect(recorded.code, recorded.stdout).toBe(3);
    expect(await gateAccepts(root)).toBe(false);
    expect(JSON.parse(recorded.stdout).error).toStartWith(
      `foreign_host_session: ${variable} names another host's session`,
    );
  });
}

test("Given only Claude Code's own marks (CLAUDECODE or CLAUDE_CODE_ENTRYPOINT, no WORKIT_HOST), When a foreign host variable names the session, Then it is refused too", async () => {
  const root = featureRepo("lead");
  for (const mark of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) {
    const recorded = await verdict(root, { [mark]: "1", OPENCODE_SESSION_ID: "nobody-7" });
    expect(recorded.code, mark).toBe(3);
    expect(JSON.parse(recorded.stdout).error, mark).toStartWith("foreign_host_session");
  }
});

test("Given a Claude Code lead's shell, When it commits with a foreign host variable, Then the commit is refused, so it cannot author as nobody-7 and judge as itself", async () => {
  const root = featureRepo("lead");
  writeFileSync(path.join(root, "more.txt"), "more\n");
  const commit = await run(
    root,
    ["git", "commit", "-m", "feat: more", "--json", "--", "more.txt"],
    { ...claudeLead, OPENCODE_SESSION_ID: "nobody-7" },
  );
  expect(commit.code, commit.stdout).toBe(3);
  expect(commit.stdout).toContain("foreign_host_session");
});

test.each([
  [
    "an OpenCode child",
    {
      WORKIT_HOST: "opencode",
      OPENCODE_SESSION_ID: "ses_child",
      WORKIT_SESSION_ID: "ses_lead:ses_child",
    },
  ],
  [
    "a Pi worker",
    { WORKIT_HOST: "pi", PI_SESSION_ID: "pi-worker-w1", WORKIT_SESSION_ID: "pi-lead:pi-worker-w1" },
  ],
  ["a Codex thread", { CODEX_THREAD_ID: "t-verifier" }],
])(
  "Given %s's own shell (no Claude Code marks), When it records a verdict on another session's branch, Then it is accepted and the gate takes it",
  async (_label, env) => {
    const root = featureRepo("lead");
    const recorded = await verdict(root, env);
    expect(recorded.code, recorded.stdout).toBe(0);
    expect(JSON.parse(recorded.stdout).data.self).toBe(false);
    expect(await gateAccepts(root)).toBe(true);
  },
);
