import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import plugin from "@/packages/workit-opencode/src/plugin";
import { enforceNativeWriter } from "@/packages/workit-pi/src/tools";
import { handleCodexHook } from "@/packages/workit-codex/hooks/workit-hook";

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

const opencodeDenies = async (root: string, command: string): Promise<boolean> => {
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
    return false;
  } catch {
    return true;
  }
};

const piDenies = (root: string, command: string): boolean =>
  enforceNativeWriter(
    { toolName: "bash", input: { command } } as never,
    { cwd: root, isProjectTrusted: () => true } as never,
  ) !== undefined;

const codexDenies = (root: string, command: string): boolean => {
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
  return (
    (result.hookSpecificOutput as { permissionDecision?: string })?.permissionDecision === "deny"
  );
};

test("all hosts deny route commands inside live work and allow them outside", async () => {
  for (const command of ["git checkout -b feature/raw", "gh pr create --fill"]) {
    const live = mkdtempSync(path.join(tmpdir(), "workit-parity-live-"));
    const bare = mkdtempSync(path.join(tmpdir(), "workit-parity-bare-"));
    try {
      startTask(live, "opencode");
      expect(await opencodeDenies(live, command), `opencode live ${command}`).toBe(true);
      expect(await opencodeDenies(bare, command), `opencode bare ${command}`).toBe(false);
      expect(piDenies(live, command), `pi live ${command}`).toBe(true);
      expect(piDenies(bare, command), `pi bare ${command}`).toBe(false);
      expect(codexDenies(live, command), `codex live ${command}`).toBe(true);
      expect(codexDenies(bare, command), `codex bare ${command}`).toBe(false);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  }
});
