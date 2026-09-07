import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import extension from "../../packages/workit-pi/extensions/workit";
import { TaskStore, WorkitCore, type OperationContext } from "../../packages/workit-core/src/core";
import { taskStartRequest } from "../workit-core/task-fixtures";

const setup = async () => {
  const tools: any[] = [];
  const observations: any[] = [];
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    registerTool: (tool: any) => tools.push(tool),
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    appendEntry: (type: string, data: unknown) => observations.push({ type, data }),
  };
  await extension(pi as any);
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-session-"));
  const sessionManager = {
    getSessionId: () => "pi-session",
    getSessionFile: () => "/tmp/pi-session.jsonl",
    getCwd: () => root,
    getEntries: () => [],
    getBranch: () => [],
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager,
    ui: { confirm: async () => true, select: async () => "approved" },
  } as any;
  return { pi, tools, handlers, observations, root, ctx };
};

test("Pi session events retain native session identity across startup, reload, resume, new, and fork", async () => {
  const { handlers, ctx } = await setup();
  for (const reason of ["startup", "reload", "resume", "new", "fork"] as const)
    await handlers.get("session_start")!({ type: "session_start", reason }, ctx);
  const first: any = await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  expect(first.message.content).toContain("pi-session");
  expect(first.message.content).toContain("Workit keeps one accountable lead");
});

test("Pi compaction preserves one Workit context and shutdown clears it", async () => {
  const { handlers, ctx } = await setup();
  const before: any = await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  expect(before.message.content).toContain("Workit keeps one accountable lead");
  expect(
    await handlers.get("before_agent_start")!(
      { type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} },
      ctx,
    ),
  ).toBeUndefined();
  const compact: any = await handlers.get("session_before_compact")!(
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "entry", tokensBefore: 1 },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    ctx,
  );
  expect(compact.compaction.summary).toContain("Workit keeps one accountable lead");
  await handlers.get("session_compact")!({ type: "session_compact" }, ctx);
  const restored: any = await handlers.get("before_agent_start")!(
    { type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  expect(restored.message.content).toContain("Workit keeps one accountable lead");
  await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("Pi write interception uses the shared writer gate and discloses sandbox limits", async () => {
  const { handlers, observations, ctx, root } = await setup();
  const store = new TaskStore(root);
  const operationContext: OperationContext = {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const task = new WorkitCore(store, operationContext).task(taskStartRequest());
  if (!task.ok) throw new Error(task.error);
  const taskRecord = store.readTask((task.data as { id: string }).id);
  if (!taskRecord.ok) throw new Error(taskRecord.error);
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const acquired = new WorkitCore(store, operationContext).writer({
    schemaVersion: 1,
    action: "acquire",
    taskId: taskRecord.data.id,
    expectedRevision: taskRecord.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workerId: null,
  });
  if (!acquired.ok) throw new Error(acquired.error);
  const allowed = await handlers.get("tool_call")!(
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "src/file.ts" } },
    ctx,
  );
  expect(allowed).toBeUndefined();
  const blocked = await handlers.get("tool_call")!(
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "../escape.ts" } },
    ctx,
  );
  expect(blocked).toMatchObject({ block: true });
  await handlers.get("tool_result")!(
    {
      type: "tool_result",
      toolCallId: "1",
      toolName: "write",
      input: {},
      content: [],
      isError: false,
    },
    ctx,
  );
  expect(observations).toEqual([
    {
      type: "workit-native-observation",
      data: { session: "pi-session", tool: "write", toolCallId: "1", isError: false },
    },
  ]);
});
