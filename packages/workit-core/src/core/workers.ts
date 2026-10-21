import type {
  Caller,
  Id,
  Provenance,
  Ref,
  Result,
  Revision,
  Worker,
  WorkerReport,
} from "./task-contract";

export type WorkerState = Worker["state"];
export type HostSession = Extract<Ref, { kind: "host" }>;

export type NativeWorkerObservation = {
  taskId: Id;
  workerId: Id;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  state: WorkerState;
  session: HostSession | null;
  report?: WorkerReport;
  observation: unknown;
};

export type NativeWorkerVerification = {
  observation: unknown;
  expected: Omit<NativeWorkerObservation, "observation"> & {
    workspaceId: Id;
  };
  caller: Caller;
};

/** A host that observes its own child sessions attests their lifecycle. */
export type NativeWorkerVerifier = {
  verifyWorker: (input: NativeWorkerVerification) => Result<Provenance>;
};

/** The one shared definition of active or uncertain worker state used by
 * close, revise, resume, and replacement-launch checks. */
export const UNCERTAIN_WORKER_STATES = ["dispatching", "running", "cancelling", "unknown"] as const;
export const isUncertainWorker = (state: WorkerState): boolean =>
  (UNCERTAIN_WORKER_STATES as readonly string[]).includes(state);

/**
 * Lifecycle gate table: which worker states block each lead transition.
 * Pause freezes, so live workers never block it; resume, revise, and close
 * must reconcile first.
 */
export const workerBlocksTransition = (
  transition: "pause" | "resume" | "revise" | "close",
  state: WorkerState,
): boolean => (transition === "pause" ? false : isUncertainWorker(state));

/**
 * A worker may be continued in its own session only while it holds live
 * state: a running process, or uncommitted changes in its worktree. A worker
 * that reported and is clean is continued by a fresh worker on the same
 * slice. An unreadable worktree counts as no live state.
 */
export const holdsLiveState = (state: WorkerState, dirty: boolean | null): boolean =>
  state === "running" || dirty === true;
