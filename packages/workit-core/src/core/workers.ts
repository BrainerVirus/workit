import {
  canonicalJson,
  failure,
  success,
  type Caller,
  type Id,
  type Owner,
  type Provenance,
  type Ref,
  type Result,
  type Revision,
  type TaskRecord,
  type Worker,
  type WorkspaceRecord,
} from "./task-contract";
import { TaskStore } from "./task-store";

export type WorkerState = Worker["state"];
export type HostSession = Extract<Ref, { kind: "host" }>;

/** The adapter-owned caller identity used by all writer checks. */
export type CallerContext = Caller & {
  workerId?: Id | null;
  session?: HostSession;
};

export type NativeWorkerObservation = {
  taskId: Id;
  workerId: Id;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  state: WorkerState;
  session: HostSession | null;
  observation: unknown;
};

export type NativeWorkerVerification = {
  observation: unknown;
  expected: Omit<NativeWorkerObservation, "observation"> & {
    workspaceId: Id;
  };
  caller: Caller;
};

/**
 * Host attestation for a worker that has no session yet: `prepare` claims the launch
 * slot, `not_started` claims that no child was ever created for that same reservation.
 */
export type WorkerDispatchStage = "prepare" | "not_started";

export type NativeWorkerDispatchVerification = {
  observation: unknown;
  expected: {
    taskId: Id;
    workspaceId: Id;
    workerId: Id;
    expectedRevision: Revision;
    expectedWorkspaceRevision: Revision;
    stage: WorkerDispatchStage;
  };
  caller: Caller;
};

export type NativeWorkerVerifier = {
  verifyWorker: (input: NativeWorkerVerification) => Result<Provenance>;
  /** Hosts that can observe their own launch surface also attest dispatch stages. */
  verifyDispatch?: (input: NativeWorkerDispatchVerification) => Result<Provenance>;
};

declare const workerDispatch: unique symbol;
/** Opaque in-process launch reservation. Adapters hold it; it is never serialized. */
export type WorkerDispatch = { readonly [workerDispatch]: true };

export type WorkerDispatchRequest = {
  taskId: Id;
  workerId: Id;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  observation: unknown;
};

export type WorkerDispatchCommit = WorkerDispatchRequest & {
  dispatch: WorkerDispatch;
  outcome: "started" | "not_started";
  session: HostSession | null;
};

const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const callerSession = (caller: CallerContext): HostSession =>
  caller.session ?? { kind: "host", host: caller.host, handle: caller.actor };

const validPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  }) &&
  !value.split(/[\\/]/).includes("..");

const callerValue = (value: CallerContext): Caller => ({ host: value.host, actor: value.actor });
const workerIdOf = (value: CallerContext): Id | null => value.workerId ?? null;

export type ProductWriteInput = {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  caller: CallerContext;
  paths: string[];
  store?: TaskStore;
};

/** Check the authoritative workspace owner and the caller's role. File paths
 *  are host-policy territory: only malformed paths are rejected here, never
 *  out-of-scope ones. */
export function assertProductWriteAllowed(input: ProductWriteInput): Result<Owner> {
  if (!Array.isArray(input.paths) || input.paths.some((path) => !validPath(path)))
    return failure("invalid_input", "invalid product write path");
  if (!input.store) return failure("permission_denied", "write authorization requires core state");
  const task = input.store.readTask(input.task.id);
  if (!task.ok) return task as Result<never>;
  const workspace = input.store.readWorkspace();
  if (!workspace.ok) return workspace as Result<never>;
  if (!workspace.data) return failure("not_found", "workspace not found");
  const workspaceRecord = workspace.data;
  if (task.data.status !== "active")
    return failure("invalid_transition", "paused or closed tasks cannot own product writes");
  if (workspaceRecord.id !== task.data.workspaceId || workspaceRecord.root.length === 0)
    return failure("recovery_required", "task and workspace bindings are invalid");
  const writer = workspaceRecord.writer;
  if (!writer) return failure("permission_denied", "checkout has no writer owner");
  if (writer.state === "uncertain")
    return failure("recovery_required", "checkout writer requires recovery", {
      owner: writer.owner,
    });
  const caller = callerValue(input.caller);
  const workerId = workerIdOf(input.caller);
  const owner = writer.owner;
  if (
    owner.taskId !== task.data.id ||
    owner.workerId !== workerId ||
    owner.session.host !== caller.host ||
    owner.session.handle !== caller.actor
  )
    return failure("writer_conflict", "checkout is owned by another validated actor", { owner });
  const worker =
    workerId === null ? null : task.data.workers.find((entry) => entry.id === workerId);
  if (workerId !== null && (!worker || worker.data.assignment.role !== "implementer"))
    return failure("permission_denied", "only implementers can own product writes");
  if (
    workerId !== null &&
    (!worker?.data.session ||
      worker.data.state === "cancelling" ||
      worker.data.state === "unknown" ||
      worker.data.state === "stopped" ||
      !same(worker.data.session, callerSession(input.caller)))
  )
    return failure("recovery_required", "worker session is not an active writer");
  return success(null, workspaceRecord.revision, owner);
}
