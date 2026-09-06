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

test("unrelated session events do not reconcile a worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-event-filter-"));
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
    await hooks.event?.({
      event: {
        type: "todo.updated",
        properties: { sessionID: "child", todos: [] },
      },
    } as never);
    const updated = active.store.readTask(active.task.id);
    expect(updated.ok && updated.data.workers[0].data.state).toBe("running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial session observations cannot launch native tasks", async () => {
  const hooks = await plugin(
    input("/repo", { session: { get: async () => ({ data: {} }) } }) as never,
  );
  await expect(
    hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "child", callID: "call" },
      { args: {} },
    ),
  ).rejects.toThrow("delegation_lineage_denied");
});

test("empty present parentage cannot launch native tasks", async () => {
  const hooks = await plugin(
    input("/repo", {
      session: { get: async () => ({ data: { id: "root", directory: "/repo", parentID: "" } }) },
    }) as never,
  );
  await expect(
    hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "root", callID: "call" },
      { args: {} },
    ),
  ).rejects.toThrow("delegation_lineage_denied");
});

test("partial session observations cannot operate Workit control tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-tool-session-"));
  try {
    const active = start(root, "owner");
    const hooks = await plugin(
      input(root, {
        session: { get: async () => ({ data: { id: "owner", directory: root } }) },
      }) as never,
    );
    const raw = await hooks.tool?.workit_task.execute({ schemaVersion: 1, action: "list" }, {
      directory: root,
      sessionID: "child",
    } as never);
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "permission_denied" });
    expect(active.store.readTask(active.task.id).ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed child sessions without a persisted worker cannot use Workit tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-unbound-child-"));
  try {
    start(root, "owner");
    const hooks = await plugin(
      input(root, {
        session: {
          get: async () => ({ data: { id: "child", directory: root, parentID: "owner" } }),
        },
      }) as never,
    );
    const raw = await hooks.tool?.workit_task.execute({ schemaVersion: 1, action: "list" }, {
      directory: root,
      sessionID: "child",
    } as never);
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "permission_denied" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty present parentage cannot operate Workit tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-empty-parent-tool-"));
  try {
    start(root, "owner");
    const hooks = await plugin(
      input(root, {
        session: {
          get: async () => ({ data: { id: "owner", directory: root, parentID: "" } }),
        },
      }) as never,
    );
    const raw = await hooks.tool?.workit_task.execute({ schemaVersion: 1, action: "list" }, {
      directory: root,
      sessionID: "owner",
    } as never);
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "permission_denied" });
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
      input(root, {
        session: {
          get: async () => ({ data: { id: "child", directory: root, parentID: "coordinator" } }),
        },
      }) as never,
    );
    await hooks.event?.({
      event: {
        type: "session.error",
        properties: { sessionID: "child", error: { name: "UnknownError", message: "boom" } },
      },
    } as never);
    const uncertain = active.store.readTask(active.task.id);
    expect(uncertain.ok && uncertain.data.workers[0].data.state).toBe("unknown");
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

test("session.deleted trusts its full session payload when lookup disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-deleted-session-"));
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
    const info = {
      id: "child",
      projectID: "project",
      directory: root,
      parentID: "coordinator",
      title: "child",
      version: "1.18.29",
      time: { created: 0, updated: 0 },
    };
    let deleted = false;
    const hooks = await plugin(
      input(root, {
        session: {
          get: async () => ({ data: deleted ? undefined : info }),
        },
      }) as never,
    );
    for (const malformed of [
      { id: "child" },
      { ...info, directory: join(root, "other") },
      { ...info, parentID: "other-coordinator" },
    ]) {
      await hooks.event?.({
        event: { type: "session.deleted", properties: { info: malformed } },
      } as never);
      const unchanged = active.store.readTask(active.task.id);
      expect(unchanged.ok && unchanged.data.workers[0].data.state).toBe("running");
    }
    deleted = true;
    await hooks.event?.({
      event: { type: "session.deleted", properties: { info } },
    } as never);
    const stopped = active.store.readTask(active.task.id);
    expect(stopped.ok && stopped.data.workers[0].data.state).toBe("stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart lifecycle events reject a child whose parent changed", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-parent-drift-"));
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
      input(root, {
        session: {
          get: async () => ({ data: { id: "child", directory: root, parentID: "other" } }),
        },
      }) as never,
    );
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "child", status: { type: "idle" } },
      },
    } as never);
    const updated = active.store.readTask(active.task.id);
    expect(updated.ok && updated.data.workers[0].data.state).toBe("running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart lifecycle events reject ambiguous persisted child handles", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-ambiguous-child-"));
  try {
    const active = start(root, "coordinator");
    const assignment = (task: any, workspace: any) =>
      active.core.worker({
        schemaVersion: 1,
        action: "assign",
        taskId: active.task.id,
        expectedRevision: task.revision,
        expectedWorkspaceRevision: workspace.revision,
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
    const first = assignment(active.task, active.workspace);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    let task = active.store.readTask(active.task.id);
    let workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
    const second = assignment(task.data, workspace.data);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    const observe = (workerId: string) => {
      task = active.store.readTask(active.task.id);
      workspace = active.store.readWorkspace();
      if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
      return new WorkitCore(active.store, {
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
        workerId,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        state: "running",
        session: { kind: "host", host: "opencode", handle: "child" },
        observation: { event: "created" },
      });
    };
    const firstRunning = observe(first.data.id);
    expect(firstRunning.ok).toBe(true);
    const secondRunning = observe(second.data.id);
    expect(secondRunning.ok).toBe(true);
    const hooks = await plugin(
      input(root, {
        session: {
          get: async () => ({ data: { id: "child", directory: root, parentID: "coordinator" } }),
        },
      }) as never,
    );
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "child", status: { type: "idle" } },
      },
    } as never);
    const updated = active.store.readTask(active.task.id);
    expect(
      updated.ok && updated.data.workers.every((worker) => worker.data.state === "running"),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workit mutations reject ambiguous persisted worker handles", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-ambiguous-worker-tool-"));
  try {
    const active = start(root, "coordinator");
    const assign = () => {
      const task = active.store.readTask(active.task.id);
      const workspace = active.store.readWorkspace();
      if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
      return active.core.worker({
        schemaVersion: 1,
        action: "assign",
        taskId: active.task.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
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
    };
    const observe = (workerId: string) => {
      const task = active.store.readTask(active.task.id);
      const workspace = active.store.readWorkspace();
      if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
      return new WorkitCore(active.store, {
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
        workerId,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        state: "running",
        session: { kind: "host", host: "opencode", handle: "child" },
        observation: { event: "created" },
      });
    };
    const first = assign();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(observe(first.data.id).ok).toBe(true);
    const second = assign();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(observe(second.data.id).ok).toBe(true);
    const hooks = await plugin(
      input(root, {
        session: {
          get: async ({ path: { id } }: { path: { id: string } }) => ({
            data: { id, directory: root, parentID: "coordinator" },
          }),
        },
      }) as never,
    );
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coordinator", callID: "launch", args: {} },
      { title: "task", output: "started", metadata: { sessionID: "child" } },
    );
    const task = active.store.readTask(active.task.id);
    const workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
    const raw = await hooks.tool?.workit_worker.execute(
      {
        schemaVersion: 1,
        action: "report",
        taskId: active.task.id,
        expectedRevision: task.data.revision,
        expectedWorkspaceRevision: workspace.data.revision,
        workerId: first.data.id,
        report: { outcome: "completed", summary: "done", evidenceIds: [], findingIds: [] },
      },
      { directory: root, sessionID: "child" } as never,
    );
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "permission_denied" });
    const unchanged = active.store.readTask(active.task.id);
    expect(
      unchanged.ok && unchanged.data.workers.every((worker) => worker.data.report === null),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workit mutations accept one validated persisted worker handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-single-worker-tool-"));
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
    expect(observed.ok).toBe(true);
    const hooks = await plugin(
      input(root, {
        session: {
          get: async ({ path: { id } }: { path: { id: string } }) => ({
            data: { id, directory: root, parentID: "coordinator" },
          }),
        },
      }) as never,
    );
    await hooks["tool.execute.after"]?.(
      { tool: "task", sessionID: "coordinator", callID: "launch", args: {} },
      { title: "task", output: "started", metadata: { sessionID: "child" } },
    );
    const currentTask = active.store.readTask(active.task.id);
    const currentWorkspace = active.store.readWorkspace();
    if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("fixture missing");
    const raw = await hooks.tool?.workit_worker.execute(
      {
        schemaVersion: 1,
        action: "report",
        taskId: active.task.id,
        expectedRevision: currentTask.data.revision,
        expectedWorkspaceRevision: currentWorkspace.data.revision,
        workerId: assigned.data.id,
        report: { outcome: "completed", summary: "done", evidenceIds: [], findingIds: [] },
      },
      { directory: root, sessionID: "child" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
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
      input(root, {
        session: { get: async () => ({ data: { id: "owner", directory: root } }) },
      }) as never,
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
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "bash", sessionID: "owner", callID: "later" },
        { args: { command: "echo changed > src/file.ts && rm -rf /tmp/out" } },
      ),
    ).rejects.toThrow("invalid_input");
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "out-of-scope" },
        { args: { filePath: join(root, "docs/outside.ts") } },
      ),
    ).rejects.toThrow("permission_denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active writes require a trusted session directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-session-root-"));
  try {
    const active = start(root, "owner");
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
        { tool: "write", sessionID: "owner", callID: "write" },
        { args: { path: "src/file.ts" } },
      ),
    ).rejects.toThrow("permission_denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active writes reject a trusted session with mismatched parentage", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-parent-write-"));
  try {
    const active = start(root, "owner");
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
      input(root, {
        session: {
          get: async () => ({ data: { id: "owner", directory: root, parentID: "other" } }),
        },
      }) as never,
    );
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "write" },
        { args: { path: "src/file.ts" } },
      ),
    ).rejects.toThrow("permission_denied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active writes reject empty present parentage", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-empty-parent-write-"));
  try {
    const active = start(root, "owner");
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
      input(root, {
        session: {
          get: async () => ({ data: { id: "owner", directory: root, parentID: "" } }),
        },
      }) as never,
    );
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "write", sessionID: "owner", callID: "write" },
        { args: { path: "src/file.ts" } },
      ),
    ).rejects.toThrow("permission_denied");
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
            header: "Workit decision: design",
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
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Allow it" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(receipts.consume("s", "decision").ok).toBe(true);
});

test("native receipts reject multi-answer question output", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "multi-answer",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Design" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved", "rejected"]] } },
  );
  expect(receipts.consume("multi-answer", "decision").ok).toBe(false);
});

test("decision receipts cannot cross core decision purposes", () => {
  const receipts = new NativeReceiptStore();
  receipts.record(
    {
      sessionID: "s",
      callID: "decision",
      args: {
        questions: [
          {
            header: "Workit decision: design",
            question: "Approve this change?",
            options: [
              { label: "approved", description: "Design v1" },
              { label: "rejected", description: "Reject this decision" },
            ],
          },
        ],
      },
    },
    { metadata: { answers: [["approved"]] } },
  );
  expect(
    receipts.consume("s", "decision", {
      decisionPurpose: "action",
      selectedLabel: "approved",
      selectedDescription: "Design v1",
      question: "Approve this change?",
    }).ok,
  ).toBe(false);
});

test("decision receipts bind approved content to the exact native question", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-decision-content-"));
  try {
    const active = start(root, "lead");
    const hooks = await plugin(
      input(root, {
        session: { get: async () => ({ data: { id: "lead", directory: root } }) },
      }) as never,
    );
    await hooks["tool.execute.after"]?.(
      {
        tool: "question",
        sessionID: "lead",
        callID: "real-question-call",
        args: {
          questions: [
            {
              header: "Workit decision: design",
              question: "Approve the design?",
              options: [
                { label: "approved", description: "Design v1" },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { title: "Workit decision", output: "approved", metadata: { answers: [["approved"]] } },
    );
    const task = active.store.readTask(active.task.id);
    const workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
    const raw = await hooks.tool?.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: active.task.id,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId: active.task.id,
          workspaceId: workspace.data.id,
          scope: scope(),
          presented: "Approve the design?",
          approvedContent: "Different design",
          contentRefs: [],
        },
        response: "approved",
        requirementIds: [],
      },
      { directory: root, sessionID: "lead" } as never,
    );
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: "permission_denied" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejected native Workit decisions remain exact and host-observed", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-task11-decision-rejected-"));
  try {
    const active = start(root, "lead");
    const hooks = await plugin(
      input(root, {
        session: { get: async () => ({ data: { id: "lead", directory: root } }) },
      }) as never,
    );
    await hooks["tool.execute.after"]?.(
      {
        tool: "question",
        sessionID: "lead",
        callID: "rejected-question-call",
        args: {
          questions: [
            {
              header: "Workit decision: design",
              question: "Approve the design?",
              options: [
                { label: "approved", description: "Design v1" },
                { label: "rejected", description: "Reject this decision" },
              ],
            },
          ],
        },
      },
      { title: "Workit decision", output: "rejected", metadata: { answers: [["rejected"]] } },
    );
    const task = active.store.readTask(active.task.id);
    const workspace = active.store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
    const raw = await hooks.tool?.workit_decision.execute(
      {
        schemaVersion: 1,
        action: "record",
        taskId: active.task.id,
        expectedRevision: task.data.revision,
        purpose: "design",
        binding: {
          taskId: active.task.id,
          workspaceId: workspace.data.id,
          scope: scope(),
          presented: "Approve the design?",
          approvedContent: "Design v1",
          contentRefs: [],
        },
        response: "rejected",
        requirementIds: [],
      },
      { directory: root, sessionID: "lead" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
          return { data: { id: "lead", directory: "/repo" } };
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

test("partial session observations do not mark bootstrap complete", async () => {
  const hooks = await plugin(
    input("/repo", { session: { get: async () => ({ data: {} }) } }) as never,
  );
  const output = {
    messages: [
      {
        info: {
          role: "user" as const,
          id: "lead",
          sessionID: "lead",
          time: { created: 0, updated: 0 },
        },
        parts: [
          {
            type: "text" as const,
            text: "hello",
            id: "part",
            messageID: "lead",
            sessionID: "lead",
          },
        ],
      },
    ],
  };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  expect(
    output.messages[0].parts.some((part: any) => part.text?.includes("<workit-contract>")),
  ).toBe(false);
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
