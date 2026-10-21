// #264: a worker left assigned on branch A's task must not block (or capture)
// a native launch for the worker assigned on branch B's task.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { createV2Lifecycle, type V2SessionInfo } from "@/packages/workit-opencode/src/v2/lifecycle";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workit-v2-branches-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root });
  run(["init", "-q", "-b", "feature/a"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Workit Test"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  run(["add", "base.txt"]);
  run(["commit", "-qm", "base"]);
  const store = new TaskStore(root);
  let tick = 0;
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor: "lead" },
    capabilities: [],
    constraints: [],
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  /** Start this branch's task and assign one worker on it; returns the task id. */
  const taskWithWorker = (assign = true): string => {
    const request: Record<string, unknown> = taskStartRequest({
      intent: { objective: "branch work", scope: scope({ paths: ["."] }), authorityRefs: [] },
    });
    // The second branch's task starts on a workspace the first one created.
    delete request.expectedWorkspaceRevision;
    const started = core.task(request);
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    if (assign) {
      const assigned = core.worker({
        schemaVersion: 1,
        action: "assign",
        taskId,
        assignment: {
          role: "investigator",
          objective: "investigate",
          scope: scope({ paths: ["."] }),
          decisionIds: [],
          requirementIds: [],
          candidateId: null,
          stoppingCondition: "report",
        },
      });
      if (!assigned.ok) throw new Error(assigned.error);
    }
    return taskId;
  };
  const sessions = new Map<string, V2SessionInfo>([["lead", { id: "lead", directory: root }]]);
  const lifecycle = createV2Lifecycle({
    root,
    getSession: async (sessionID) => sessions.get(sessionID) ?? null,
  });
  const workers = (taskId: string) => {
    const task = store.readTask(taskId);
    if (!task.ok) throw new Error(task.error);
    return task.data.workers;
  };
  const progress = (taskId: string) => {
    const task = store.readTask(taskId);
    if (!task.ok) throw new Error(task.error);
    return task.data.progress.summary;
  };
  const launch = async (child: string) => {
    await lifecycle.executeBefore({ tool: "subagent", sessionID: "lead", id: child, input: {} });
    sessions.set(child, { id: child, parentID: "lead", directory: root });
    await lifecycle.executeAfter({
      tool: "subagent",
      sessionID: "lead",
      id: child,
      input: {},
      status: "completed",
      result: { metadata: { sessionID: child }, content: [] },
    });
  };
  return {
    root,
    taskWithWorker,
    workers,
    progress,
    launch,
    lifecycle,
    switchTo: (branch: string) => run(["switch", "-qc", branch]),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("Given a stale assigned worker on branch A, When the lead launches from branch B with a worker assigned there, Then B's worker runs and A's stays assigned", async () => {
  const value = fixture();
  try {
    const taskA = value.taskWithWorker();
    value.switchTo("feature/b");
    const taskB = value.taskWithWorker();
    await value.launch("ses_child_b");
    expect(value.workers(taskB)[0].data).toMatchObject({
      state: "running",
      session: { handle: "ses_child_b" },
    });
    expect(value.workers(taskA)[0].data.state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given a lone stale assigned worker on branch A and none on branch B's task, When the lead launches from B, Then A's worker is rebound to B's task, the launch runs there and the move is traced", async () => {
  const value = fixture();
  try {
    const taskA = value.taskWithWorker();
    const workerA = value.workers(taskA)[0].id;
    value.switchTo("feature/b");
    const taskB = value.taskWithWorker(false);
    await value.launch("ses_child_b");
    expect(value.workers(taskA)[0]).toMatchObject({ id: workerA, data: { state: "stopped" } });
    expect(value.workers(taskB)).toHaveLength(1);
    expect(value.workers(taskB)[0].data).toMatchObject({
      state: "running",
      session: { handle: "ses_child_b" },
      assignment: { objective: "investigate" },
    });
    expect(value.progress(taskB)).toContain(`rebound from task ${taskA}`);
  } finally {
    value.cleanup();
  }
});

test("Given stale assigned workers on two other branches' tasks and none on B's, When the lead launches from B, Then nothing is rebound and the branch-scoped hint names both cancel calls", async () => {
  const value = fixture();
  try {
    const taskA = value.taskWithWorker();
    const workerA = value.workers(taskA)[0].id;
    value.switchTo("feature/c");
    const taskC = value.taskWithWorker();
    const workerC = value.workers(taskC)[0].id;
    value.switchTo("feature/b");
    const taskB = value.taskWithWorker(false);
    const refused = value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "lead",
      id: "call_b",
      input: {},
    });
    await expect(refused).rejects.toThrow(/branch-scoped/);
    await expect(refused).rejects.toThrow(
      `workit_worker {"action":"cancel","taskId":"${taskA}","workerId":"${workerA}"`,
    );
    await expect(refused).rejects.toThrow(
      `workit_worker {"action":"cancel","taskId":"${taskC}","workerId":"${workerC}"`,
    );
    expect(value.workers(taskA)[0].data.state).toBe("assigned");
    expect(value.workers(taskC)[0].data.state).toBe("assigned");
    expect(value.workers(taskB)).toHaveLength(0);
  } finally {
    value.cleanup();
  }
});

test("Given a stale assigned worker on branch A, When the lead launches from a fresh branch B with no task (the #264 repro), Then it is refused: start B's task first, and A's worker is not captured", async () => {
  const value = fixture();
  try {
    const taskA = value.taskWithWorker();
    const workerA = value.workers(taskA)[0].id;
    value.switchTo("feature/b");
    const refused = value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "lead",
      id: "call_b",
      input: {},
    });
    await expect(refused).rejects.toThrow(/this branch has no Workit task yet; start it/);
    await expect(refused).rejects.toThrow(`"taskId":"${taskA}","workerId":"${workerA}"`);
    expect(value.workers(taskA)[0].data.state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});

test("Given workers left on two other branches' tasks, When the lead launches from a fresh branch, Then neither is captured and both cancel calls are named", async () => {
  const value = fixture();
  try {
    const taskA = value.taskWithWorker();
    value.switchTo("feature/c");
    const taskC = value.taskWithWorker();
    value.switchTo("feature/d");
    const refused = value.lifecycle.executeBefore({
      tool: "subagent",
      sessionID: "lead",
      id: "call_d",
      input: {},
    });
    await expect(refused).rejects.toThrow(`"taskId":"${taskA}"`);
    await expect(refused).rejects.toThrow(`"taskId":"${taskC}"`);
    expect(value.workers(taskA)[0].data.state).toBe("assigned");
    expect(value.workers(taskC)[0].data.state).toBe("assigned");
  } finally {
    value.cleanup();
  }
});
