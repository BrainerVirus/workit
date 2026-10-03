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
const expectHostPermissionUnchanged = (output: unknown) =>
  expect(output).toEqual({ hookEventName: "PreToolUse" });
const withTestBranchPolicy = (run: () => void) => {
  const previous = {
    config: process.env.WORKFLOW_TOOLKIT_CONFIG,
    configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
    profile: process.env.WORKFLOW_PROFILE,
    workspace: process.env.WORKFLOW_WORKSPACE_NAME,
  };
  const configDir = mkdtempSync(path.join(tmpdir(), "workit-codex-policy-"));
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
  try {
    run();
  } finally {
    if (previous.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous.config;
    if (previous.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previous.configDir;
    if (previous.profile === undefined) delete process.env.WORKFLOW_PROFILE;
    else process.env.WORKFLOW_PROFILE = previous.profile;
    if (previous.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
    else process.env.WORKFLOW_WORKSPACE_NAME = previous.workspace;
    rmSync(configDir, { recursive: true, force: true });
  }
};

test("SessionStart restores one context for startup, resume, and compact", () => {
  for (const source of ["startup", "resume", "compact"] as const) {
    const root = cwd();
    const result = handleCodexHook(official({ hook_event_name: "SessionStart", source }, root));
    expect(result.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
    expect(JSON.stringify(result)).toContain("Workit is optional coordination");
  }
});

test("SessionStart offers unfinished history once on startup without writing task state", () => {
  const root = cwd();
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "codex_cli", actor: "old-codex-session" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = core.task(
    taskStartRequest({
      intent: {
        objective: "parked Codex history",
        scope: { description: "the checkout", paths: ["."], exclusions: [] },
        authorityRefs: [],
      },
    }),
  );
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("task missing");
  const taskId = (started.data as { id: string }).id;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
  expect(
    core.task({
      schemaVersion: 1,
      action: "pause",
      taskId,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "park for later",
    }).ok,
  ).toBe(true);
  const session = `codex-history-${crypto.randomUUID()}`;
  const host = detectCodexSurface(process.env);
  const otherHost = host === "codex_cli" ? "codex_desktop" : "codex_cli";
  const afterPause = store.readWorkspace();
  if (!afterPause.ok || !afterPause.data) throw new Error("workspace missing");
  const otherHostTask = new WorkitCore(store, {
    root,
    caller: { host: otherHost, actor: session },
    capabilities: [],
    constraints: [],
    now: "2026-01-02T00:00:00Z",
  }).task(
    taskStartRequest({
      expectedWorkspaceRevision: afterPause.data.revision,
      intent: {
        objective: "same handle from other Codex surface",
        scope: { description: "the checkout", paths: ["."], exclusions: [] },
        authorityRefs: [],
      },
    }),
  );
  expect(otherHostTask.ok).toBe(true);
  const beforeTask = store.readTask(taskId);
  const beforeWorkspace = store.readWorkspace();
  const event = official(
    { hook_event_name: "SessionStart", source: "startup", session_id: session },
    root,
  );
  const first = handleCodexHook(event);
  const second = handleCodexHook(event);
  const firstContext = JSON.stringify(first);
  expect(firstContext).toContain("<workit-history-offer>");
  expect(firstContext).toContain("parked Codex history");
  expect(firstContext).toContain("same handle from other Codex surface");
  expect(firstContext).toContain("inspect history");
  expect(JSON.stringify(second)).not.toContain("<workit-history-offer>");
  expect(store.readTask(taskId)).toEqual(beforeTask);
  expect(store.readWorkspace()).toEqual(beforeWorkspace);
});

test("official payloads validate and malformed writes deny", () => {
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
  // Unknown keys are ignored (D17): a Codex release that adds a field must
  // not turn into a parse failure.
  expect(
    parseCodexHookInput(
      official({ hook_event_name: "SessionStart", source: "clear", unexpected: true }, root),
    ),
  ).toMatchObject({ ok: true });
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
    // A permission mode Codex adds later is not a parse failure (D17).
  ).toMatchObject({ ok: true });
  const outside = handleCodexHook(
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
  // No confinement: an outside absolute target passes through, and with no
  // active task the hook stays transparent.
  expectHostPermissionUnchanged(outside.hookSpecificOutput);
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
  expectHostPermissionUnchanged(absent.hookSpecificOutput);

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
  expectHostPermissionUnchanged(noActive.hookSpecificOutput);
});

test("ambiguous controlled state stays transparent for recognized writes", () => {
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
  // File writes are host-policy: several active tasks no longer gate writes.
  expectHostPermissionUnchanged(ambiguous.hookSpecificOutput);
});

test("PreToolUse allows recognized product writes without writer ownership", () => {
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
  // No writer acquired on purpose: file writes are host-policy and pass
  // through with an active task present.
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
  expectHostPermissionUnchanged(allowed.hookSpecificOutput);
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
  // No confinement: the symlink resolves to its canonical absolute target and
  // passes through; with no active task the hook stays transparent.
  expectHostPermissionUnchanged(escaped.hookSpecificOutput);
});

test("PreToolUse blocks noncompliant literal branches and leaves other commands to Codex", () => {
  withTestBranchPolicy(() => {
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
    expect(started.ok).toBe(true);
    const branch = bash(root, "git checkout -b main");
    expect(branch.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    const reason = String(
      (branch.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason,
    );
    expect(reason).toContain("protected_ref");
    expect(reason).toContain("main");
    expect(reason).toContain("choose a non-protected branch");
    expectHostPermissionUnchanged(bash(root, "git checkout -b feature/raw").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, 'git checkout -b "main"').hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "gh pr create --fill").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "git worktree add ../other").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "git status --short").hookSpecificOutput);
  });
});

test("PreToolUse enforces branch policy without a task", () => {
  withTestBranchPolicy(() => {
    const root = cwd();
    expect(bash(root, "git checkout -b main").hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
    });
    expectHostPermissionUnchanged(bash(root, "git checkout -b feature/raw").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "gh pr create --fill").hookSpecificOutput);
  });
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
  // No confinement: an outside absolute target passes through, and with no
  // active task the hook stays transparent while still exiting zero with JSON.
  expectHostPermissionUnchanged(JSON.parse(child.stdout).hookSpecificOutput);
});

test("unknown surface override warns but keeps the CLI fallback", () => {
  const prev = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
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

test("bash intent passes everything through; host policy owns shell writes", () => {
  const root = bashRoot();
  const outside = path.join(tmpdir(), `wk-codex-outside-${process.pid}.txt`);
  try {
    // No gating by intent, paths, or escapes — host policy owns shell writes.
    expectHostPermissionUnchanged(bash(root, 'echo "rm -rf /"').hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "echo hi").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, "pip install requests").hookSpecificOutput);
    expectHostPermissionUnchanged(bash(root, `tee ${outside}`).hookSpecificOutput);
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(root, "link"));
    expectHostPermissionUnchanged(bash(root, "tee link").hookSpecificOutput);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("any Codex session passes PreToolUse writes through", () => {
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
  // Owner session {workit_cli, session-1} and any other session both pass:
  // file writes are host-policy, never hook-gated.
  expectHostPermissionUnchanged(
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
  );
  expectHostPermissionUnchanged(
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
  );
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
      new TaskStore(live).root,
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
      new TaskStore(workspace).root,
    );
    // The plugin root itself never resolves (would operate on shipped files).
    expect(
      resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: pluginRoot }),
    ).toBeNull();
    // Relative and missing candidates refuse.
    expect(resolveCodexWorkspaceRoot(pluginRoot, { WORKFLOW_WORKSPACE_ROOT: "rel" })).toBeNull();
    expect(resolveCodexWorkspaceRoot(pluginRoot, {})).toBeNull();
    // PWD inherits only when it points outside the plugin root.
    expect(resolveCodexWorkspaceRoot(pluginRoot, { PWD: workspace })).toBe(
      new TaskStore(workspace).root,
    );
    expect(resolveCodexWorkspaceRoot(pluginRoot, { PWD: pluginRoot })).toBeNull();
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("outside absolute paths pass through without an active task", () => {
  const root = cwd();
  try {
    const first = handleCodexHook(
      official(
        {
          hook_event_name: "PreToolUse",
          turn_id: "turn-1",
          tool_use_id: "tool-1",
          tool_name: "Write",
          tool_input: { file_path: path.join(tmpdir(), "workit-elsewhere-notes.md") },
        },
        root,
      ),
    );
    expectHostPermissionUnchanged(first.hookSpecificOutput);
    const second = handleCodexHook(
      official(
        {
          hook_event_name: "PreToolUse",
          turn_id: "turn-1",
          tool_use_id: "tool-2",
          tool_name: "Write",
          tool_input: { file_path: "/tmp/workit-definitely-unlisted.md" },
        },
        root,
      ),
    );
    expectHostPermissionUnchanged(second.hookSpecificOutput);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
