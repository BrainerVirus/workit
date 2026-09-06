import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "../../packages/workit-core/src/core";
import {
  detectCodexSurface,
  handleCodexHook,
  parseCodexHookInput,
} from "../../packages/workit-codex/hooks/workit-hook";
import { taskStartRequest } from "../workit-core/task-fixtures";

const cwd = () => mkdtempSync(path.join(tmpdir(), "workit-codex-cli-"));
const official = (event: Record<string, unknown>, root = cwd()) => ({
  session_id: "session-1",
  cwd: root,
  model: "gpt-5",
  permission_mode: "default",
  transcript_path: null,
  ...event,
});

test("SessionStart restores one context for startup, resume, and compact", () => {
  for (const source of ["startup", "resume", "compact"] as const) {
    const root = cwd();
    const result = handleCodexHook(official({ hook_event_name: "SessionStart", source }, root));
    expect(result.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
    expect(JSON.stringify(result)).toContain("Workit keeps one accountable lead");
  }
});

test("official payloads validate and malformed or outside writes deny", () => {
  const root = cwd();
  expect(parseCodexHookInput(official({ hook_event_name: "PreToolUse" }, root))).toMatchObject({
    ok: false,
  });
  expect(
    parseCodexHookInput(official({ hook_event_name: "SessionStart", source: "clear" }, root)),
  ).toMatchObject({ ok: true });
  expect(
    parseCodexHookInput(
      official(
        {
          hook_event_name: "SubagentStart",
          turn_id: "turn-1",
          agent_id: "agent-1",
          agent_type: "worker",
        },
        root,
      ),
    ),
  ).toMatchObject({ ok: true });
  expect(
    parseCodexHookInput(
      official({ hook_event_name: "SessionStart", source: "clear", unexpected: true }, root),
    ),
  ).toMatchObject({ ok: false });
  expect(
    handleCodexHook(official({ hook_event_name: "SubagentStart", agent_id: "agent-1" }, root)),
  ).not.toMatchObject({ hookSpecificOutput: { permissionDecision: expect.anything() } });
  expect(
    parseCodexHookInput(
      official(
        {
          hook_event_name: "SubagentStop",
          turn_id: "turn-1",
          agent_id: "agent-1",
          agent_type: "worker",
          agent_transcript_path: null,
          last_assistant_message: null,
          stop_hook_active: false,
        },
        root,
      ),
    ),
  ).toMatchObject({ ok: true });
  expect(
    parseCodexHookInput(
      official(
        {
          hook_event_name: "PreToolUse",
          turn_id: "turn-1",
          tool_use_id: "tool-1",
          tool_name: "Read",
          tool_input: {},
          permission_mode: "invalid",
        },
        root,
      ),
    ),
  ).toMatchObject({ ok: false });
  const denied = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-1",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Update File: /tmp/outside\n*** End Patch" },
      },
      root,
    ),
  );
  expect(denied.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  });
});

test("recognized writes stay transparent without controlled active work", () => {
  const root = cwd();
  const absent = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-1",
        tool_name: "Write",
        tool_input: { file_path: "src/absent.ts" },
      },
      root,
    ),
  );
  expect(absent.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });

  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host: detectCodexSurface(process.env), actor: "session-1" },
    callerAttested: false,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const core = new WorkitCore(store, context);
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const current = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!current.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  const paused = core.task({
    schemaVersion: 1,
    action: "pause",
    taskId: current.data.id,
    expectedRevision: current.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    reason: "test",
  });
  expect(paused.ok).toBe(true);
  const noActive = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-2",
        tool_name: "Write",
        tool_input: { file_path: "src/no-active.ts" },
      },
      root,
    ),
  );
  expect(noActive.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
});

test("ambiguous or corrupt controlled state denies recognized writes", () => {
  const root = cwd();
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host: detectCodexSurface(process.env), actor: "session-1" },
    callerAttested: false,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const core = new WorkitCore(store, context);
  const first = core.task(taskStartRequest());
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  const firstTask = store.readTask((first.data as { id: string }).id);
  const firstWorkspace = store.readWorkspace();
  if (!firstTask.ok || !firstWorkspace.ok || !firstWorkspace.data) throw new Error("state missing");
  const second = core.task(
    taskStartRequest({ expectedWorkspaceRevision: firstWorkspace.data.revision }),
  );
  expect(second.ok).toBe(true);
  const ambiguous = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-1",
        tool_name: "Write",
        tool_input: { file_path: "src/ambiguous.ts" },
      },
      root,
    ),
  );
  expect(ambiguous.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
});

test("PreToolUse delegates every recognized product write to shared core", () => {
  const root = cwd();
  const store = new TaskStore(root);
  const context: OperationContext = {
    root,
    caller: { host: detectCodexSurface(process.env), actor: "session-1" },
    callerAttested: false,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const core = new WorkitCore(store, context);
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: task.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    }).ok,
  ).toBe(true);
  const allowed = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-1",
        tool_name: "Write",
        tool_input: { file_path: "src/ok.ts" },
      },
      root,
    ),
  );
  expect(allowed.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
  const outside = mkdtempSync(path.join(tmpdir(), "workit-codex-outside-"));
  mkdirSync(path.join(root, "links"));
  symlinkSync(outside, path.join(root, "links", "outside"), "dir");
  const escaped = handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-2",
        tool_name: "Write",
        tool_input: { file_path: "links/outside/x.ts" },
      },
      root,
    ),
  );
  expect(escaped.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
});

test("SubagentStop is observational and denial exits zero with JSON", () => {
  const root = cwd();
  expect(
    handleCodexHook(
      official(
        {
          hook_event_name: "SubagentStop",
          turn_id: "turn-1",
          agent_id: "agent-1",
          agent_type: "worker",
          agent_transcript_path: null,
          last_assistant_message: null,
          stop_hook_active: false,
        },
        root,
      ),
    ),
  ).toEqual({});
  const child = spawnSync(
    process.execPath,
    ["run", path.resolve(import.meta.dir, "../../packages/workit-codex/hooks/workit-hook.ts")],
    {
      input: JSON.stringify(
        official(
          {
            hook_event_name: "PreToolUse",
            turn_id: "turn-1",
            tool_use_id: "tool-1",
            tool_name: "Write",
            tool_input: { file_path: "/tmp/no.ts" },
          },
          root,
        ),
      ),
      encoding: "utf8",
    },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});
