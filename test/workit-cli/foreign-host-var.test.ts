// #981: a foreign host's session variable set inside a Claude Code shell
// (`OPENCODE_SESSION_ID=nobody-7 workit ledger verdict …`) must not act as a
// nested host whose shell vouches for the session: the lead would judge its
// own branch as an invented, independent-looking session. #986: the same on
// every host: two host session variables, or one that disagrees with the
// shell's own host (WORKIT_HOST, Claude Code's or Cursor's marks).
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

// #986: each host's own shell, and a foreign variable added to it.
const hostShells: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, string]> = [
  ["Codex", { CODEX_THREAD_ID: "t-lead" }, "PI_SESSION_ID"],
  ["Pi", { PI_SESSION_ID: "pi-lead" }, "OPENCODE_SESSION_ID"],
  ["OpenCode", { WORKIT_HOST: "opencode", OPENCODE_SESSION_ID: "ses_lead" }, "CODEX_THREAD_ID"],
  ["Cursor", { CURSOR_AGENT: "1", WORKIT_SESSION_ID: "lead" }, "OPENCODE_SESSION_ID"],
  ["a WORKIT_HOST=codex_cli shell", { WORKIT_HOST: "codex_cli" }, "OPENCODE_SESSION_ID"],
  ["a WORKIT_HOST=cursor shell", { WORKIT_HOST: "cursor" }, "PI_SESSION_ID"],
];

test.each(hostShells)(
  "Given a real %s shell, When it records a verdict with a foreign host variable, Then it is refused and the merge gate takes no independent verdict (#986)",
  async (_label, shell, foreign) => {
    const root = featureRepo("lead");
    // The issue's forgery (OPENCODE_SESSION_ID, first by read order) and another
    // host's; replacing the shell's own variable is the identity guard's (#981).
    for (const variable of new Set([foreign, "OPENCODE_SESSION_ID"])) {
      if (variable in shell) continue;
      const recorded = await verdict(root, { ...shell, [variable]: "nobody-7" });
      expect(recorded.code, `${variable}: ${recorded.stdout}`).toBe(3);
      expect(JSON.parse(recorded.stdout).error).toStartWith("foreign_host_session");
    }
    expect(await gateAccepts(root)).toBe(false);
  },
);

test.each(hostShells)(
  "Given a real %s shell, When it commits with a foreign host variable, Then the commit is refused (#986)",
  async (_label, shell, foreign) => {
    const root = featureRepo("lead");
    writeFileSync(path.join(root, "more.txt"), "more\n");
    const commit = await run(
      root,
      ["git", "commit", "-m", "feat: more", "--json", "--", "more.txt"],
      { ...shell, [foreign]: "nobody-7" },
    );
    expect(commit.code, commit.stdout).toBe(3);
    expect(commit.stdout).toContain("foreign_host_session");
  },
);

test.each(hostShells)(
  "Given a real %s shell, When it records a --self verdict with a foreign host variable, Then it is refused, never recorded under the foreign session (#986)",
  async (_label, shell, foreign) => {
    const root = featureRepo("lead");
    const recorded = await run(
      root,
      ["ledger", "verdict", "verified", "--self", "--how", "x", "--json"],
      { ...shell, [foreign]: "nobody-7" },
    );
    expect(recorded.code, recorded.stdout).toBe(3);
    expect(JSON.parse(recorded.stdout).error).toStartWith("foreign_host_session");
    const list = await run(root, ["ledger", "list", "--json"], claudeLead);
    expect(list.stdout).not.toContain("nobody-7");
  },
);

test.each([
  ["Codex", { CODEX_THREAD_ID: "t-verifier" }],
  ["Codex Desktop", { WORKIT_HOST: "codex_desktop", CODEX_THREAD_ID: "t-verifier" }],
  ["Pi", { PI_SESSION_ID: "pi-verifier" }],
  ["OpenCode", { WORKIT_HOST: "opencode", OPENCODE_SESSION_ID: "ses_verifier" }],
])(
  "Given a real %s lead's own shell, When it records a verdict on another session's branch and commits, Then both are accepted (#986)",
  async (_label, env) => {
    const root = featureRepo("lead");
    const recorded = await verdict(root, env);
    expect(recorded.code, recorded.stdout).toBe(0);
    expect(JSON.parse(recorded.stdout).data.self).toBe(false);
    expect(await gateAccepts(root)).toBe(true);
    writeFileSync(path.join(root, "more.txt"), "more\n");
    const commit = await run(
      root,
      ["git", "commit", "-m", "feat: more", "--json", "--", "more.txt"],
      env,
    );
    expect(commit.code, commit.stdout).toBe(0);
  },
);

test("Given a real Cursor shell, When a session names itself with --session, Then its verdict is recorded and the gate takes it (#986)", async () => {
  const root = featureRepo("lead");
  const recorded = await run(
    root,
    ["--session", "cursor-verifier", "ledger", "verdict", "verified", "--how", "x", "--json"],
    { CURSOR_AGENT: "1" },
  );
  expect(recorded.code, recorded.stdout).toBe(0);
  expect(JSON.parse(recorded.stdout).data.self).toBe(false);
  expect(await gateAccepts(root)).toBe(true);
});
