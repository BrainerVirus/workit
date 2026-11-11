import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isAllowedWorkitCall,
  userOnlyWorkitCall,
} from "@/packages/workit-core/src/hooks/delivery-verbs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";

// #759: `workit ledger void` is the user's act, gated like grant set and
// release notes approve: Claude Code asks, hosts without an ask deny.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workit-void-gate-")));
  dirs.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "feature/x");
  git("commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(path.join(root, ".git", "workit"));
  return root;
};

const VOID = 'workit --cwd /x ledger void mwbe83fk-fc16482e8b4a --reason "wrong repo"';

test("Given ledger void, When read, Then it is a user-only call and never an allowed one", () => {
  expect(userOnlyWorkitCall(VOID)).toEqual(["ledger", "void"]);
  expect(isAllowedWorkitCall(["workit", "ledger", "void", "x", "--reason", "r"])).toBe(false);
  expect(userOnlyWorkitCall("workit ledger verdict failed --how x")).toBeNull();
  expect(userOnlyWorkitCall("workit ledger list --type verdict.voided")).toBeNull();
});

test("Given an agent's ledger void, When each host's hook runs, Then Claude Code asks and Codex, Cursor and Pi deny", () => {
  const root = repo();
  const claude = dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: VOID },
    tool_use_id: "toolu_1",
  }).json.hookSpecificOutput as { permissionDecision?: string } | undefined;
  expect(claude?.permissionDecision).toBe("ask");

  const codex = handleCodexHook({
    session_id: "session-1",
    cwd: root,
    model: "test",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "PreToolUse",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "bash",
    tool_input: { command: VOID },
  }).hookSpecificOutput as { permissionDecision?: string };
  expect(codex.permissionDecision).toBe("deny");

  const cursor = handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-1",
    workspace_roots: [root],
    cwd: root,
    command: VOID,
  }) as { permission?: string; agent_message?: string };
  expect(cursor.permission).toBe("deny");
  expect(cursor.agent_message).toContain("run it in your own terminal");

  const pi = enforceToolPolicy(
    { toolName: "bash", toolCallId: "call-1", input: { command: VOID } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean } | undefined;
  expect(pi?.block).toBe(true);
});
