import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { createV2Lifecycle, type V2SessionInfo } from "@/packages/workit-opencode/src/v2/lifecycle";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-v2-lifecycle-"));
  for (const args of [
    ["init", "-q", "-b", "feature/v2-lifecycle"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Workit Test"],
  ])
    git(root, args);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const store = new TaskStore(root);
  // A monotonic clock keeps worker ordering deterministic: the launch queue
  // consumes the oldest assigned worker first, and equal timestamps would
  // make that order depend on random ids.
  let tick = 0;
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor: "coordinator" },
    capabilities: [],
    constraints: [],
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  const started = core.task(
    taskStartRequest({
      intent: { objective: "v2 lifecycle", scope: scope({ paths: ["."] }), authorityRefs: [] },
    }),
  );
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture missing");
  const assignWorker = (role: "reviewer" | "investigator") => {
    const current = store.readTask(task.data.id);
    const currentWorkspace = store.readWorkspace();
    if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("state missing");
    const assigned = core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId: current.data.id,
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
      assignment: {
        role,
        objective: "review",
        scope: scope({ paths: ["review"] }),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
    });
    if (!assigned.ok) throw new Error(assigned.error);
  };
  assignWorker("reviewer");
  const sessions = new Map<string, V2SessionInfo>([
    ["coordinator", { id: "coordinator", directory: root }],
  ]);
  const lifecycle = createV2Lifecycle({
    root,
    getSession: async (sessionID) => sessions.get(sessionID) ?? null,
  });
  const worker = (index = 0) => {
    const current = store.readTask(task.data.id);
    if (!current.ok) throw new Error(current.error);
    return current.data.workers[index]!;
  };
  const revisions = () => {
    const current = store.readTask(task.data.id);
    const currentWorkspace = store.readWorkspace();
    if (!current.ok || !currentWorkspace.ok || !currentWorkspace.data)
      throw new Error("state missing");
    return {
      expectedRevision: current.data.revision,
      expectedWorkspaceRevision: currentWorkspace.data.revision,
    };
  };
  return {
    root,
    store,
    core,
    taskId: task.data.id,
    sessions,
    lifecycle,
    worker,
    assignWorker,
    revisions,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("session.created binds exactly one assigned worker before its first turn", async () => {
  const value = fixture();
  try {
    await value.lifecycle.handleEvent({
      type: "session.created",
      data: {
        sessionID: "ses_child1",
        parentID: "coordinator",
        location: { directory: value.root },
      },
    });
    const worker = value.worker();
    expect(worker.data.state).toBe("running");
    expect(worker.data.session).toEqual({
      kind: "host",
      host: "opencode",
      handle: "ses_child1",
    });
  } finally {
    value.cleanup();
  }
});

test("a fresh managed launch prepares the durable dispatching claim, then binds the observed child", async () => {
  const value = fixture();
  try {
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: { description: "child", prompt: "work", agent: "general" },
    });
    expect(value.worker().data.state).toBe("dispatching");

    value.sessions.set("ses_child1", {
      id: "ses_child1",
      parentID: "coordinator",
      directory: value.root,
    });
    await value.lifecycle.executeAfter({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
      status: "completed",
      result: {
        metadata: { sessionID: "ses_child1" },
        content: [
          {
            type: "text",
            text: '<subagent sessionID="ses_child1" state="completed">ok</subagent>',
          },
        ],
      },
    });
    const worker = value.worker();
    expect(worker.data.session).toEqual({
      kind: "host",
      host: "opencode",
      handle: "ses_child1",
    });
    expect(worker.data.state).toBe("stopped");
    expect(value.lifecycle.pendingLaunch("coordinator")).toBe(false);
  } finally {
    value.cleanup();
  }
});

test("concurrent fresh launches share one synchronous slot", async () => {
  const value = fixture();
  try {
    const first = value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
    });
    const second = value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_2",
      input: {},
    });
    await first;
    await expect(second).rejects.toThrow(/unsettled/);
    expect(value.worker().data.state).toBe("dispatching");
  } finally {
    value.cleanup();
  }
});

test("session.created settles a missed launch and frees the slot", async () => {
  const value = fixture();
  try {
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
    });
    // session.created arrives without the matching execute.after.
    await value.lifecycle.handleEvent({
      type: "session.created",
      data: {
        sessionID: "ses_child1",
        parentID: "coordinator",
        location: { directory: value.root },
      },
    });
    expect(value.worker().data.state).toBe("running");
    expect(value.lifecycle.pendingLaunch("coordinator")).toBe(false);
  } finally {
    value.cleanup();
  }
});

test("a fresh managed launch with no assigned worker is denied before spawn", async () => {
  const value = fixture();
  try {
    const first = value.worker();
    const cancelled = value.core.worker({
      schemaVersion: 1,
      action: "cancel",
      taskId: value.taskId,
      ...value.revisions(),
      workerId: first.id,
      reason: "consume the only worker",
    });
    expect(cancelled.ok).toBe(true);
    await expect(
      value.lifecycle.executeBefore({
        tool: "subagent",
        sessionID: "coordinator",
        id: "call_1",
        input: {},
      }),
    ).rejects.toThrow(/no assigned Workit worker/);
  } finally {
    value.cleanup();
  }
});

test("an ambiguous cancelled result vetoes the next launch until it is reconciled", async () => {
  const value = fixture();
  try {
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
    });
    await value.lifecycle.executeAfter({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
      status: "error",
      error: { message: "call cancelled" },
    });
    await expect(
      value.lifecycle.executeBefore({
        tool: "subagent",
        sessionID: "coordinator",
        id: "call_2",
        input: {},
      }),
    ).rejects.toThrow(/cancelled worker remains uncertain/);
  } finally {
    value.cleanup();
  }
});

test("continuation passes for a direct child and consumes no worker", async () => {
  const value = fixture();
  try {
    value.sessions.set("ses_child1", {
      id: "ses_child1",
      parentID: "coordinator",
      directory: value.root,
    });
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: { sessionID: "ses_child1", prompt: "continue" },
    });
    expect(value.worker().data.state).toBe("assigned");
    expect(value.lifecycle.pendingLaunch("coordinator")).toBe(false);

    await expect(
      value.lifecycle.executeBefore({
        tool: "subagent",
        sessionID: "coordinator",
        id: "call_2",
        input: { sessionID: "ses_unknown" },
      }),
    ).rejects.toThrow(/continuation sessionID/);
  } finally {
    value.cleanup();
  }
});

test("nested launches are denied and unmanaged native use stays untouched", async () => {
  const value = fixture();
  try {
    value.sessions.set("ses_child1", {
      id: "ses_child1",
      parentID: "coordinator",
      directory: value.root,
    });
    await expect(
      value.lifecycle.executeBefore({
        tool: "subagent",
        sessionID: "ses_child1",
        id: "call_1",
        input: {},
      }),
    ).rejects.toThrow(/direct children of the coordinator/);

    value.sessions.set("ses_other", { id: "ses_other", directory: value.root });
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "ses_other",
      id: "call_2",
      input: {},
    });
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "ses_other",
      id: "call_3",
      input: {},
    });
    expect(value.lifecycle.pendingLaunch("ses_other")).toBe(false);
  } finally {
    value.cleanup();
  }
});

test("execution.succeeded and sparse deletion stop bound children", async () => {
  const value = fixture();
  try {
    await value.lifecycle.handleEvent({
      type: "session.created",
      data: {
        sessionID: "ses_child1",
        parentID: "coordinator",
        location: { directory: value.root },
      },
    });
    expect(value.worker().data.state).toBe("running");
    value.sessions.delete("ses_child1");
    await value.lifecycle.handleEvent({
      type: "session.deleted",
      data: { sessionID: "ses_child1" },
      location: { directory: value.root },
    });
    expect(value.worker().data.state).toBe("stopped");
    expect(value.worker().data.session).toEqual({
      kind: "host",
      host: "opencode",
      handle: "ses_child1",
    });
  } finally {
    value.cleanup();
  }
});

test("execution.started and terminal execution events map to running and stopped", async () => {
  const value = fixture();
  try {
    await value.lifecycle.handleEvent({
      type: "session.created",
      data: {
        sessionID: "ses_child1",
        parentID: "coordinator",
        location: { directory: value.root },
      },
    });
    await value.lifecycle.handleEvent({
      type: "session.execution.started",
      data: { sessionID: "ses_child1" },
    });
    expect(value.worker().data.state).toBe("running");
    value.sessions.set("ses_child1", {
      id: "ses_child1",
      parentID: "coordinator",
      directory: value.root,
    });
    await value.lifecycle.handleEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_child1" },
    });
    expect(value.worker().data.state).toBe("stopped");
  } finally {
    value.cleanup();
  }
});

test("a second worker binds only after the first launch settles", async () => {
  const value = fixture();
  try {
    value.assignWorker("investigator");
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
    });
    await expect(
      value.lifecycle.executeBefore({
        tool: "subagent",
        sessionID: "coordinator",
        id: "call_2",
        input: {},
      }),
    ).rejects.toThrow(/unsettled/);
    value.sessions.set("ses_child1", {
      id: "ses_child1",
      parentID: "coordinator",
      directory: value.root,
    });
    await value.lifecycle.executeAfter({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_1",
      input: {},
      status: "completed",
      result: { metadata: { sessionID: "ses_child1" } },
    });
    // The first worker stopped; the second assigned worker can now launch.
    await value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "coordinator",
      id: "call_2",
      input: {},
    });
    expect(value.worker(1).data.state).toBe("dispatching");
  } finally {
    value.cleanup();
  }
});
