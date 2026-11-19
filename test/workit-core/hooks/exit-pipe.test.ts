// #912: `workit ci wait | tail -5` reported tail's exit 0 for a refused wait,
// and the agent read it as "CI finished". A Workit verb whose exit code is
// its answer, piped into tail or head, is denied on every host (Claude Code
// auto mode or not) with the unpiped call; never rewritten (#908).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exitPipeGate } from "@/packages/workit-core/src/hooks/exit-pipe";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

const KEYS = [
  "PATH",
  "HOME",
  "WORKIT_STATE_DIR",
  "WORKIT_CONFIG_DIR",
  "WORKIT_CONFIG",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

beforeAll(() => {
  const [bin, home, state, config] = ["bin", "home", "state", "config"].map((name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `workit-exit-pipe-${name}-`));
    dirs.push(dir);
    return dir;
  }) as [string, string, string, string];
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
    CODEX_HOME: path.join(home, ".codex"),
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-exit-pipe-repo-")));
  dirs.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

const claude = (root: string, command: string, mode: string) =>
  (dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-pipe",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: mode,
    tool_name: "Bash",
    tool_input: { command, description: "run it" },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput ?? {}) as {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };

const retryOf = (reason = "") => reason.split("\n")[1];

test.each([
  ["workit ci wait | tail -5", "tail", "workit ci wait"],
  ["workit ci wait --pr 12 2>&1 | tail -n 20", "tail", "workit ci wait --pr 12"],
  ["workit check test | head -40", "head", "workit check test"],
  ["workit pr merge --pr 7 --squash 2>&1 | tail -3", "tail", "workit pr merge --pr 7 --squash"],
  ["workit release tag v1.2.3 --wait | tail", "tail", "workit release tag v1.2.3 --wait"],
  ["FOO=1 workit --json ci wait | tail -1", "tail", "workit --json ci wait"],
  ["cd /tmp/wt && workit ci wait | tail -5", "tail", "workit ci --cwd /tmp/wt wait"],
  ["workit check --name t -- 'bun test x' | tail", "tail", "workit check --name t -- 'bun test x'"],
])(
  "Given `%s`, When the gate reads it, Then it denies with the unpiped call",
  (command, filter, retry) => {
    const denied = exitPipeGate(command);
    expect(denied?.kind).toBe("deny");
    const reason = denied?.kind === "deny" ? denied.reason : "";
    expect(reason.split("\n")[0]).toMatch(
      new RegExp(`^workit exit-pipe: .+ into ${filter} .+\\.$`, "u"),
    );
    expect(retryOf(reason)).toBe(`Retry as: ${retry}`);
  },
);

test.each([
  ["workit pr status | tail -5"],
  ["workit git push | head -5"],
  ["workit ci wait"],
  ["workit ci wait > out.txt"],
  ["workit ci wait | tee out.txt"],
  ["echo workit ci wait | tail"],
  ["bun test 2>&1 | tail -50"],
])("Given `%s`, When the gate reads it, Then it leaves it alone", (command) => {
  expect(exitPipeGate(command)).toBeNull();
});

test("Given `workit ci wait | tail -5` on Claude Code, auto mode or not, When PreToolUse runs, Then it is denied with no updatedInput and `Retry as: workit ci wait`", () => {
  const root = repo();
  for (const mode of ["auto", "default", "acceptEdits"]) {
    const out = claude(root, "workit ci wait | tail -5", mode);
    expect(out.permissionDecision, mode).toBe("deny");
    expect(out.updatedInput, mode).toBeUndefined();
    expect(retryOf(out.permissionDecisionReason), mode).toBe("Retry as: workit ci wait");
  }
});

test("Given `workit ci wait | tail -5` on Codex, Cursor and Pi, When the shell hook runs, Then each denies naming `workit ci wait`", () => {
  const root = repo();
  const command = "workit ci wait | tail -5";
  const codex = handleCodexHook({
    session_id: "session-pipe",
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  }).hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
  expect(codex.permissionDecision).toBe("deny");
  expect(codex.permissionDecisionReason).toContain("Retry as: workit ci wait");
  const cursor = handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-pipe",
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string; agent_message?: string };
  expect(cursor.permission).toBe("deny");
  expect(cursor.agent_message).toContain("Retry as: workit ci wait");
  const pi = enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input: { command } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  expect(pi?.block).toBe(true);
  expect(pi?.reason).toContain("Retry as: workit ci wait");
});
