import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import extension from "@/packages/workit-pi/extensions/workit";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";

const makePi = () => {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    sendUserMessage: () => {},
    on: () => {},
    tools,
  };
};

const context = (root: string) =>
  ({
    cwd: root,
    hasUI: false,
    mode: "json",
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getCwd: () => root,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: { confirm: async () => true, select: async () => "approved" },
  }) as any;

test("workit_worker_control resolves a worker id prefix like the core and rejects an unknown one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-worker-prefix-"));
  const pi = makePi();
  await extension(pi as any);
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("setup failed");
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    assignment: {
      role: "reviewer",
      objective: "offline review",
      scope: { description: "src", paths: ["src"], exclusions: [] },
      decisionIds: [],
      requirementIds: [],
      candidateId: null,
      stoppingCondition: "report",
    },
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const workerId = (assigned.data as { id: string }).id;
  const control = pi.tools.find((tool) => tool.name === "workit_worker_control");
  const run = (id: string) =>
    control.execute(
      "control",
      { action: "reconcile", taskId, workerId: id },
      undefined,
      undefined,
      context(root),
    );

  expect((await run(workerId.slice(0, 8))).details).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
  expect((await run("00000000")).details).toMatchObject({ ok: false, code: "not_found" });
  rmSync(root, { recursive: true, force: true });
});
