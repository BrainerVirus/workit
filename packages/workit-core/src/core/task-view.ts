// The read side of a task operation: the context guards, the task view and the
// compact per-turn context. Hooks import this, not task-engine.ts, so a hook
// bundle that only reads task context carries none of the recording engine.
import { realpathSync } from "node:fs";
import {
  failure,
  success,
  type Candidate,
  type Capability,
  type Caller,
  type Constraint,
  type Entry,
  type Result,
  type TaskRecord,
  type TaskView,
  type Utc,
  type Worker,
} from "./task-contract";
import { checkoutRootOf } from "../store/paths";
import { sameDirectoryIdentity, type TaskStore } from "./task-store";
import { compactTaskContext, type InheritedDecisions } from "./task-context";
import type { NativeWorkerVerifier } from "./workers";
import {
  captureCandidate,
  evaluateEvidence,
  evaluateRequirements,
  signalFreshness,
  treeFreshness,
  type CandidateEnvironment,
  type Freshness,
} from "./task-evaluation";

export type OperationContext = {
  root: string;
  caller: Caller;
  /** Whether the host supplied a trusted per-session caller identity. */
  callerAttested?: boolean;
  provenanceKind?: "host_observed" | "agent_reported";
  capabilities: Capability[];
  constraints: Constraint[];
  now: Utc | (() => Utc);
  nativeWorker?: NativeWorkerVerifier;
  workerId?: string | null;
  /** A child session with no worker record: it may only read the bounded task summary. */
  readOnlyChild?: boolean;
};

export const environment = (): CandidateEnvironment => [];

export const sameSession = (value: unknown, context: OperationContext): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as any).kind === "host" &&
  (value as any).host === context.caller.host &&
  (value as any).handle === context.caller.actor;

export function contextRootError(store: TaskStore, context: OperationContext): Result<null> {
  try {
    // The same checkout: any directory inside it resolves to its top level.
    realpathSync(context.root);
    const root = checkoutRootOf(context.root);
    if (root !== store.root && !sameDirectoryIdentity(root, store.root))
      return failure("invalid_input", "operation context root does not match the task store root");
  } catch {
    return failure("invalid_input", "operation context root cannot be resolved");
  }
  return success(null, null, null);
}

export function helperEntry(
  task: TaskRecord,
  context: OperationContext,
  requireSession = false,
  requireActive = false,
): Result<Entry<Worker>> {
  const workerId = context.workerId ?? null;
  if (workerId === null) return failure("permission_denied", "operation is lead-only");
  const worker = task.workers.find((entry) => entry.id === workerId);
  if (!worker) return failure("permission_denied", "worker is not assigned to this task");
  if (worker.data.session && !sameSession(worker.data.session, context))
    return failure("permission_denied", "worker session does not match the caller");
  if (requireSession && (!worker.data.session || !sameSession(worker.data.session, context)))
    return failure("permission_denied", "worker session has not been observed");
  if (requireActive && worker.data.state !== "running")
    return failure("permission_denied", "worker is not active");
  return success(null, null, worker);
}

export function helperTaskGuard(
  task: TaskRecord,
  context: OperationContext,
  allowRead = false,
): Result<null> {
  if ((context.workerId ?? null) === null) return success(null, null, null);
  const worker = helperEntry(task, context);
  if (!worker.ok) return worker;
  return allowRead
    ? success(null, null, null)
    : failure("permission_denied", "helpers cannot control task lifecycle or scope");
}

export function taskView(
  store: TaskStore,
  context: OperationContext,
  task: TaskRecord,
  capture = true,
  freshness: Freshness = treeFreshness(store.root),
): Result<TaskView> {
  const workspace = store.readWorkspace();
  if (!workspace.ok) return workspace;
  if (!workspace.data) return failure("not_found", "workspace not found");
  const historical = task.status === "closed" ? task.candidates.at(-1) : undefined;
  const current = historical
    ? success(null, null, historical)
    : capture
      ? captureCandidate(store.root, task.intent.data.scope, environment())
      : success<Candidate | null>(null, null, task.candidates.at(-1) ?? null);
  if (!current.ok) return current;
  const evaluationWorkspace = workspace.data;
  const tree = freshness;
  const requirements = evaluateRequirements(
    task,
    evaluationWorkspace,
    context.capabilities,
    current.data,
    store.root,
    context.caller,
    tree,
  );
  return success(task.revision, workspace.data.revision, {
    task,
    workspace: evaluationWorkspace,
    capabilities: context.capabilities,
    requirements,
    evidence: evaluateEvidence(task, current.data, tree),
  });
}

/**
 * Compact task context for per-turn host injection. Unlike `inspect`
 * view:"full", it never captures a candidate: evidence and requirements are
 * judged against the last recorded candidate, and live staleness is
 * detected by evidence, close, resume, and full inspection, which capture.
 */
export function compactContext(
  store: TaskStore,
  context: OperationContext,
  taskId: string | null,
  freshness?: Freshness,
  /** The base branch's task (TaskStore.originTaskEntry), whose decisions are inherited. */
  origin: { origin: string; taskId: string } | null = null,
): Result<string> {
  const root = contextRootError(store, context);
  if (!root.ok) return root;
  const base = origin && store.readStoreTask(origin.taskId);
  const inherited: InheritedDecisions | null =
    base?.ok && base.data
      ? {
          origin: origin!.origin,
          taskId: base.data.id,
          // A revoked decision no longer applies to anything cut from the base.
          decisions: base.data.decisions.filter((entry) => entry.data.revoked === null),
        }
      : null;
  // No task of its own yet: only what the branch inherits.
  if (taskId === null)
    return success(
      null,
      null,
      inherited?.decisions.length ? compactTaskContext(null, inherited) : "",
    );
  const task = store.readTask(taskId);
  if (!task.ok) return task;
  const helper = helperTaskGuard(task.data, context, true);
  if (!helper.ok) return helper;
  // Per-turn path: the cheap worktree signal, never the object-writing tree hash.
  const view = taskView(store, context, task.data, false, freshness ?? signalFreshness(store.root));
  if (!view.ok) return view;
  return success(view.revision, view.workspaceRevision, compactTaskContext(view.data, inherited));
}
