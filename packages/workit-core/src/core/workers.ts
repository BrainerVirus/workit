import {
  canonicalJson,
  failure,
  provenanceSchema,
  scopeCovers,
  success,
  type Caller,
  type Entry,
  type Id,
  type Owner,
  type Provenance,
  type Ref,
  type Result,
  type Revision,
  type TaskRecord,
  type Utc,
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

export type NativeWorkerVerifier = {
  verifyWorker: (input: NativeWorkerVerification) => Result<Provenance>;
};

type WorkerBinding = {
  owner: object;
  store: TaskStore;
  root: string;
  caller: Caller;
};
type WorkerAuthority = {
  taskId: Id;
  workspaceId: Id;
  workerId: Id;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  state: WorkerState;
  session: HostSession | null;
  provenance: Provenance;
  owner: object;
  store: TaskStore;
  root: string;
  caller: Caller;
};

type VerifiedWorker = object;
const verifiedWorkers = new WeakMap<object, WorkerAuthority>();

const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const callerSession = (caller: CallerContext): HostSession =>
  caller.session ?? { kind: "host", host: caller.host, handle: caller.actor };

const validProvenance = (
  value: unknown,
  caller: Caller,
  expected: Pick<NativeWorkerObservation, "workerId" | "session">,
): value is Provenance => {
  if (!provenanceSchema.safeParse(value).success) return false;
  const provenance = value as Provenance;
  return (
    provenance.kind === "host_observed" &&
    provenance.host === caller.host &&
    provenance.workerId === expected.workerId &&
    same(provenance.session, expected.session) &&
    provenance.receipts.some((receipt) => receipt.kind === "host" && receipt.host === caller.host)
  );
};

export const verifyNativeWorker = (
  verifier: NativeWorkerVerifier | undefined,
  input: NativeWorkerVerification,
  binding: WorkerBinding,
): Result<VerifiedWorker> => {
  if (!verifier) return failure("permission_denied", "native worker verifier is unavailable");
  let result: Result<Provenance>;
  try {
    result = verifier.verifyWorker(input);
  } catch (error) {
    return failure("permission_denied", `native worker observation failed: ${String(error)}`);
  }
  const expected = input.expected;
  if (!result.ok || !validProvenance(result.data, input.caller, expected))
    return failure("permission_denied", "native worker observation was not attested");
  const token = {};
  verifiedWorkers.set(token, {
    taskId: expected.taskId,
    workspaceId: expected.workspaceId,
    workerId: expected.workerId,
    expectedRevision: expected.expectedRevision,
    expectedWorkspaceRevision: expected.expectedWorkspaceRevision,
    state: expected.state,
    session: expected.session,
    provenance: result.data,
    ...binding,
  });
  return success(null, null, token);
};

const takeWorker = (
  token: VerifiedWorker,
  binding: WorkerBinding,
  expected: NativeWorkerObservation,
): WorkerAuthority | null => {
  const value = verifiedWorkers.get(token);
  verifiedWorkers.delete(token);
  if (!value) return null;
  if (
    value.owner !== binding.owner ||
    value.store !== binding.store ||
    value.root !== binding.root ||
    value.root !== value.store.root ||
    !same(value.caller, binding.caller) ||
    value.taskId !== expected.taskId ||
    value.workerId !== expected.workerId ||
    value.expectedRevision !== expected.expectedRevision ||
    value.expectedWorkspaceRevision !== expected.expectedWorkspaceRevision ||
    value.state !== expected.state ||
    !same(value.session, expected.session)
  )
    return null;
  return value;
};

export type ObserveWorkerLifecycleInput = NativeWorkerObservation & {
  store: TaskStore;
  authority: VerifiedWorker;
  authorityOwner: object;
  caller: Caller;
  now?: Utc;
};

/** Apply only an adapter-attested worker lifecycle observation. */
export function observeWorkerLifecycle(input: ObserveWorkerLifecycleInput): Result<Entry<Worker>> {
  if (!input.store || !input.authority || !input.authorityOwner)
    return failure("invalid_input", "native worker observation preconditions are required");
  const authority = takeWorker(
    input.authority,
    {
      owner: input.authorityOwner,
      store: input.store,
      root: input.store.root,
      caller: input.caller,
    },
    input,
  );
  if (!authority) return failure("permission_denied", "native worker observation is not verified");

  const task = input.store.readTask(input.taskId);
  if (!task.ok) return task as Result<never>;
  const workspace = input.store.readWorkspace();
  if (!workspace.ok) return workspace as Result<never>;
  if (!workspace.data) return failure("not_found", "workspace not found");
  if (
    task.data.workspaceId !== authority.workspaceId ||
    workspace.data.id !== authority.workspaceId
  )
    return failure("recovery_required", "worker workspace binding is invalid");
  const entry = task.data.workers.find((candidate) => candidate.id === input.workerId);
  if (!entry) return failure("not_found", "worker not found");
  if (task.data.status === "closed")
    return failure("invalid_transition", "closed task cannot observe workers");
  if (task.data.status === "paused" && (input.state === "running" || input.state === "cancelling"))
    return failure("invalid_transition", "paused task cannot run a worker");
  if (
    (input.state === "running" || input.state === "cancelling" || input.state === "stopped") &&
    !input.session
  )
    return failure("invalid_input", "running worker observations require a session");
  if (entry.data.session && !same(entry.data.session, input.session))
    return failure("permission_denied", "worker session does not match its assignment");
  if (input.state !== "running" && entry.data.state === "assigned" && input.state !== "stopped")
    return failure("invalid_transition", "worker has not started");
  if (input.state === "running" && entry.data.state === "stopped")
    return failure("invalid_transition", "stopped worker cannot run again");
  const nextEntry = {
    ...entry,
    recordedAt: input.now ?? entry.recordedAt,
    provenance: authority.provenance,
    data: {
      ...entry.data,
      state: input.state,
      session: input.session,
    },
  } satisfies Entry<Worker>;

  const shouldClear =
    input.state === "stopped" &&
    workspace.data.writer !== null &&
    workspace.data.writer.owner.taskId === task.data.id &&
    workspace.data.writer.owner.workerId === input.workerId;
  const shouldUncertain =
    input.state === "unknown" &&
    workspace.data.writer !== null &&
    workspace.data.writer.owner.taskId === task.data.id &&
    workspace.data.writer.owner.workerId === input.workerId;
  const changed = input.store.mutateTaskAndWorkspace({
    taskId: task.data.id,
    expectedTaskRevision: input.expectedRevision,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    now: input.now,
    workspace: (current, mutation) =>
      success(mutation.revision, mutation.revision, {
        ...current,
        writer: shouldClear
          ? null
          : shouldUncertain && current.writer
            ? { ...current.writer, state: "uncertain" as const }
            : current.writer,
      }),
    task: (current, mutation) =>
      success(mutation.revision, null, {
        ...current,
        workers: current.workers.map((candidate) =>
          candidate.id === nextEntry.id ? { ...nextEntry, recordedAt: mutation.now } : candidate,
        ),
      }),
  });
  if (!changed.ok) return changed as Result<never>;
  const updated = changed.data.task.workers.find((candidate) => candidate.id === input.workerId);
  return updated
    ? success(changed.data.task.revision, changed.data.workspace.revision, updated)
    : failure("recovery_required", "worker disappeared during lifecycle observation");
}

const validPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "/" &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  !value.includes("\\") &&
  !value.split("/").includes("..");

const callerValue = (value: CallerContext): Caller => ({ host: value.host, actor: value.actor });
const workerIdOf = (value: CallerContext): Id | null => value.workerId ?? null;

export type ProductWriteInput = {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  caller: CallerContext;
  paths: string[];
};

/** Check the authoritative workspace owner and the caller's assigned scope. */
export function assertProductWriteAllowed(input: ProductWriteInput): Result<Owner> {
  if (!Array.isArray(input.paths) || input.paths.some((path) => !validPath(path)))
    return failure("invalid_input", "product write paths must stay inside the checkout");
  if (input.task.status !== "active")
    return failure("invalid_transition", "paused or closed tasks cannot own product writes");
  if (input.workspace.id !== input.task.workspaceId || input.workspace.root.length === 0)
    return failure("recovery_required", "task and workspace bindings are invalid");
  const writer = input.workspace.writer;
  if (!writer) return failure("permission_denied", "checkout has no writer owner");
  if (writer.state === "uncertain")
    return failure("recovery_required", "checkout writer requires recovery", {
      owner: writer.owner,
    });
  const caller = callerValue(input.caller);
  const workerId = workerIdOf(input.caller);
  const owner = writer.owner;
  if (
    owner.taskId !== input.task.id ||
    owner.workerId !== workerId ||
    owner.session.host !== caller.host ||
    owner.session.handle !== caller.actor
  )
    return failure("writer_conflict", "checkout is owned by another validated actor", { owner });
  const assignedScope =
    workerId === null
      ? input.task.intent.data.scope
      : input.task.workers.find((entry) => entry.id === workerId)?.data.assignment.scope;
  const worker =
    workerId === null ? null : input.task.workers.find((entry) => entry.id === workerId);
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
  if (
    !assignedScope ||
    input.paths.some((path) => !scopeCovers(assignedScope!, { ...assignedScope!, paths: [path] }))
  )
    return failure("permission_denied", "product write is outside the assigned scope");
  return success(null, input.workspace.revision, owner);
}

export type { VerifiedWorker };
