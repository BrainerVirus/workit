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
