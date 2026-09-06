import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync } from "node:fs";
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
  ).toEqual({});
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
    task: "implement the bounded change",
  } as const;
  expect(handleCursorHook(input)).toMatchObject({ permission: "allow" });
  expect(handleCursorHook(input)).toMatchObject({ permission: "deny" });
  expect(
    handleCursorHook({
      hook_event_name: "subagentStop",
      conversation_id: "parent",
      workspace_roots: [root],
      status: "completed",
    }),
  ).toEqual({});
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
