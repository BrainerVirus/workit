// #908: Claude Code's auto mode refuses a call whose input a PreToolUse hook
// changed after the classifier reviewed it, so under auto mode Workit never
// rewrites a Bash call: it denies with the exact call to send instead. Outside
// auto mode the rewrites stay.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

const KEYS = [
  "PATH",
  "HOME",
  "WORKIT_STATE_DIR",
  "WORKIT_CONFIG_DIR",
  "WORKIT_CONFIG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "XDG_CONFIG_HOME",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

beforeAll(() => {
  const [bin, home, state, config] = ["bin", "home", "state", "config"].map((name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `workit-auto-${name}-`));
    dirs.push(dir);
    return dir;
  }) as [string, string, string, string];
  // A `workit` on PATH: the heavy gate and the npx route need one to run.
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  writeFileSync(
    path.join(config, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  for (const key of ["CLAUDE_PROJECT_DIR", "WORKIT_CONFIG"]) delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
    HOME: home,
    WORKIT_STATE_DIR: state,
    WORKIT_CONFIG_DIR: config,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
});
afterAll(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-auto-repo-")));
  dirs.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

type Out = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
};
const pre = (root: string, command: string, mode: string): Out =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-auto",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: mode,
    tool_name: "Bash",
    tool_input: { command, description: "run it" },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput ?? {};

/** Each Bash rewrite Workit makes on Claude Code: the command and the call it becomes. */
const REWRITES = (wt: string): [string, string, string][] => [
  ["cwd", `cd ${wt} && workit check test`, `workit --cwd ${wt} check test`],
  ["heavy", "npx jest", "workit check --heavy -- npx jest"],
  ["dev server", "npm run dev", "workit run --bg -- npm run dev"],
  ["npx", "npx -y @workit-dev/cli check test", "workit check test"],
];

test("Given Claude Code auto mode, When each rewritable Bash call runs, Then it is denied with no updatedInput and `Retry as:` names the exact call", () => {
  const wt = repo();
  for (const [gate, command, retry] of REWRITES(wt)) {
    const out = pre(wt, command, "auto");
    expect(out.updatedInput, gate).toBeUndefined();
    expect(out.permissionDecision, gate).toBe("deny");
    const [first, second] = (out.permissionDecisionReason ?? "").split("\n");
    expect(first, gate).toMatch(/^workit [\w-]+: .+\.$/u);
    expect(second, gate).toBe(`Retry as: ${retry}`);
  }
});

test("Given Claude Code auto mode, When the agent sends the Retry as call, Then it runs unchanged on the first retry", () => {
  const wt = repo();
  for (const [gate, , retry] of REWRITES(wt)) {
    const out = pre(wt, retry, "auto");
    expect(out.permissionDecision, gate).toBeUndefined();
    expect(out.updatedInput, gate).toBeUndefined();
  }
});

test("Given a mode other than auto, When each rewritable Bash call runs, Then it is rewritten as before, with no permission decision", () => {
  const wt = repo();
  for (const mode of ["default", "acceptEdits", "bypassPermissions"])
    for (const [gate, command, retry] of REWRITES(wt)) {
      const out = pre(wt, command, mode);
      expect(out.permissionDecision, `${mode} ${gate}`).toBeUndefined();
      expect(out.updatedInput?.command, `${mode} ${gate}`).toBe(retry);
    }
});

test("Given Claude Code auto mode and `workit --cwd <dir> git status`, When the hook runs, Then the call runs as written (the verb-first reorder is skipped, not denied)", () => {
  const wt = repo();
  const out = pre(wt, `workit --cwd ${wt} git status`, "auto");
  expect(out.permissionDecision).toBeUndefined();
  expect(out.updatedInput).toBeUndefined();
  expect(pre(wt, `workit --cwd ${wt} git status`, "default").updatedInput?.command).toBe(
    `workit git --cwd ${wt} status`,
  );
});
