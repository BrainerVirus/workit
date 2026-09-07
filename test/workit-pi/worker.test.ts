import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TaskStore,
  WorkitCore,
  failure,
  success,
  type OperationContext,
} from "../../packages/workit-core/src/core";
import {
  cancelWorker,
  advanceWorkerBinding,
  consumeWorkerOutput,
  launchWorker,
  launchSupervisedWorker,
  nativeWorkerForEvidence,
  observeExit,
  observeWorkerStart,
  reportWorker,
  reconcileWorker,
  sendWorkerPrompt,
  parseWorkerResult,
  workerCommand,
  type PiRuntime,
  type WorkerAssignment,
} from "../../packages/workit-pi/src/worker";
import { parseWorkerLines } from "../../packages/workit-pi/src/worker-protocol";
import { taskStartRequest } from "../workit-core/task-fixtures";

const runtime = (root = mkdtempSync(path.join(tmpdir(), "workit-pi-worker-"))): PiRuntime => ({
  node: "node",
  cli: "/path/to/pi.js",
  workitExtension: "/path/to/workit.js",
  root,
});

const assignment = (role: WorkerAssignment["role"] = "reviewer"): WorkerAssignment => ({
  role,
  objective: "inspect the assigned area",
  scope: {
    description: "assigned area",
    paths: ["src"],
    exclusions: [],
  },
  decisionIds: [],
  requirementIds: [],
  candidateId: null,
  stoppingCondition: "report the result",
});

test("reviewer and investigator commands exclude write-capable Pi tools", () => {
  for (const role of ["reviewer", "investigator"] as const) {
    const spec = workerCommand(runtime(), assignment(role));
    const tools = spec.args[spec.args.indexOf("--tools") + 1]?.split(",") ?? [];
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("find");
    expect(tools).toContain("ls");
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
    expect(tools.filter((tool) => tool.startsWith("workit_"))).toHaveLength(8);
  }
});

test("worker protocol accepts only explicit structured reports and rejects assistant claims", () => {
  const report = { outcome: "completed", summary: "reviewed", evidenceIds: [], findingIds: [] };
  expect(
    parseWorkerResult([
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      { type: "workit_worker_result", workerId: "worker-1", sessionId: "session-1", report },
    ]),
  ).toMatchObject({ ok: true, data: report });
  expect(
    parseWorkerResult([{ type: "message_end", message: { role: "assistant", content: [] } }]),
  ).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
  expect(parseWorkerLines('{"type":"workit_worker_result"}\nnot-json\n')).toHaveLength(0);
});

test("worker stdout accepts JSON split across process chunks", () => {
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    taskId: "task-1",
    workerId: "worker-1",
    sessionId: "session-1",
    spawn: () =>
      ({
        pid: 41,
        stdout: null,
        stderr: null,
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  const line = JSON.stringify({
    type: "workit_worker_result",
    workerId: "worker-1",
    sessionId: "session-1",
    report: { outcome: "completed", summary: "chunked", evidenceIds: [], findingIds: [] },
  });
  consumeWorkerOutput(worker, line.slice(0, 17));
  expect(worker.report).toBeNull();
  consumeWorkerOutput(worker, line.slice(17) + "\n");
  expect(worker.report).toMatchObject({ summary: "chunked" });
});

test("native readiness requires the correlated get_state response and assigned session", () => {
  let stdoutListener: ((chunk?: string | Buffer) => void) | undefined;
  const writes: string[] = [];
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    taskId: "task-ready",
    workerId: "worker-ready",
    sessionId: "session-ready",
    spawn: () =>
      ({
        pid: 43,
        stdout: {
          on: (event: string, listener: (chunk?: string | Buffer) => void) => {
            if (event === "data") stdoutListener = listener;
          },
          setEncoding: () => undefined,
        },
        stderr: null,
        once: () => undefined,
        stdin: { write: (value: string) => (writes.push(value), true), end: () => undefined },
        kill: () => true,
      }) as never,
  });
  expect(writes[0]).toContain('"id":"workit-ready"');
  stdoutListener?.(
    JSON.stringify({
      id: "wrong-id",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "session-ready" },
    }) + "\n",
  );
  expect(worker.ready).toBe(false);
  expect(() =>
    stdoutListener?.(
      JSON.stringify({
        id: "workit-ready",
        type: "response",
        command: "get_state",
        success: true,
        data: null,
      }) + "\n",
    ),
  ).not.toThrow();
  expect(worker.ready).toBe(false);
  stdoutListener?.(
    JSON.stringify({
      id: "workit-ready",
      type: "response",
      command: "get_state",
      success: false,
      data: { sessionId: "session-ready" },
    }) + "\n",
  );
  expect(worker.ready).toBe(false);
  stdoutListener?.(
    JSON.stringify({
      id: "workit-ready",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "other-session" },
    }) + "\n",
  );
  expect(worker.ready).toBe(false);
  stdoutListener?.(
    JSON.stringify({
      id: "workit-ready",
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "session-ready" },
    }) + "\n",
  );
  expect(worker.ready).toBe(true);
});

test("worker command passes the coordinator session id to stock Pi", () => {
  const spec = workerCommand({ ...runtime(), sessionId: "coordinator-session" }, assignment());
  const index = spec.args.indexOf("--session-id");
  expect(index).toBeGreaterThan(-1);
  expect(spec.args[index + 1]).toBe("coordinator-session");
});

test("worker stdout tolerates valid Pi RPC events around Workit protocol events", () => {
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    workerId: "worker-rpc",
    sessionId: "session-rpc",
    spawn: () =>
      ({ pid: 44, stdout: null, stderr: null, once: () => undefined, kill: () => true }) as never,
  });
  const report = {
    outcome: "completed" as const,
    summary: "rpc interleave",
    evidenceIds: [],
    findingIds: [],
  };
  consumeWorkerOutput(
    worker,
    [
      JSON.stringify({ type: "response", command: "prompt", success: true }),
      JSON.stringify({ type: "agent_start", sessionId: "pi" }),
      JSON.stringify({
        type: "workit_worker_ready",
        workerId: "worker-rpc",
        sessionId: "session-rpc",
      }),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({
        type: "workit_worker_result",
        workerId: "worker-rpc",
        sessionId: "session-rpc",
        report,
      }),
      "",
    ].join("\n"),
  );
  expect(worker.protocolError).toBeNull();
  expect(worker.ready).toBe(true);
  expect(worker.report).toEqual(report);
});

test("stderr is diagnostics only and protocol identity is strict", () => {
  const stderrListeners = new Map<string, (chunk?: string | Buffer) => void>();
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    workerId: "worker-1",
    sessionId: "session-1",
    spawn: () =>
      ({
        pid: 51,
        stdout: null,
        stderr: {
          on: (event: string, listener: (chunk?: string | Buffer) => void) =>
            stderrListeners.set(event, listener),
          setEncoding: () => undefined,
        },
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  stderrListeners.get("data")?.(
    JSON.stringify({ type: "workit_worker_ready", workerId: "worker-1", sessionId: "session-1" }) +
      "\n",
  );
  expect(worker.ready).toBe(false);
  expect(worker.protocolError).toBeNull();
  consumeWorkerOutput(
    worker,
    JSON.stringify({ type: "workit_worker_ready", workerId: "other", sessionId: "session-1" }) +
      "\n",
  );
  expect(worker.protocolError).toContain("identity");
});

test("stdout protocol rejects duplicate reports and bounded unterminated lines", () => {
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    workerId: "worker-1",
    sessionId: "session-1",
    spawn: () =>
      ({
        pid: 52,
        stdout: null,
        stderr: null,
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  const event = JSON.stringify({
    type: "workit_worker_result",
    workerId: "worker-1",
    sessionId: "session-1",
    report: { outcome: "completed", summary: "ok", evidenceIds: [], findingIds: [] },
  });
  consumeWorkerOutput(worker, event + "\n");
  consumeWorkerOutput(worker, event + "\n");
  expect(worker.protocolError).toContain("multiple");
  const oversized = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    workerId: "worker-2",
    sessionId: "session-2",
    spawn: () =>
      ({
        pid: 53,
        stdout: null,
        stderr: null,
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  consumeWorkerOutput(oversized, "x".repeat(64 * 1024 + 1));
  expect(oversized.protocolError).toContain("limit");
});

test("cancellation escalates and remains unknown until an observed exit", async () => {
  const signals: string[] = [];
  const worker = launchWorker(assignment("implementer"), {
    runtime: runtime(),
    spawn: () => {
      return {
        pid: 4123,
        stdout: { on: () => undefined, setEncoding: () => undefined },
        stderr: { on: () => undefined, setEncoding: () => undefined },
        once: () => undefined,
        kill: (signal?: NodeJS.Signals) => {
          if (signal) signals.push(signal);
          return true;
        },
      } as never;
    },
  });
  const cancelled = await cancelWorker(worker, { graceMs: 1, killWaitMs: 1 });
  expect(cancelled.state).toBe("unknown");
  expect(cancelled.observed).toBe(false);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("implementer process is bound before prompt and receives scoped environment", () => {
  let writes = 0;
  let observedPid = 0;
  let observedEnv: NodeJS.ProcessEnv | undefined;
  const child = {
    pid: 9001,
    stdout: { on: () => undefined, setEncoding: () => undefined },
    stderr: { on: () => undefined, setEncoding: () => undefined },
    once: () => undefined,
    stdin: {
      write: () => {
        writes += 1;
        return true;
      },
      end: () => undefined,
    },
    kill: () => true,
  };
  const worker = launchWorker(assignment("implementer"), {
    runtime: runtime(),
    taskId: "task-1",
    workerId: "worker-1",
    sessionId: "session-1",
    spawn: (_command, _args, options) => {
      observedPid = child.pid;
      observedEnv = options.env;
      return child as never;
    },
    onSpawn: (handle) => {
      expect(handle.pid).toBe(9001);
      expect(handle.sessionId).toBe("session-1");
      expect(writes).toBe(1);
      return true;
    },
  });
  expect(worker.state).toBe("running");
  expect(sendWorkerPrompt(worker, "before writer")).toBe(false);
  consumeWorkerOutput(
    worker,
    JSON.stringify({ type: "workit_worker_ready", workerId: "worker-1", sessionId: "session-1" }) +
      "\n",
  );
  expect(sendWorkerPrompt(worker, "before writer")).toBe(false);
  worker.writerReady = true;
  expect(sendWorkerPrompt(worker, "after writer")).toBe(true);
  expect(writes).toBe(2);
  expect(observedPid).toBe(9001);
  expect(observedEnv).toMatchObject({
    WORKIT_PI_TASK_ID: "task-1",
    WORKIT_PI_WORKER_ID: "worker-1",
    WORKIT_PI_WORKER_SESSION: "session-1",
    WORKIT_PI_WORKER_SCOPE: JSON.stringify(assignment("implementer").scope),
  });
});

test("launch failure remains assigned and has no writer-ready state", () => {
  const worker = launchWorker(assignment("implementer"), {
    runtime: runtime(),
    spawn: () => {
      throw new Error("spawn failed");
    },
  });
  expect(worker.state).toBe("assigned");
  expect(worker.child).toBeNull();
  expect(worker.writerReady).toBe(false);
});

test("an asynchronous spawn error never grants readiness or a writer", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const worker = launchWorker(assignment("implementer"), {
    runtime: runtime(),
    spawn: () =>
      ({
        pid: 600,
        stdout: null,
        stderr: null,
        once: (event: string, listener: (...args: unknown[]) => void) =>
          listeners.set(event, listener),
        kill: () => true,
      }) as never,
  });
  listeners.get("error")?.(new Error("spawn failed after return"));
  expect(worker.state).toBe("assigned");
  expect(worker.ready).toBe(false);
  expect(worker.writerReady).toBe(false);
});

test("report is not exit, and only observed exit reconciles", () => {
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    spawn: () =>
      ({
        pid: 77,
        stdout: { on: () => undefined, setEncoding: () => undefined },
        stderr: { on: () => undefined, setEncoding: () => undefined },
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  worker.report = { outcome: "completed", summary: "ok", evidenceIds: [], findingIds: [] };
  expect(worker.state).toBe("running");
  expect(reconcileWorker(worker).ok).toBe(false);
  observeExit(worker, 0);
  expect(reconcileWorker(worker)).toMatchObject({
    ok: true,
    data: { observed: true, state: "stopped" },
  });
});

test("restart reconciliation never infers a live worker is stopped", () => {
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(),
    spawn: () =>
      ({
        pid: 77,
        stdout: null,
        stderr: null,
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  worker.child = null;
  worker.state = "running";
  expect(reconcileWorker(worker).ok).toBe(false);
  expect(worker.state as string).toBe("unknown");
});

test("nested worker launch is refused", () => {
  const old = process.env.WORKIT_PI_WORKER_ID;
  process.env.WORKIT_PI_WORKER_ID = "parent-worker";
  try {
    const worker = launchWorker(assignment("reviewer"), { runtime: runtime() });
    expect(worker.state).toBe("assigned");
    expect(worker.child).toBeNull();
  } finally {
    if (old === undefined) delete process.env.WORKIT_PI_WORKER_ID;
    else process.env.WORKIT_PI_WORKER_ID = old;
  }
});

test("native start observation binds the exact assigned Pi session before work", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-core-"));
  const store = new TaskStore(root);
  const base: OperationContext = {
    root,
    caller: { host: "pi", actor: "coordinator" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeWorker: {
      verifyWorker: ({ expected }) =>
        success(null, null, {
          kind: "host_observed",
          host: "pi",
          session: expected.session,
          workerId: expected.workerId,
          receipts: [{ kind: "host", host: "pi", handle: "pid:42" }],
        }),
    },
  };
  const core = new WorkitCore(store, base);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("fixture state missing");
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    assignment: assignment("reviewer"),
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const after = store.readTask(task.data.id);
  const afterWorkspace = store.readWorkspace();
  if (!after.ok || !afterWorkspace.ok || !afterWorkspace.data)
    throw new Error("assignment missing");
  const worker = launchWorker(assignment("reviewer"), {
    runtime: runtime(root),
    taskId: task.data.id,
    workerId: assigned.data.id,
    sessionId: "pi-child-1",
    spawn: () =>
      ({
        pid: 42,
        stdout: null,
        stderr: null,
        once: () => undefined,
        kill: () => true,
      }) as never,
  });
  const observed = observeWorkerStart(
    {
      core,
      taskId: task.data.id,
      workerId: assigned.data.id,
      expectedRevision: after.data.revision,
      expectedWorkspaceRevision: afterWorkspace.data.revision,
      sessionId: "pi-child-1",
    },
    worker,
  );
  expect(observed.ok).toBe(true);
});

test("supervised implementer observes the child before acquiring writer or sending prompt", () => {
  const order: string[] = [];
  let writes = 0;
  const child = {
    pid: 12,
    stdout: { on: () => undefined, setEncoding: () => undefined },
    stderr: { on: () => undefined, setEncoding: () => undefined },
    once: () => undefined,
    stdin: {
      write: (value: string) => {
        if (value.includes('"type":"prompt"')) {
          order.push("prompt");
          writes += 1;
        }
        return true;
      },
      end: () => undefined,
    },
    kill: () => true,
  };
  const fakeCore = {
    observeWorkerLifecycle: () => {
      order.push("observe");
      return { ok: true, schemaVersion: 1, revision: "r", workspaceRevision: "w", data: {} };
    },
    writer: () => {
      order.push("writer");
      return { ok: true, schemaVersion: 1, revision: "r2", workspaceRevision: "w2", data: {} };
    },
  } as unknown as WorkitCore;
  const worker = launchSupervisedWorker(assignment("implementer"), {
    runtime: runtime(),
    binding: {
      core: fakeCore,
      taskId: "task",
      workerId: "worker",
      expectedRevision: "r",
      expectedWorkspaceRevision: "w",
      sessionId: "session",
    },
    prompt: "implement",
    spawn: () => child as never,
  });
  expect(worker.state).toBe("running");
  expect(order).toEqual(["observe"]);
  consumeWorkerOutput(
    worker,
    JSON.stringify({ type: "workit_worker_ready", workerId: "worker", sessionId: "session" }) +
      "\n",
  );
  expect(order).toEqual(["observe", "writer", "prompt"]);
  expect(order).toEqual(["observe", "writer", "prompt"]);
  expect(writes).toBe(1);
});

test("writer failure persists unknown before termination and reconciles only on observed exit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-writer-failure-"));
  const store = new TaskStore(root);
  let child: import("../../packages/workit-pi/src/worker").WorkerHandle | null = null;
  let stdoutListener: ((chunk?: string | Buffer) => void) | undefined;
  let killed = 0;
  const base: OperationContext = {
    root,
    caller: { host: "pi", actor: "coordinator" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeWorker: nativeWorkerForEvidence(() => child),
  };
  const core = new WorkitCore(store, base);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const initialTask = store.readTask(taskId);
  const initialWorkspace = store.readWorkspace();
  if (!initialTask.ok || !initialWorkspace.ok || !initialWorkspace.data)
    throw new Error("missing fixture");
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: initialTask.data.revision,
    expectedWorkspaceRevision: initialWorkspace.data.revision,
    assignment: assignment("implementer"),
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("missing assignment");
  const binding = {
    core,
    taskId,
    workerId: assigned.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    sessionId: "writer-failure-session",
  };
  const writerCore = {
    writer: () => failure("permission_denied", "writer rejected"),
  } as unknown as WorkitCore;
  const handle = launchSupervisedWorker(assignment("implementer"), {
    runtime: runtime(root),
    binding,
    writerCore,
    prompt: "must not be sent",
    onSpawn: (spawned) => {
      child = spawned;
      return true;
    },
    onUncertain: (uncertainHandle, _exit) => {
      const freshTask = store.readTask(taskId);
      const freshWorkspace = store.readWorkspace();
      if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data) return false;
      binding.expectedRevision = freshTask.data.revision;
      binding.expectedWorkspaceRevision = freshWorkspace.data.revision;
      const observed = core.observeWorkerLifecycle({
        taskId,
        workerId: assigned.data.id,
        expectedRevision: binding.expectedRevision,
        expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
        state: "unknown",
        session: { kind: "host", host: "pi", handle: binding.sessionId },
        observation: { pid: uncertainHandle.pid, sessionId: binding.sessionId },
      });
      advanceWorkerBinding(binding, observed);
      return observed.ok;
    },
    spawn: () =>
      ({
        pid: 813,
        stdout: {
          on: (event: string, listener: (chunk?: string | Buffer) => void) => {
            if (event === "data") stdoutListener = listener;
          },
          setEncoding: () => undefined,
        },
        stderr: { on: () => undefined, setEncoding: () => undefined },
        once: () => undefined,
        stdin: {
          write: (value: string) => {
            expect(value).not.toContain('"type":"prompt"');
            return true;
          },
          end: () => undefined,
        },
        kill: () => {
          killed += 1;
          return true;
        },
      }) as never,
  });
  stdoutListener?.(
    JSON.stringify({
      type: "workit_worker_ready",
      workerId: assigned.data.id,
      sessionId: binding.sessionId,
    }) + "\n",
  );
  expect(killed).toBe(1);
  const uncertain = store.readTask(taskId);
  expect(
    uncertain.ok &&
      uncertain.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("unknown");
  observeExit(handle, 0);
  const stopped = store.readTask(taskId);
  expect(
    stopped.ok && stopped.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("stopped");
});

test("core-backed supervisor refreshes revisions through report and observed exit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-supervised-"));
  const store = new TaskStore(root);
  let child: import("../../packages/workit-pi/src/worker").WorkerHandle | null = null;
  let stdoutListener: ((chunk?: string | Buffer) => void) | undefined;
  let prompt = "";
  const base: OperationContext = {
    root,
    caller: { host: "pi", actor: "coordinator" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeWorker: nativeWorkerForEvidence(() => child),
  };
  const core = new WorkitCore(store, base);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const initialTask = store.readTask(taskId);
  const initialWorkspace = store.readWorkspace();
  if (!initialTask.ok || !initialWorkspace.ok || !initialWorkspace.data)
    throw new Error("missing fixture");
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: initialTask.data.revision,
    expectedWorkspaceRevision: initialWorkspace.data.revision,
    assignment: assignment("implementer"),
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("missing assignment");
  const sessionId = "child-session";
  const binding = {
    core,
    taskId,
    workerId: assigned.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    sessionId,
  };
  const childCore = new WorkitCore(store, {
    ...base,
    caller: { host: "pi", actor: sessionId },
    workerId: assigned.data.id,
    nativeWorker: nativeWorkerForEvidence(() => child),
  });
  const handle = launchSupervisedWorker(assignment("implementer"), {
    runtime: runtime(root),
    binding,
    writerCore: childCore,
    prompt: "implement",
    onSpawn: (spawned) => {
      child = spawned;
      return true;
    },
    onReport: (_handle, report) => {
      const freshTask = store.readTask(taskId);
      const freshWorkspace = store.readWorkspace();
      if (!freshTask.ok || !freshWorkspace.ok || !freshWorkspace.data) return false;
      const result = reportWorker(
        childCore,
        taskId,
        assigned.data.id,
        report,
        freshTask.data.revision,
        freshWorkspace.data.revision,
      );
      advanceWorkerBinding(binding, result);
      return result.ok;
    },
    spawn: () =>
      ({
        pid: 777,
        stdout: {
          on: (event: string, listener: (chunk?: string | Buffer) => void) => {
            if (event === "data") stdoutListener = listener;
          },
          setEncoding: () => undefined,
        },
        stderr: { on: () => undefined, setEncoding: () => undefined },
        once: () => undefined,
        stdin: {
          write: (value: string) => {
            prompt += value;
            return true;
          },
          end: () => undefined,
        },
        kill: () => true,
      }) as never,
  });
  expect(handle.state).toBe("running");
  stdoutListener?.(
    JSON.stringify({ type: "workit_worker_ready", workerId: assigned.data.id, sessionId }) + "\n",
  );
  const running = store.readTask(taskId);
  const held = store.readWorkspace();
  expect(
    running.ok && running.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("running");
  expect(held.ok && held.data?.writer?.state).toBe("held");
  expect(prompt).toContain('"type":"prompt"');
  stdoutListener?.(
    JSON.stringify({
      type: "workit_worker_result",
      workerId: assigned.data.id,
      sessionId,
      report: { outcome: "completed", summary: "reviewed", evidenceIds: [], findingIds: [] },
    }) + "\n",
  );
  const reportedTask = store.readTask(taskId);
  expect(
    reportedTask.ok &&
      reportedTask.data.workers.find((entry) => entry.id === assigned.data.id)?.data.report
        ?.summary,
  ).toBe("reviewed");
  expect(
    reportedTask.ok &&
      reportedTask.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("running");
  observeExit(handle, 0);
  const stoppedWorkspace = store.readWorkspace();
  const stoppedTask = store.readTask(taskId);
  expect(stoppedWorkspace.ok && stoppedWorkspace.data?.writer).toBeNull();
  expect(
    stoppedTask.ok &&
      stoppedTask.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("stopped");
});

test("supervised asynchronous spawn failure is persisted as unknown by core", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-pi-spawn-error-"));
  const store = new TaskStore(root);
  let child: import("../../packages/workit-pi/src/worker").WorkerHandle | null = null;
  const base: OperationContext = {
    root,
    caller: { host: "pi", actor: "coordinator" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
    nativeWorker: nativeWorkerForEvidence(() => child),
  };
  const core = new WorkitCore(store, base);
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as { id: string }).id;
  const task = store.readTask(taskId);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("missing fixture");
  const assigned = core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    assignment: assignment("reviewer"),
  });
  if (!assigned.ok) throw new Error(assigned.error);
  const afterTask = store.readTask(taskId);
  const afterWorkspace = store.readWorkspace();
  if (!afterTask.ok || !afterWorkspace.ok || !afterWorkspace.data)
    throw new Error("missing assignment");
  const binding = {
    core,
    taskId,
    workerId: assigned.data.id,
    expectedRevision: afterTask.data.revision,
    expectedWorkspaceRevision: afterWorkspace.data.revision,
    sessionId: "async-error-session",
  };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const handle = launchSupervisedWorker(assignment("reviewer"), {
    runtime: runtime(root),
    binding,
    onSpawn: (spawned) => {
      child = spawned;
      return true;
    },
    spawn: () =>
      ({
        pid: 812,
        stdout: null,
        stderr: null,
        once: (event: string, listener: (...args: unknown[]) => void) =>
          listeners.set(event, listener),
        kill: () => true,
      }) as never,
  });
  expect(handle.state).toBe("running");
  listeners.get("error")?.(new Error("late spawn failure"));
  const failed = store.readTask(taskId);
  expect(
    failed.ok && failed.data.workers.find((entry) => entry.id === assigned.data.id)?.data.state,
  ).toBe("unknown");
  const failedWorkspace = store.readWorkspace();
  expect(failedWorkspace.ok && failedWorkspace.data?.writer).toBeNull();
});
