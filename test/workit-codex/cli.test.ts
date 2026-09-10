import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import {
  detectCodexSurface,
  handleCodexHook,
  parseCodexHookInput,
  warnOnSurfaceFallback,
} from "@/packages/workit-codex/hooks/workit-hook";
import { resolveCodexWorkspaceRoot } from "@/packages/workit-codex/scripts/launch-mcp";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

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

test("unknown surface override warns but keeps the CLI fallback", () => {
  const prev = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    warnOnSurfaceFallback({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "bogus" });
    expect(chunks.join("")).toContain("codex_cli");
    chunks.length = 0;
    warnOnSurfaceFallback({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" });
    warnOnSurfaceFallback({});
    expect(chunks.join("")).toBe("");
  } finally {
    process.stderr.write = prev;
  }
});

const bashRoot = () => {
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
  const started = new WorkitCore(store, context).task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  return root;
};

const bash = (root: string, command: string) =>
  handleCodexHook(
    official(
      {
        hook_event_name: "PreToolUse",
        turn_id: "turn-1",
        tool_use_id: "tool-1",
        tool_name: "bash",
        tool_input: { command },
      },
      root,
    ),
  );

test("bash intent is shared: quoted echo allows, unlisted verbs and escapes deny", () => {
  const root = bashRoot();
  const outside = path.join(tmpdir(), `wk-codex-outside-${process.pid}.txt`);
  try {
    // Active task, no writer: intent+paths denies, no-intent allows.
    expect(bash(root, 'echo "rm -rf /"').hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
    });
    expect(bash(root, "echo hi").hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
    });
    expect(bash(root, "pip install requests").hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
    });
    expect(bash(root, `tee ${outside}`).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
    });
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(root, "link"));
    expect(bash(root, "tee link").hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("human-bound CLI ownership allows the matching Codex session", () => {
  const root = cwd();
  const store = new TaskStore(root);
  const bound = new WorkitCore(store, {
    root,
    caller: { host: "workit_cli", actor: "session-1" },
    callerAttested: false,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = bound.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const id = (started.data as { id: string }).id;
  const task = store.readTask(id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    bound.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      workerId: null,
    }).ok,
  ).toBe(true);
  // Owner session {workit_cli, session-1} matches the hook's session id.
  expect(
    handleCodexHook(
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
    ).hookSpecificOutput,
  ).toMatchObject({ permissionDecision: "allow" });
  // A different session id stays denied.
  expect(
    handleCodexHook(
      official(
        {
          hook_event_name: "PreToolUse",
          turn_id: "turn-1",
          tool_use_id: "tool-1",
          tool_name: "Write",
          tool_input: { file_path: "src/ok.ts" },
          session_id: "session-2",
        },
        root,
      ),
    ).hookSpecificOutput,
  ).toMatchObject({ permissionDecision: "deny" });
  rmSync(root, { recursive: true, force: true });
});

test("explicit root at the server directory resolves only for a live workspace", () => {
  const live = cwd();
  const fresh = cwd();
  try {
    const started = new WorkitCore(new TaskStore(live), {
      root: live,
      caller: { host: "pi", actor: "seed" },
      callerAttested: true,
      capabilities: [],
      constraints: [],
      now: "2026-01-01T00:00:00Z",
    }).task(
      taskStartRequest({
        intent: {
          objective: "live workspace",
          scope: { description: "scratch", paths: ["."], exclusions: [] },
          authorityRefs: [],
        },
      }),
    );
    expect(started.ok).toBe(true);
    // codex exec spawns the MCP server in the project dir: an explicit live
    // root is operator intent and resolves.
    expect(resolveCodexWorkspaceRoot(live, { WORKFLOW_WORKSPACE_ROOT: live })).toBe(
      path.resolve(live),
    );
    // Without live state the same setup still refuses (never init plugin dirs).
    expect(resolveCodexWorkspaceRoot(fresh, { WORKFLOW_WORKSPACE_ROOT: fresh })).toBeNull();
  } finally {
    rmSync(live, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("workspace root resolution honors explicit root and refuses the plugin dir", () => {
  const pluginRoot = cwd();
  const workspace = cwd();
  try {
    // Fresh checkouts without state resolve so task.start can initialize them.
    expect(resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: workspace })).toBe(
      workspace,
    );
    // The plugin root itself never resolves (would operate on shipped files).
    expect(
      resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: pluginRoot }),
    ).toBeNull();
    // Relative and missing candidates refuse.
    expect(resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: "rel" })).toBeNull();
    expect(resolveCodexWorkspaceRoot(pluginRoot, {})).toBeNull();
    // PWD inherits only when it points outside the plugin root.
    expect(resolveCodexWorkspaceRoot(pluginRoot, { PWD: workspace })).toBe(workspace);
    expect(resolveCodexWorkspaceRoot(pluginRoot, { PWD: pluginRoot })).toBeNull();
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
