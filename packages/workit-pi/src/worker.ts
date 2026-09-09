import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Assignment,
  NativeWorkerVerifier,
  WorkerDispatch,
  WorkerReport,
  Worker,
  WorkitCore,
} from "@brainervirus/workit-core/src/core";
import {
  OPERATION_FAMILIES,
  failure,
  success,
  type ContractResult as Result,
} from "@brainervirus/workit-core/src/core";
import {
  appendBoundedStderr,
  MAX_WORKER_LINE_BYTES,
  parseWorkerLine,
  parseWorkerResult,
  type WorkerProtocolEvent,
} from "./worker-protocol";
export { parseWorkerResult } from "./worker-protocol";

export type WorkerAssignment = Assignment;
type WorkerState = Worker["state"];
export type PiRuntime = {
  node: string;
  cli: string;
  workitExtension: string;
  root: string;
  sessionId?: string;
};
export type SpawnSpec = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};
export type ObservedExit = {
  state: "stopped" | "unknown";
  observed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};
type WorkerStream = {
  on(event: string, listener: (chunk?: string | Buffer, ...args: unknown[]) => void): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
};
type WorkerChild = {
  pid?: number;
  stdout?: WorkerStream | null;
  stderr?: WorkerStream | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  stdin?: { write(chunk: string): boolean; end(): void } | null;
};
type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => WorkerChild;

export type WorkerHandle = {
  id: string;
  taskId: string | null;
  workerId: string | null;
  sessionId: string;
  assignment: WorkerAssignment;
  spec: SpawnSpec;
  child: WorkerChild | null;
  pid: number | null;
  /** True once a spawn was attempted: after that, no child can be ruled out. */
  spawned: boolean;
  /** Live launch reservation, held only while this handle has produced no child. */
  dispatch: WorkerDispatch | null;
  state: WorkerState;
  report: WorkerReport | null;
  events: WorkerProtocolEvent[];
  stdoutBuffer: string;
  stderr: string;
  exit: ObservedExit | null;
  writerReady: boolean;
  ready: boolean;
  protocolError: string | null;
  pendingPrompt?: string;
  onReady?: (handle: WorkerHandle) => void;
  onError?: (handle: WorkerHandle) => void;
  onReport?: (handle: WorkerHandle, report: WorkerReport) => boolean;
  onExit?: (handle: WorkerHandle, exit: ObservedExit) => void;
};

export type LaunchOptions = {
  runtime: PiRuntime;
  taskId?: string;
  workerId?: string;
  sessionId?: string;
  writerReady?: boolean;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  /** Runs on the live handle before any spawn; a false result cancels the launch. */
  onPrepare?: (handle: WorkerHandle) => boolean;
  onSpawn?: (handle: WorkerHandle) => boolean;
  onError?: (handle: WorkerHandle) => void;
  onReady?: (handle: WorkerHandle) => void;
  onReport?: (handle: WorkerHandle, report: WorkerReport) => boolean;
  onExit?: (handle: WorkerHandle, exit: ObservedExit) => void;
  pendingPrompt?: string;
};
export type CancelOptions = {
  graceMs?: number;
  killWaitMs?: number;
  /** Required to record a never-dispatched worker as stopped. */
  binding?: WorkerLifecycleBinding;
};
export type WorkerLifecycleBinding = {
  core: WorkitCore;
  taskId: string;
  workerId: string;
  expectedRevision: string;
  expectedWorkspaceRevision: string;
  sessionId: string;
  observation?: unknown;
};
export type SupervisedLaunchOptions = LaunchOptions & {
  binding: WorkerLifecycleBinding;
  prompt?: string;
  writerCore?: WorkitCore;
  beforeExit?: (handle: WorkerHandle, exit: ObservedExit) => void;
  onUncertain?: (handle: WorkerHandle, exit: ObservedExit) => boolean;
};

const advanceBinding = (binding: WorkerLifecycleBinding, result: Result<unknown>): boolean => {
  if (!result.ok || !result.revision || !result.workspaceRevision) return false;
  binding.expectedRevision = result.revision;
  binding.expectedWorkspaceRevision = result.workspaceRevision;
  return true;
};
export const advanceWorkerBinding = advanceBinding;

const familyTools = OPERATION_FAMILIES.map((family) => "workit_" + family);
const roleTools = (role: WorkerAssignment["role"]): string[] => {
  const readOnly = ["read", "grep", "find", "ls"];
  if (role === "implementer") return [...readOnly, "write", "edit", ...familyTools];
  return [...readOnly, ...familyTools];
};

export function workerCommand(runtime: PiRuntime, assignment: WorkerAssignment): SpawnSpec {
  return {
    command: runtime.node,
    args: [
      runtime.cli,
      "--mode",
      "rpc",
      "--no-session",
      ...(runtime.sessionId ? ["--session-id", runtime.sessionId] : []),
      "--approve",
      "--offline",
      "--no-context-files",
      "--tools",
      roleTools(assignment.role).join(","),
      "--extension",
      runtime.workitExtension,
    ],
    cwd: runtime.root,
  };
}

const attach = (handle: WorkerHandle): void => {
  const child = handle.child;
  if (!child) return;
  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on("data", (chunk) => {
    consumeWorkerOutput(handle, String(chunk));
  });
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    handle.stderr = appendBoundedStderr(handle.stderr, text);
  });
  child.stdin?.write(JSON.stringify({ id: "workit-ready", type: "get_state" }) + "\n");
  child.once("exit", (...args: unknown[]) => {
    const code = typeof args[0] === "number" ? args[0] : null;
    const signal = typeof args[1] === "string" ? (args[1] as NodeJS.Signals) : null;
    observeExit(handle, code, signal);
  });
  child.once("error", () => {
    if (!handle.exit) {
      handle.state = "assigned";
      handle.onError?.(handle);
    }
  });
};

export function launchWorker(assignment: WorkerAssignment, options: LaunchOptions): WorkerHandle {
  const nested = Boolean(process.env.WORKIT_PI_WORKER_ID || options.env?.WORKIT_PI_WORKER_ID);
  const taskId = options.taskId ?? null;
  const workerId = options.workerId ?? null;
  const sessionId = options.sessionId ?? "pi-worker-" + randomUUID();
  const spec = workerCommand({ ...options.runtime, sessionId }, assignment);
  const handle: WorkerHandle = {
    id: randomUUID(),
    taskId,
    workerId,
    sessionId,
    assignment,
    spec,
    child: null,
    pid: null,
    spawned: false,
    dispatch: null,
    state: "assigned",
    report: null,
    events: [],
    stdoutBuffer: "",
    stderr: "",
    exit: null,
    writerReady: options.writerReady === true,
    ready: false,
    protocolError: null,
    pendingPrompt: options.pendingPrompt,
    onReady: options.onReady,
    onError: options.onError,
    onReport: options.onReport,
    onExit: options.onExit,
  };
  if (nested) return handle;
  if (options.onPrepare && !options.onPrepare(handle)) return handle;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    WORKIT_PI_TASK_ID: taskId ?? "",
    WORKIT_PI_WORKER_ID: workerId ?? "",
    WORKIT_PI_WORKER_SESSION: sessionId,
    WORKIT_PI_WORKER_ROLE: assignment.role,
    WORKIT_PI_WORKER_SCOPE: JSON.stringify(assignment.scope),
  };
  try {
    const spawn =
      options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    handle.spec = { ...spec, env };
    handle.spawned = true;
    handle.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    handle.pid = handle.child.pid ?? null;
    handle.state = "running";
    attach(handle);
    if (options.onSpawn && !options.onSpawn(handle)) {
      handle.child.kill("SIGTERM");
      handle.state = "assigned";
      return handle;
    }
  } catch {
    handle.child = null;
    handle.pid = null;
    handle.state = "assigned";
  }
  return handle;
}

export function observeExit(
  handle: WorkerHandle,
  code: number | null,
  signal: NodeJS.Signals | null = null,
): ObservedExit {
  const exit: ObservedExit = {
    state: "stopped",
    observed: true,
    code,
    signal,
    stderr: handle.stderr,
  };
  handle.exit = exit;
  handle.state = "stopped";
  handle.onExit?.(handle, exit);
  return exit;
}

export const consumeWorkerOutput = (handle: WorkerHandle, chunk: string): void => {
  if (handle.protocolError) return;
  const lines = (handle.stdoutBuffer + chunk).split(/\r?\n/);
  handle.stdoutBuffer = lines.pop() ?? "";
  if (Buffer.byteLength(handle.stdoutBuffer, "utf8") > MAX_WORKER_LINE_BYTES) {
    handle.stdoutBuffer = "";
    handle.protocolError = "worker stdout line exceeded the protocol limit";
    return;
  }
  const events: WorkerProtocolEvent[] = [];
  let nativeReady = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_WORKER_LINE_BYTES) {
      handle.protocolError = "worker stdout line exceeded the protocol limit";
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      handle.protocolError = "worker emitted malformed protocol output";
      return;
    }
    const type =
      typeof value === "object" && value !== null && "type" in value
        ? (value as { type?: unknown }).type
        : undefined;
    if (
      type === "response" &&
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      (value as { id?: unknown }).id === "workit-ready" &&
      "command" in value &&
      (value as { command?: unknown }).command === "get_state" &&
      "success" in value &&
      (value as { success?: unknown }).success === true &&
      "data" in value &&
      typeof (value as { data?: unknown }).data === "object" &&
      (value as { data?: unknown }).data !== null &&
      typeof (value as { data: { sessionId?: unknown } }).data.sessionId === "string" &&
      (value as { data: { sessionId: string } }).data.sessionId === handle.sessionId
    )
      nativeReady = true;
    if (typeof type === "string" && type.startsWith("workit_")) {
      const event = parseWorkerLine(line);
      if (!event) {
        handle.protocolError = "worker emitted an invalid Workit protocol event";
        return;
      }
      events.push(event);
    }
  }
  if (
    events.some(
      (event) => event.workerId !== handle.workerId || event.sessionId !== handle.sessionId,
    )
  ) {
    handle.protocolError = "worker protocol identity did not match the assigned session";
    return;
  }
  if (
    handle.events.some((event) => event.type === "workit_worker_result") &&
    events.some((event) => event.type === "workit_worker_result")
  ) {
    handle.protocolError = "worker emitted multiple results";
    return;
  }
  handle.events.push(...events);
  if (events.some((event) => event.type === "workit_worker_ready") || nativeReady)
    handle.ready = true;
  if (
    handle.ready &&
    (events.some((event) => event.type === "workit_worker_ready") || nativeReady)
  ) {
    handle.onReady?.(handle);
    handle.onReady = undefined;
    if (handle.pendingPrompt) {
      const prompt = handle.pendingPrompt;
      handle.pendingPrompt = undefined;
      sendWorkerPrompt(handle, prompt);
    }
  }
  const report = parseWorkerResult(events);
  if (report.ok && !handle.report) {
    handle.report = report.data;
    if (handle.onReport && !handle.onReport(handle, report.data)) {
      handle.protocolError = "worker report could not be persisted";
      handle.onReport = undefined;
      handle.child?.kill("SIGTERM");
    }
    handle.onReport = undefined;
  }
};

export function sendWorkerPrompt(handle: WorkerHandle, prompt: string): boolean {
  if (!handle.child?.stdin || handle.state !== "running" || !handle.ready) return false;
  if (handle.assignment.role === "implementer" && !handle.writerReady) return false;
  return handle.child.stdin.write(
    JSON.stringify({ id: "workit", type: "prompt", message: prompt }) + "\n",
  );
}

/** Claim the launch slot before the process exists; the handle keeps the reservation. */
export const prepareWorkerLaunch = (
  binding: WorkerLifecycleBinding,
  handle: WorkerHandle,
): Result<unknown> => {
  const result = binding.core.prepareWorkerDispatch({
    taskId: binding.taskId,
    workerId: binding.workerId,
    expectedRevision: binding.expectedRevision,
    expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
    observation: { stage: "prepare", sessionId: handle.sessionId },
  });
  advanceBinding(binding, result);
  if (result.ok) handle.dispatch = result.data;
  return result;
};

/** Only this handle can prove that its own reservation never produced a child. */
export const commitWorkerNotStarted = (
  binding: WorkerLifecycleBinding,
  handle: WorkerHandle,
): Result<unknown> => {
  const dispatch = handle.dispatch;
  if (!dispatch) return failure("recovery_required", "worker launch reservation is not live");
  const result = binding.core.commitWorkerDispatch({
    dispatch,
    taskId: binding.taskId,
    workerId: binding.workerId,
    expectedRevision: binding.expectedRevision,
    expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
    outcome: "not_started",
    session: null,
    observation: { stage: "not_started", sessionId: handle.sessionId },
  });
  advanceBinding(binding, result);
  if (result.ok) handle.dispatch = null;
  return result;
};

export const observeWorkerStart = (
  binding: WorkerLifecycleBinding,
  handle: WorkerHandle,
): Result<unknown> => {
  const session = { kind: "host" as const, host: "pi" as const, handle: binding.sessionId };
  const observation = binding.observation ?? { pid: handle.pid, sessionId: handle.sessionId };
  const dispatch = handle.dispatch;
  const result = dispatch
    ? binding.core.commitWorkerDispatch({
        dispatch,
        taskId: binding.taskId,
        workerId: binding.workerId,
        expectedRevision: binding.expectedRevision,
        expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
        outcome: "started",
        session,
        observation,
      })
    : binding.core.observeWorkerLifecycle({
        taskId: binding.taskId,
        workerId: binding.workerId,
        expectedRevision: binding.expectedRevision,
        expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
        state: "running",
        session,
        observation,
      });
  if (dispatch && result.ok) handle.dispatch = null;
  advanceBinding(binding, result);
  return result;
};

export const observeWorkerExit = (
  binding: WorkerLifecycleBinding,
  handle: WorkerHandle,
  exit: ObservedExit,
): Result<unknown> => {
  const result = binding.core.observeWorkerLifecycle({
    taskId: binding.taskId,
    workerId: binding.workerId,
    expectedRevision: binding.expectedRevision,
    expectedWorkspaceRevision: binding.expectedWorkspaceRevision,
    state: exit.state === "stopped" ? "stopped" : "unknown",
    session: { kind: "host", host: "pi", handle: binding.sessionId },
    observation: {
      pid: handle.pid,
      sessionId: handle.sessionId,
      code: exit.code,
      signal: exit.signal,
    },
  });
  advanceBinding(binding, result);
  return result;
};

export const acquireWorkerWriter = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
): Result<unknown> =>
  core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId,
    workerId,
    expectedRevision,
    expectedWorkspaceRevision,
  });

export const assignWorker = (
  core: WorkitCore,
  taskId: string,
  assignment: WorkerAssignment,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
): Result<unknown> =>
  core.worker({
    schemaVersion: 1,
    action: "assign",
    taskId,
    expectedRevision,
    expectedWorkspaceRevision,
    assignment,
  });

export const reportWorker = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  report: WorkerReport,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
): Result<unknown> =>
  core.worker({
    schemaVersion: 1,
    action: "report",
    taskId,
    workerId,
    report,
    expectedRevision,
    expectedWorkspaceRevision,
  });

export const cancelWorkerAssignment = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
  reason = "Pi host requested cancellation",
): Result<unknown> =>
  core.worker({
    schemaVersion: 1,
    action: "cancel",
    taskId,
    workerId,
    expectedRevision,
    expectedWorkspaceRevision,
    reason,
  });

export const releaseWorkerWriter = (
  core: WorkitCore,
  taskId: string,
  workerId: string,
  expectedRevision: string,
  expectedWorkspaceRevision: string,
): Result<unknown> =>
  core.writer({
    schemaVersion: 1,
    action: "release",
    taskId,
    workerId,
    expectedRevision,
    expectedWorkspaceRevision,
  });

export const workerEnvironment = (handle: WorkerHandle): NodeJS.ProcessEnv => ({
  WORKIT_PI_TASK_ID: handle.taskId ?? "",
  WORKIT_PI_WORKER_ID: handle.workerId ?? "",
  WORKIT_PI_WORKER_SESSION: handle.sessionId,
  WORKIT_PI_WORKER_ROLE: handle.assignment.role,
  WORKIT_PI_WORKER_SCOPE: JSON.stringify(handle.assignment.scope),
});

export const launchSupervisedWorker = (
  assignment: WorkerAssignment,
  options: SupervisedLaunchOptions,
): WorkerHandle => {
  const handle = launchWorker(assignment, {
    ...options,
    taskId: options.binding.taskId,
    workerId: options.binding.workerId,
    sessionId: options.binding.sessionId,
    writerReady: assignment.role !== "implementer",
    pendingPrompt: options.prompt,
    onPrepare: (pending) => {
      if (options.onPrepare && !options.onPrepare(pending)) return false;
      return prepareWorkerLaunch(options.binding, pending).ok;
    },
    onSpawn: (spawned) => {
      if (options.onSpawn && !options.onSpawn(spawned)) return false;
      const observed = observeWorkerStart(options.binding, spawned);
      if (!observed.ok) return false;
      return true;
    },
    onError: (errored) => {
      const observed = observeWorkerExit(options.binding, errored, {
        state: "unknown",
        observed: false,
        code: null,
        signal: null,
        stderr: errored.stderr,
      });
      advanceBinding(options.binding, observed);
      options.onError?.(errored);
    },
    onReady: (readyHandle) => {
      if (assignment.role === "implementer") {
        const writer = acquireWorkerWriter(
          options.writerCore ?? options.binding.core,
          options.binding.taskId,
          options.binding.workerId,
          options.binding.expectedRevision,
          options.binding.expectedWorkspaceRevision,
        );
        readyHandle.writerReady = writer.ok;
        advanceBinding(options.binding, writer);
        if (!writer.ok) {
          readyHandle.protocolError = "worker writer acquisition failed";
          readyHandle.pendingPrompt = undefined;
          const uncertaintyPersisted = options.onUncertain?.(readyHandle, {
            state: "unknown",
            observed: false,
            code: null,
            signal: null,
            stderr: readyHandle.stderr,
          });
          if (options.onUncertain && !uncertaintyPersisted)
            readyHandle.protocolError = "worker uncertainty could not be persisted";
          readyHandle.child?.kill("SIGTERM");
          return;
        }
      }
      options.onReady?.(readyHandle);
    },
    onExit: (stopped, exit) => {
      options.beforeExit?.(stopped, exit);
      const observed = observeWorkerExit(options.binding, stopped, exit);
      advanceBinding(options.binding, observed);
      options.onExit?.(stopped, exit);
    },
  });
  if (handle.state !== "running") return handle;
  return handle;
};

export const nativeWorkerFor = (handle: WorkerHandle): NativeWorkerVerifier =>
  nativeWorkerForEvidence(() => handle);

type DispatchEvidence = Pick<
  WorkerHandle,
  "pid" | "workerId" | "sessionId" | "child" | "spawned" | "exit"
>;

export const nativeWorkerForEvidence = (
  getHandle: () => DispatchEvidence | null,
): NativeWorkerVerifier => ({
  verifyDispatch: ({ expected, caller, observation }) => {
    const handle = getHandle();
    const observed = observation as { stage?: unknown; sessionId?: unknown } | null;
    if (
      !handle ||
      caller.host !== "pi" ||
      expected.workerId !== handle.workerId ||
      typeof observed !== "object" ||
      observed === null ||
      observed.stage !== expected.stage ||
      observed.sessionId !== handle.sessionId ||
      // A spawn attempt, a child object, or any observed exit all rule out "no child".
      handle.spawned ||
      handle.child !== null ||
      handle.exit !== null
    )
      return failure("permission_denied", "Pi worker dispatch was not observed by the host");
    return success(null, null, {
      kind: "host_observed",
      host: "pi",
      session: { kind: "host", host: "pi", handle: caller.actor },
      workerId: expected.workerId,
      receipts: [{ kind: "host", host: "pi", handle: "dispatch:" + handle.sessionId }],
    });
  },
  verifyWorker: ({ expected, caller, observation }) => {
    const handle = getHandle();
    if (
      !handle ||
      caller.host !== "pi" ||
      expected.workerId !== handle.workerId ||
      expected.session?.kind !== "host" ||
      expected.session.host !== "pi" ||
      expected.session.handle !== handle.sessionId ||
      typeof observation !== "object" ||
      observation === null ||
      (observation as { pid?: unknown }).pid !== handle.pid
    )
      return failure("permission_denied", "Pi worker identity was not observed");
    return {
      ok: true,
      schemaVersion: 1,
      revision: null,
      workspaceRevision: null,
      data: {
        kind: "host_observed",
        host: "pi",
        session: expected.session,
        workerId: expected.workerId,
        receipts: [{ kind: "host", host: "pi", handle: "pid:" + String(handle.pid ?? "unknown") }],
      },
    };
  },
});

export const nativeLostWorker = (): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller, observation }) => {
    if (
      caller.host !== "pi" ||
      expected.session?.kind !== "host" ||
      expected.session.host !== "pi" ||
      typeof observation !== "object" ||
      observation === null ||
      (observation as { lost?: unknown }).lost !== true ||
      (observation as { sessionId?: unknown }).sessionId !== expected.session.handle
    )
      return failure("permission_denied", "Pi worker loss was not observed by the host");
    return {
      ok: true,
      schemaVersion: 1,
      revision: null,
      workspaceRevision: null,
      data: {
        kind: "host_observed",
        host: "pi",
        session: expected.session,
        workerId: expected.workerId,
        receipts: [{ kind: "host", host: "pi", handle: "lost:" + expected.session.handle }],
      },
    };
  },
});

export async function cancelWorker(
  handle: WorkerHandle,
  options: CancelOptions = {},
): Promise<ObservedExit> {
  if (handle.exit?.observed) return handle.exit;
  const uncertain = (): ObservedExit => {
    handle.state = "unknown";
    return { state: "unknown", observed: false, code: null, signal: null, stderr: handle.stderr };
  };
  if (!handle.child) {
    // Only this handle can prove the child was never created; a spawn attempt or a
    // reconstructed handle after a restart cannot, and stays unresolved.
    if (
      handle.spawned ||
      !handle.dispatch ||
      !options.binding ||
      !commitWorkerNotStarted(options.binding, handle).ok
    )
      return uncertain();
    handle.state = "stopped";
    handle.exit = {
      state: "stopped",
      observed: true,
      code: null,
      signal: null,
      stderr: handle.stderr,
    };
    return handle.exit;
  }
  handle.state = "cancelling";
  handle.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, options.graceMs ?? 250));
  if (handle.exit?.observed) return handle.exit;
  handle.child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, options.killWaitMs ?? 250));
  if (handle.exit?.observed) return handle.exit;
  const lost = uncertain();
  handle.exit = lost;
  return lost;
}

export const reconcileWorker = (handle: WorkerHandle): Result<ObservedExit> => {
  if (handle.exit?.observed)
    return {
      ok: true,
      schemaVersion: 1,
      revision: null,
      workspaceRevision: null,
      data: handle.exit,
    };
  if ((handle.state === "running" || handle.state === "cancelling") && !handle.child) {
    handle.state = "unknown";
    handle.exit = {
      state: "unknown",
      observed: false,
      code: null,
      signal: null,
      stderr: handle.stderr,
    };
  }
  return failure("recovery_required", "worker exit has not been observed");
};

export const workerCanLaunchNested = (): boolean => !process.env.WORKIT_PI_WORKER_ID;
