import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore, success } from "../../packages/workit-core/src/core";
import { runDoctor } from "../../packages/workit-core/src/core/doctor";
import { scope, taskStartRequest } from "../workit-core/task-fixtures";
import plugin from "../../packages/workit-opencode/src/plugin";
import { NativeReceiptStore } from "../../packages/workit-opencode/src/tools/workit";

const input = (directory: string, client?: unknown) => ({
  directory,
  worktree: directory,
  serverUrl: new URL("http://localhost"),
  ...(client ? { client } : {}),
});

const start = (root: string, actor: string, paths = ["."]) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
  });
  const taskResult = core.task(
    taskStartRequest({
      intent: { objective: "repair test", scope: scope({ paths }), authorityRefs: [] },
    }),
  );
  if (!taskResult.ok) throw new Error(taskResult.error);
  const task = store.readTask((taskResult.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
  return { store, core, task: task.data, workspace: workspace.data };
};

test("session.created binds exactly one assigned worker before its first turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-lineage-"));
  try {
    const active = start(root, "coordinator");
    const assigned = active.core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      assignment: {
        role: "reviewer",
        objective: "review",
        scope: scope({ paths: ["review"] }),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
    });
    expect(assigned.ok).toBe(true);
    const hooks = await plugin(input(root) as never);
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "child", directory: root, parentID: "coordinator" } },
      },
    } as never);
    const updated = active.store.readTask(active.task.id);
    expect(updated.ok && updated.data.workers[0].data.state).toBe("running");
    expect(updated.ok && updated.data.workers[0].data.session).toEqual({
      kind: "host",
      host: "opencode",
      handle: "child",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle events reconcile a persisted worker after plugin restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-lifecycle-"));
  try {
    const active = start(root, "coordinator");
    const assigned = active.core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      assignment: {
        role: "reviewer",
        objective: "review",
        scope: scope({ paths: ["review"] }),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
    });
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) throw new Error(assigned.error);
    const task = active.store.readTask(active.task.id);
    const workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
    const observed = new WorkitCore(active.store, {
      root,
      caller: { host: "opencode", actor: "coordinator" },
      capabilities: [],
      constraints: [],
      now: () => "2026-01-01T00:00:00Z",
      nativeWorker: {
        verifyWorker: ({ expected }) =>
          success(null, null, {
            kind: "host_observed",
            host: "opencode",
            session: expected.session,
            workerId: expected.workerId,
            receipts: [{ kind: "host", host: "opencode", handle: "lifecycle" }],
          }),
      },
    }).observeWorkerLifecycle({
      taskId: active.task.id,
      workerId: assigned.data.id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      state: "running",
      session: { kind: "host", host: "opencode", handle: "child" },
      observation: { event: "created" },
    });
    if (!observed.ok) throw new Error(observed.error);
    const hooks = await plugin(
      input(root, { session: { get: async () => ({ data: {} }) } }) as never,
    );
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "child", status: { type: "idle" } },
      },
    } as never);
    const updated = active.store.readTask(active.task.id);
    expect(updated.ok && updated.data.workers[0].data.state).toBe("stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("known bash mutations bind actual targets and reject absolute targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-bash-"));
  try {
    const active = start(root, "owner", ["src"]);
    const acquired = active.core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId: active.task.id,
      expectedRevision: active.task.revision,
      expectedWorkspaceRevision: active.workspace.revision,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
    const hooks = await plugin(
      input(root, { session: { get: async () => ({ data: {} }) } }) as never,
    );
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "owner", callID: "inside" },
        { args: { command: "echo changed > src/file.ts" } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "owner", callID: "outside" },
        { args: { command: "echo changed > /tmp/file.ts" } },
      ),
    ).rejects.toThrow("invalid_input");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active tasks fail closed when no writer owns the checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-writer-"));
  try {
    const active = start(root, "owner");
    const hooks = await plugin(
      input(root, { session: { get: async () => ({ data: {} }) } }) as never,
    );
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "write" },
        { args: { path: "src/file.ts" } },
      ),
    ).rejects.toThrow("permission_denied");
    expect(active.store.readWorkspace().ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated approval-sounding questions do not create receipts", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "arbitrary",
      args: { questions: [{ question: "Should I approve access?", options: ["yes"] }] },
    },
    { metadata: { answers: [["yes"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("native receipts only accept a selected Workit option label", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Decision",
            question: "Approve this change?",
            options: ["approved", "rejected"],
          },
        ],
      },
    },
    { metadata: { answers: [["yes"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(false);
});

test("native receipts bind OpenCode option objects by their exact labels", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Decision",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Allow it" },
              { label: "rejected", description: "Decline it" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(true);
});

test("each distinct compaction output receives context once", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-compact-"));
  try {
    start(root, "lead");
    const hooks = await plugin(input(root) as never);
    const first = { context: [] as string[] };
    const second = { context: [] as string[] };
    await hooks["experimental.session.compacting"]?.(
      { sessionID: "lead" } as never,
      first as never,
    );
    await hooks["experimental.session.compacting"]?.(
      { sessionID: "lead" } as never,
      second as never,
    );
    expect(first.context).toHaveLength(1);
    expect(second.context).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction context selects only the task bound to the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-context-"));
  try {
    start(root, "first");
    const secondRoot = mkdtempSync(join(tmpdir(), "workit-task11-context-second-"));
    try {
      start(secondRoot, "second");
      const hooks = await plugin(input(root) as never);
      const output = { context: [] as string[] };
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "second" } as never,
        output as never,
      );
      expect(output.context).toHaveLength(0);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap retries after a transient session lookup failure", async () => {
  let calls = 0;
  const hooks = await plugin(
    input("/repo", {
      session: {
        get: async () => {
          calls += 1;
          if (calls === 1) throw new Error("temporary");
          return { data: {} };
        },
      },
    }) as never,
  );
  const user = (sessionID: string) => ({
    info: { role: "user" as const, id: sessionID, sessionID, time: { created: 0, updated: 0 } },
    parts: [
      { type: "text" as const, text: "hello", id: sessionID, messageID: sessionID, sessionID },
    ],
  });
  const first = { messages: [user("lead")] };
  const second = { messages: [user("lead")] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, first as never);
  await hooks["experimental.chat.messages.transform"]?.({} as never, second as never);
  expect(
    second.messages[0].parts.some((part: any) => part.text?.includes("<workit-contract>")),
  ).toBe(true);
});

test("native family tools expose action-constrained schemas", async () => {
  const hooks = await plugin(input("/repo") as never);
  const taskTool = hooks.tool?.workit_task;
  expect(taskTool).toBeDefined();
  expect((taskTool as any).args.action.safeParse("not-an-action").success).toBe(false);
});

test("doctor checks the OpenCode SDK pin in devDependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-doctor-"));
  try {
    for (const name of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"])
      mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", "workit-core", "package.json"),
      JSON.stringify({ name: "core" }),
    );
    for (const name of ["workit-cursor", "workit-cli"])
      writeFileSync(
        join(root, "packages", name, "package.json"),
        JSON.stringify({ dependencies: { "@brainervirus/workit-core": "workspace:*" } }),
      );
    writeFileSync(
      join(root, "packages", "workit-opencode", "package.json"),
      JSON.stringify({
        dependencies: { "@brainervirus/workit-core": "workspace:*" },
        devDependencies: { "@opencode-ai/plugin": "1.0.0" },
      }),
    );
    const report = runDoctor({
      host: "opencode",
      dev: root,
      home: root,
      configDir: join(root, "config"),
    });
    const versions = report.checks.find((check) => check.id === "versions");
    expect(versions?.status).toBe("fail");
    expect(versions?.detail).toContain("@opencode-ai/plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
