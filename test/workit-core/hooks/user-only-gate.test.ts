import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { userOnlyWorkitCall } from "@/packages/workit-core/src/hooks/delivery-verbs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-user-only-")));
  dirs.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

const claude = (root: string, command: string) =>
  dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;

const codex = (root: string, command: string) =>
  handleCodexHook({
    session_id: "session-1",
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

const cursor = (root: string, command: string) =>
  handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command,
  }) as { permission?: string; agent_message?: string };

const pi = (root: string, command: string) =>
  enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input: { command } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;

test.each([
  ["workit grant set ws merge=true", ["grant", "set"]],
  ["workit --cwd /x grant set ws merge=true", ["grant", "set"]],
  ["workit --cwd=/x grant raise ws", ["grant", "raise"]],
  ["workit --json release notes approve 1.0.0", ["release", "notes", "approve"]],
  ["workit --session s1 --json grant set ws merge=true", ["grant", "set"]],
  ["cd /x && /usr/bin/workit --cwd /x grant raise ws", ["grant", "raise"]],
])("Given `%s`, When read, Then it is a user-only call", (command, words) => {
  expect(userOnlyWorkitCall(command)).toEqual(words);
});

test.each([
  ["workit grant show"],
  ["workit help grant set"],
  ["workit release notes draft 1"],
  ["workit --cwd /x grant show ws"],
  ["workit check test -- grant set"],
  ["echo grant set"],
])("Given `%s`, When read, Then it is not a user-only call", (command) => {
  expect(userOnlyWorkitCall(command)).toBeNull();
});

test("Given a user-only call with a global option first on Cursor, When the hook runs, Then it denies", () => {
  const out = cursor(repo(), "workit --cwd /x grant set ws merge=true");
  expect(out.permission).toBe("deny");
  expect(out.agent_message).toContain("run it in your own terminal");
});

test("Given a user-only call on Claude Code, When PreToolUse runs, Then it asks", () => {
  const out = claude(repo(), "workit --json release notes approve 1.0.0");
  expect(out?.permissionDecision).toBe("ask");
});

test("Given workit grant raise on Codex and Pi, When the hook runs, Then it denies", () => {
  const root = repo();
  const out = codex(root, "workit grant raise ws");
  expect(out.permissionDecision).toBe("deny");
  expect(out.permissionDecisionReason).toContain("run it in your own terminal");
  expect(pi(root, "workit --cwd /x grant raise ws")?.block).toBe(true);
});

test.each([["workit grant show"], ["workit help grant set"], ["workit release notes draft 1"]])(
  "Given `%s`, When the hooks run, Then this gate does not deny or ask",
  (command) => {
    const root = repo();
    expect(claude(root, command)?.permissionDecision).toBeUndefined();
    expect(cursor(root, command).permission).not.toBe("deny");
    expect(codex(root, command)?.permissionDecision).toBeUndefined();
    expect(pi(root, command)?.block).toBeUndefined();
  },
);

// Whole-verb user-only calls (round 2 user decision): setup, uninstall,
// install and workspace seal, behind every wrapper an agent reaches for, in a
// repo with no task store, through each host's real entry point: Claude Code's
// and Codex's launchers as processes, Cursor's and Pi's hook handlers.
const WHOLE_VERBS = [
  ["workit setup --yes", ["setup"]],
  ["workit uninstall --hosts=cursor --yes", ["uninstall"]],
  ["workit install --hosts=cursor --yes", ["install"]],
  ["workit workspace seal", ["workspace", "seal"]],
] as const;
const WRAPPED = (command: string): string[] => {
  const rest = command.replace(/^workit /u, "");
  return [
    command,
    `env -u CLAUDECODE ${command}`,
    `AI_AGENT=1 ${command}`,
    `command ${command}`,
    `cd x && ${command}`,
    `workit --cwd /x ${rest}`,
    `workit --json ${rest}`,
  ];
};
const ROOT = path.resolve(import.meta.dir, "../../..");
const noStore = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-user-only-ns-")));
  dirs.push(root);
  spawnSync("git", ["init", "-q", "-b", "feature/x"], { cwd: root });
  return root;
};
const launcherEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: root,
  CLAUDE_CONFIG_DIR: path.join(root, ".claude-home"),
  CODEX_HOME: path.join(root, ".codex-home"),
  WORKIT_STATE_DIR: path.join(root, ".state"),
  WORKIT_CONFIG_DIR: path.join(root, ".config"),
});
const launch = (entry: [string, string], root: string, payload: Record<string, unknown>) => {
  const child = spawnSync(entry[0], entry.slice(1), {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: launcherEnv(root),
    timeout: 60_000,
  });
  expect(child.status, child.stderr).toBe(0);
  return (
    JSON.parse(child.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
};
const claudeLauncher = (root: string, command: string) =>
  launch(["node", path.join(ROOT, "packages/workit-claude-code/bin/workit-hook.mjs")], root, {
    hook_event_name: "PreToolUse",
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: "/tmp/x.jsonl",
    cwd: root,
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "d" },
    tool_use_id: "toolu_user_only",
  });
const codexLauncher = (root: string, command: string) =>
  launch([process.execPath, path.join(ROOT, "packages/workit-codex/hooks/launcher.ts")], root, {
    session_id: "session-1",
    cwd: root,
    model: "gpt-5",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command },
  });

test("G setup, uninstall, install and workspace seal behind any wrapper or global option, W an agent runs one in a repo with no task store, T Claude Code asks, Codex, Cursor and Pi deny naming the user's terminal", () => {
  const root = noStore();
  for (const [call, words] of WHOLE_VERBS)
    for (const command of WRAPPED(call)) {
      expect(userOnlyWorkitCall(command), command).toEqual([...words]);
      const named = `\`workit ${words.join(" ")}\``;
      const asked = claudeLauncher(root, command);
      expect(asked?.permissionDecision, command).toBe("ask");
      expect(asked?.permissionDecisionReason, command).toContain(named);
      const denied = codexLauncher(root, command);
      expect(denied?.permissionDecision, command).toBe("deny");
      expect(denied?.permissionDecisionReason, command).toContain("run it in your own terminal");
      const out = cursor(root, command);
      expect(out.permission, command).toBe("deny");
      expect(out.agent_message, command).toContain("run it in your own terminal");
      const blocked = pi(root, command);
      expect(blocked?.block, command).toBe(true);
      expect(blocked?.reason, command).toContain("run it in your own terminal");
    }
}, 600_000);

// Spellings the gate's own parser resolves (ruling hook-reach-2026-11-13, 4.1):
// a backslash-newline inside a word, ANSI-C quoting.
test.each([
  ["workit gr\\\nant set a b=c", ["grant", "set"]],
  ["work\\\nit setup --yes", ["setup"]],
  ["workit s$'e'tup --yes", ["setup"]],
])(
  "G `%s`, W an agent runs it, T every host's entry asks or denies it",
  (command, words) => {
    const root = noStore();
    expect(userOnlyWorkitCall(command)).toEqual(words);
    expect(claudeLauncher(root, command)?.permissionDecision).toBe("ask");
    expect(codexLauncher(root, command)?.permissionDecision).toBe("deny");
    expect(cursor(root, command).permission).toBe("deny");
    expect(pi(root, command)?.block).toBe(true);
  },
  120_000,
);

test.each([
  ["workit help setup"],
  ["workit check -- npm install"],
  ['workit ledger decision "never run workit setup --yes" --why x'],
])(
  "G `%s`, W the launchers and hooks run it, T it is not a user-only call",
  (command) => {
    const root = noStore();
    expect(userOnlyWorkitCall(command)).toBeNull();
    expect(claudeLauncher(root, command)?.permissionDecision).toBeUndefined();
    expect(codexLauncher(root, command)?.permissionDecision).toBeUndefined();
    expect(cursor(root, command).permission).not.toBe("deny");
    expect(pi(root, command)?.block).toBeUndefined();
  },
  120_000,
);
