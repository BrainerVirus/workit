import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { server as plugin } from "@/packages/workit-opencode/src/index";
import { enforceNativeWriter } from "@/packages/workit-pi/src/tools";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";
import { handleCursorHook } from "@/packages/workit-cursor/hooks/workit-hook";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";

const previousEnv = {
  config: process.env.WORKFLOW_TOOLKIT_CONFIG,
  configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  profile: process.env.WORKFLOW_PROFILE,
  workspace: process.env.WORKFLOW_WORKSPACE_NAME,
};
let configDir: string;
beforeAll(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "workit-route-policy-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterAll(() => {
  if (previousEnv.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousEnv.config;
  if (previousEnv.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previousEnv.configDir;
  if (previousEnv.profile === undefined) delete process.env.WORKFLOW_PROFILE;
  else process.env.WORKFLOW_PROFILE = previousEnv.profile;
  if (previousEnv.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = previousEnv.workspace;
  rmSync(configDir, { recursive: true, force: true });
});

const startTask = (root: string, host: OperationContext["caller"]["host"]) => {
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host, actor: "test-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const started = new WorkitCore(store, context).task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
};

// Each adapter returns its denial reason, or null when the command passes.
const opencodeDenial = async (root: string, command: string): Promise<string | null> => {
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL("http://localhost"),
  } as never);
  try {
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "lead", callID: command } as never,
      { args: { command } } as never,
    );
    return null;
  } catch (error) {
    return String(error);
  }
};

const piDenial = (root: string, command: string): string | null => {
  const result = enforceNativeWriter(
    { toolName: "bash", input: { command } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  if (result === undefined) return null;
  expect(result.block).toBe(true);
  return String(result.reason);
};

const codexResult = (root: string, command: string) => {
  const result = handleCodexHook({
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
  });
  return result.hookSpecificOutput as { hookEventName: string; permissionDecision?: string };
};

const codexDenies = (root: string, command: string): boolean => {
  const result = codexResult(root, command);
  return result.permissionDecision === "deny";
};

const cursorDenies = (root: string, command: string): boolean => {
  const result = handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "conversation-1",
    workspace_roots: [root],
    cwd: root,
    command,
  });
  return result.permission === "deny";
};

const claudeDenies = (root: string, command: string): boolean => {
  const result = dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: root,
    transcript_path: "/tmp/transcript.jsonl",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_1",
  });
  const output = result.json.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return output?.permissionDecision === "deny";
};

test("all adapters enforce only recognized noncompliant branch targets", async () => {
  for (const hasTask of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), "workit-parity-"));
    try {
      if (hasTask) startTask(root, "opencode");
      for (const [command, denied] of [
        ["git checkout -b main", true],
        ["git switch -c feature/raw", false],
        ["git checkout -b feature/raw", false],
        ["git status --short", false],
        ["gh pr create --fill", false],
        ["git worktree add ../other", false],
        ['git checkout -b "main"', false],
      ] as const) {
        const opencode = await opencodeDenial(root, command);
        const pi = piDenial(root, command);
        expect(opencode !== null, `opencode ${command}`).toBe(denied);
        expect(pi !== null, `pi ${command}`).toBe(denied);
        if (denied) {
          expect(opencode, `opencode ${command}`).toContain("protected_ref");
          expect(pi, `pi ${command}`).toContain("protected_ref");
        }
        expect(codexDenies(root, command), `codex ${command}`).toBe(denied);
        expect(cursorDenies(root, command), `cursor ${command}`).toBe(denied);
        expect(claudeDenies(root, command), `claude_code ${command}`).toBe(denied);
      }
      expect(codexResult(root, "git status --short")).toEqual({ hookEventName: "PreToolUse" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
