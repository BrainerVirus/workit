import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { CURSOR_PRETOOLUSE_MATCHER } from "@/packages/workit-core/src/core/registration";
import { caller, taskStartRequest } from "@/test/workit-core/task-fixtures";
import {
  CURSOR_WRITE_TOOL_NAMES,
  cursorCapabilities,
  handleCursorHook,
  parseCursorHookInput,
} from "@/packages/workit-cursor/hooks/workit-hook";

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

test("shell hooks resolve cwd and pass outside-root operands through without a task", () => {
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
  ).toEqual({ permission: "allow" });
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
  ).toEqual({ permission: "allow" });
});

test("shell hooks reject unavailable cwd and attached output redirections", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  // Absolute redirect targets pass through now (no confinement); without a
  // task they allow. Bare fd duplication stays denied as unparseable.
  for (const command of [">/tmp/out", "2>/tmp/err"]) {
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
      cwd: root,
      command: "2>&1",
    }),
  ).toMatchObject({ permission: "deny" });
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
    task: "[workit-role: reviewer] inspect the bounded change",
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

test("active native subagents allow read-only roles and deny unavailable implementation", () => {
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
      subagent_id: "duplicate-marker",
      subagent_type: "generalPurpose",
      task: "[workit-role: reviewer] inspect [workit-role: investigator] twice",
    }),
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
      subagent_id: "investigator",
      subagent_type: "explore",
      task: "[workit-role: investigator] inspect the bounded change",
    }),
  ).toMatchObject({ permission: "allow" });
  expect(
    handleCursorHook({
      ...base,
      subagent_id: "implementer",
      subagent_type: "generalPurpose",
      task: "[workit-role: implementer] implement the bounded change",
    }),
  ).toMatchObject({
    permission: "deny",
    agent_message: "Cursor implementer delegation is unavailable without attested writer identity",
  });
  const task = new TaskStore(root).listTasks();
  expect(task.ok).toBe(true);
  if (!task.ok) return;
  expect(task.data[0]?.workers.map((worker) => worker.data.assignment.role)).toEqual([
    "reviewer",
    "investigator",
  ]);
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

test("committed preToolUse matcher covers every write-tool guard name", () => {
  const re = new RegExp(`^(?:${CURSOR_PRETOOLUSE_MATCHER})$`, "i");
  expect(CURSOR_WRITE_TOOL_NAMES.length).toBeGreaterThan(8);
  for (const name of CURSOR_WRITE_TOOL_NAMES) expect(name, name).toMatch(re);
});

const shellRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-shell-"));
  mkdirSync(path.join(root, "sub"), { recursive: true });
  return root;
};

const shell = (root: string, command: string) =>
  handleCursorHook({
    hook_event_name: "beforeShellExecution",
    conversation_id: "conv-1",
    workspace_roots: [root],
    cwd: root,
    command,
  });

test("shell intent captures unlisted verbs and skips env assignments", () => {
  const root = shellRoot();
  try {
    // No active task: intent+paths allows, invalid denies — so denial proves
    // the parser saw write intent plus a containment failure.
    expect(shell(root, 'echo "rm -rf /"')).toEqual({ permission: "allow" });
    expect(shell(root, "echo hi")).toEqual({ permission: "allow" });
    expect(shell(root, 'echo "hi" > out.txt')).toMatchObject({ permission: "deny" });
    expect(shell(root, "mkdir a && mkdir b")).toMatchObject({ permission: "deny" });
    expect(shell(root, `tee ${path.join(tmpdir(), `wk-outside-${process.pid}.txt`)}`)).toEqual({
      permission: "allow",
    });
    expect(shell(root, `FOO=1 rm ${path.join(tmpdir(), `wk-outside-${process.pid}.txt`)}`)).toEqual(
      { permission: "allow" },
    );
    expect(shell(root, "pip install requests")).toMatchObject({ permission: "allow" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell paths pass through canonical absolute targets without a task", () => {
  const root = shellRoot();
  const outside = path.join(tmpdir(), `wk-escape-${process.pid}.txt`);
  try {
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(root, "link"));
    // Intent on `link`: resolves to the canonical absolute target outside the
    // root and passes through (no confinement); without a task it allows.
    expect(shell(root, "tee link")).toEqual({ permission: "allow" });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("a structured write tool with no extractable target denies inside a task", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ host: "cursor", actor: "parent" }),
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.task(taskStartRequest()).ok).toBe(true);
  try {
    expect(
      handleCursorHook({
        hook_event_name: "preToolUse",
        conversation_id: "parent",
        workspace_roots: [root],
        tool_name: "Write",
        tool_input: {},
      }),
    ).toMatchObject({ permission: "deny" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside absolute paths reach the writer check instead of denying for containment", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-cursor-hook-"));
  const core = new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ host: "cursor", actor: "parent" }),
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  expect(core.task(taskStartRequest()).ok).toBe(true);
  try {
    // No writer held: denies, but for missing ownership — never containment.
    expect(
      handleCursorHook({
        hook_event_name: "preToolUse",
        conversation_id: "parent",
        workspace_roots: [root],
        tool_name: "Write",
        tool_input: { file_path: path.join(tmpdir(), "workit-elsewhere-x.ts") },
      }),
    ).toMatchObject({ permission: "deny", agent_message: "checkout has no writer owner" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
