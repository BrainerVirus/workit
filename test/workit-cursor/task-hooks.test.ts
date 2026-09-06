import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "../../packages/workit-core/src/core";
import { caller, taskStartRequest } from "../workit-core/task-fixtures";
import {
  cursorCapabilities,
  handleCursorHook,
  parseCursorHookInput,
} from "../../packages/workit-cursor/hooks/workit-hook";

test("Cursor hook capabilities are honest about documented surfaces", () => {
  expect(cursorCapabilities()).toContainEqual(
    expect.objectContaining({ name: "known_product_writes", assurance: "unavailable" }),
  );
  expect(cursorCapabilities({ preToolUse: true })).toContainEqual(
    expect.objectContaining({ name: "known_product_writes", assurance: "enforced" }),
  );
  expect(cursorCapabilities()).toContainEqual(
    expect.objectContaining({ name: "interactive_decision", assurance: "agent_guided" }),
  );
  expect(cursorCapabilities({ preToolUse: false, beforeShellExecution: false })).toContainEqual(
    expect.objectContaining({ name: "arbitrary_shell_write", assurance: "unavailable" }),
  );
});

test("Cursor hook rejects malformed trust-boundary inputs", () => {
  expect(parseCursorHookInput({ hook_event_name: "preToolUse" })).toMatchObject({ ok: false });
  expect(
    handleCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "conv-1",
      workspace_roots: ["/tmp/workit"],
      tool_name: "Write",
      tool_input: { file_path: "src/index.ts" },
    }),
  ).toMatchObject({ permission: "deny" });
  expect(
    parseCursorHookInput({
      hook_event_name: "preToolUse",
      conversation_id: "conv-1",
      session_id: "conv-2",
      workspace_roots: [process.cwd()],
      tool_name: "Write",
    }),
  ).toMatchObject({ ok: false, error: "conversation_id and session_id must match" });
});

test("shell hooks resolve cwd and deny any outside-root write operand", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  expect(
    handleCursorHook({
      hook_event_name: "beforeShellExecution",
      conversation_id: "conv-1",
      workspace_roots: [root],
      cwd: root,
      command: "cp src/in-scope /tmp/outside",
    }),
  ).toMatchObject({
    permission: "deny",
    agent_message: "shell write target is outside or unavailable",
  });
  expect(
    handleCursorHook({
      hook_event_name: "beforeShellExecution",
      conversation_id: "conv-1",
      workspace_roots: [root],
      cwd: nested,
      command: "touch file",
    }),
  ).toEqual({ permission: "allow" });
  expect(
    handleCursorHook({
      hook_event_name: "beforeShellExecution",
      conversation_id: "conv-1",
      workspace_roots: [root],
      cwd: "/tmp",
      command: "touch file",
    }),
  ).toMatchObject({ permission: "deny" });
});

test("shell hooks reject unavailable cwd and attached output redirections", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  for (const command of [">/tmp/out", "2>/tmp/err", "2>&1"]) {
    expect(
      handleCursorHook({
        hook_event_name: "beforeShellExecution",
        conversation_id: "conv-1",
        workspace_roots: [root],
        cwd: root,
        command,
      }),
    ).toMatchObject({ permission: "deny" });
  }
  for (const command of [">>file", "&>file"]) {
    expect(
      handleCursorHook({
        hook_event_name: "beforeShellExecution",
        conversation_id: "conv-1",
        workspace_roots: [root],
        cwd: root,
        command,
      }),
    ).toEqual({ permission: "allow" });
  }
  expect(
    handleCursorHook({
      hook_event_name: "beforeShellExecution",
      conversation_id: "conv-1",
      workspace_roots: [root],
      cwd: path.join(root, "missing"),
      command: "touch file",
    }),
  ).toMatchObject({ permission: "deny" });
});

test("blocking shell hooks deny ambiguous writes while advisory events stay nonblocking", () => {
  expect(
    handleCursorHook({
      hook_event_name: "beforeShellExecution",
      conversation_id: "conv-1",
      workspace_roots: [process.cwd()],
      command: 'printf x > "src/${TARGET}"',
    }),
  ).toMatchObject({ permission: "deny" });
  expect(
    handleCursorHook({
      hook_event_name: "preCompact",
      conversation_id: "conv-1",
      workspace_roots: [process.cwd()],
    }),
  ).toEqual({
    user_message:
      "Workit context may be stale after compaction; re-run inspection or resume before acting.",
  });
});

test("malformed blocking hook input exits fail-closed", () => {
  const result = spawnSync(
    process.execPath,
    ["run", path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks/workit-hook.ts")],
    {
      input: JSON.stringify({ hook_event_name: "beforeShellExecution" }),
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(2);
  expect(result.stdout).toContain('"permission":"deny"');
});

test("subagent starts are assigned once inside an active task and stops without identity stay observational", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ host: "cursor", actor: "parent" }),
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  const input = {
    hook_event_name: "subagentStart",
    conversation_id: "parent",
    parent_conversation_id: "parent",
    subagent_id: "child",
    workspace_roots: [root],
    task: "[workit-role: implementer] implement the bounded change",
  } as const;
  expect(handleCursorHook(input)).toMatchObject({ permission: "allow" });
  expect(handleCursorHook(input)).toMatchObject({ permission: "deny" });
  const beforeStop = new TaskStore(root).listTasks();
  expect(
    handleCursorHook({
      hook_event_name: "subagentStop",
      conversation_id: "parent",
      workspace_roots: [root],
      subagent_id: "child",
      parent_conversation_id: "parent",
      status: "completed",
    }),
  ).toEqual({});
  expect(new TaskStore(root).listTasks()).toEqual(beforeStop);
});

test("active native subagents require explicit Workit roles and preserve reviewer scope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ host: "cursor", actor: "parent" }),
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.task(taskStartRequest()).ok).toBe(true);
  const base = {
    hook_event_name: "subagentStart" as const,
    conversation_id: "parent",
    parent_conversation_id: "parent",
    workspace_roots: [root],
  };
  expect(
    handleCursorHook({ ...base, subagent_id: "missing-role", subagent_type: "generalPurpose" }),
  ).toMatchObject({ permission: "deny" });
  expect(
    handleCursorHook({
      ...base,
      subagent_id: "reviewer",
      subagent_type: "generalPurpose",
      task: "[workit-role: reviewer] inspect the bounded change",
    }),
  ).toMatchObject({ permission: "allow" });
  expect(
    handleCursorHook({
      ...base,
      subagent_id: "implementer",
      subagent_type: "generalPurpose",
      task: "[workit-role: implementer] implement the bounded change",
    }),
  ).toMatchObject({ permission: "allow" });
  const task = new TaskStore(root).listTasks();
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  expect(task.data[0]?.workers.map((worker) => worker.data.assignment.role)).toEqual([
    "reviewer",
    "implementer",
  ]);
  const store = new TaskStore(root);
  const workspace = store.readWorkspace();
  expect(workspace.ok).toBe(true);
  if (!workspace.ok || !workspace.data) return;
  const active = task.data[0]!;
  const reviewer = active.workers[0]!;
  const reviewerCore = new WorkitCore(store, {
    root,
    caller: caller({ host: "cursor", actor: "reviewer" }),
    workerId: reviewer.id,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(
    reviewerCore.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.id,
      expectedRevision: active.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: reviewer.id,
    }),
  ).toMatchObject({ ok: false, code: "permission_denied" });
  const implementer = active.workers[1]!;
  const implementerCore = new WorkitCore(store, {
    root,
    caller: caller({ host: "cursor", actor: "implementer" }),
    workerId: implementer.id,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(
    implementerCore.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.id,
      expectedRevision: active.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: implementer.id,
    }).ok,
  ).toBe(true);
  expect(
    handleCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "reviewer",
      workspace_roots: [root],
      tool_name: "Write",
      tool_input: { file_path: "src/in-scope.ts" },
    }),
  ).toMatchObject({ permission: "deny" });
  expect(
    handleCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "implementer",
      workspace_roots: [root],
      tool_name: "Write",
      tool_input: { file_path: "src/in-scope.ts" },
    }),
  ).toMatchObject({ permission: "allow" });
});

test("subagent hooks remain transparent when no Workit task is active", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  expect(
    handleCursorHook({
      hook_event_name: "subagentStart",
      conversation_id: "parent",
      parent_conversation_id: "parent",
      subagent_id: "child",
      workspace_roots: [root],
    }),
  ).toMatchObject({ permission: "allow" });
});

test("session start remains advisory and restores compact context once", () => {
  const result = handleCursorHook({
    hook_event_name: "sessionStart",
    session_id: "conv-1",
    workspace_roots: [process.cwd()],
  });
  expect(result).toHaveProperty("additional_context");
  expect(result).not.toHaveProperty("permission");
});
