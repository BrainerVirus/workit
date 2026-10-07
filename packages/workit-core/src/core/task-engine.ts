import { realpathSync } from "node:fs";
import {
  CHECK_OBSERVATION_PATH,
  POLICY_VERSION,
  canonicalJson,
  checkObservationSchema,
  failure,
  decisionDigest,
  exportBundleSchema,
  decisionSchema,
  evidenceSchema,
  findingSchema,
  intentSchema,
  judgmentSchema,
  legacyAssessmentSchema,
  newId,
  parseOperation,
  rewriteRecordRefs,
  success,
  type Candidate,
  type Capability,
  type Caller,
  type CheckObservation,
  type Constraint,
  type Decision,
  type Entry,
  type Evidence,
  type ExportBundle,
  type Finding,
  type Judgment,
  type Policy,
  provenanceSchema,
  type Ref,
  type Result,
  type Scope,
  type TaskRecord,
  type TaskListItem,
  type TaskSummary,
  type TaskView,
  type Utc,
  type Provenance,
  type Worker,
  type OperationFamily,
  type WorkspaceRecord,
  taskRecordSchema,
  scopeCovers as bindingCovers,
} from "./task-contract";
import { diffPolicy, resolvePolicy } from "./policy-resolver";
import { normalizeOperationInput } from "./operation-input";
import { latestJudgment } from "./policy/derive";
import {
  givenReason,
  liftedBlockers,
  normalizeJudgment,
  ownLiftedBlockers,
} from "./policy/judgment";
import { appendObserved } from "../ledger";
import { currentBranch, headSha } from "../git/rev";
import { resolveAutonomy, type VerificationMode } from "../autonomy";

import { sameDirectoryIdentity, TaskStore } from "./task-store";
import { checkoutRootOf } from "../store/paths";
import { defaultLockTimeout } from "./store-lock";
import {
  compactTaskContext,
  exportDigest,
  reconcileResume as reconcileResumeContext,
  type ResumeReconciliation,
} from "./task-context";
import {
  isUncertainWorker,
  workerBlocksTransition,
  type NativeWorkerObservation,
  type NativeWorkerVerification,
  type NativeWorkerVerifier,
} from "./workers";
import {
  captureCandidate,
  checkPin,
  signalFreshness,
  treeFreshness,
  type Freshness,
  evaluateClosure,
  evaluateEvidence,
  evaluateRequirements,
  findingVerificationPasses,
  resolveBinding,
  verifyDecisionContentAtRoot,
  type CandidateEnvironment,
} from "./task-evaluation";

/** The user-config verification mode for `root`; `self` when it cannot be read. */
const workspaceVerification = (root: string): VerificationMode => {
  try {
    return resolveAutonomy(root).verification;
  } catch {
    return "self";
  }
};

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
};

export type ObserveCheckRequest = {
  taskId: string;
  /** Omit to retry over concurrent writers (S2b); a value is strict compare-and-swap. */
  expectedRevision?: string;
  observation: CheckObservation;
};

const provenance = (
  context: OperationContext,
  kind: "host_observed" | "agent_reported" = context.provenanceKind ?? "host_observed",
) => ({
  kind,
  host: context.caller.host,
  session: { kind: "host" as const, host: context.caller.host, handle: context.caller.actor },
  workerId: context.workerId ?? null,
});
const environment = (): CandidateEnvironment => [];
const sameSession = (value: unknown, context: OperationContext): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as any).kind === "host" &&
  (value as any).host === context.caller.host &&
  (value as any).handle === context.caller.actor;

type WorkerBinding = {
  owner: object;
  store: TaskStore;
  root: string;
  caller: Caller;
};
type WorkerAuthority = {
  taskId: string;
  workspaceId: string;
  workerId: string;
  expectedRevision: string;
  expectedWorkspaceRevision: string;
  state: NativeWorkerObservation["state"];
  session: NativeWorkerObservation["session"];
  report: NativeWorkerObservation["report"] | null;
  provenance: Provenance;
  owner: object;
  store: TaskStore;
  root: string;
  caller: Caller;
};
type VerifiedWorker = object;
const verifiedWorkers = new WeakMap<object, WorkerAuthority>();

const sameValue = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const validNativeProvenance = (
  value: unknown,
  caller: Caller,
  expected: Pick<NativeWorkerObservation, "workerId" | "session">,
): value is Provenance => {
  if (!provenanceSchema.safeParse(value).success) return false;
  const observed = value as Provenance;
  return (
    observed.kind === "host_observed" &&
    observed.host === caller.host &&
    observed.workerId === expected.workerId &&
    sameValue(observed.session, expected.session)
  );
};

const verifyNativeWorker = (
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
  if (!result.ok || !validNativeProvenance(result.data, input.caller, expected))
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
    report: expected.report ?? null,
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
    !sameValue(value.caller, binding.caller) ||
    value.taskId !== expected.taskId ||
    value.workerId !== expected.workerId ||
    value.expectedRevision !== expected.expectedRevision ||
    value.expectedWorkspaceRevision !== expected.expectedWorkspaceRevision ||
    value.state !== expected.state ||
    !sameValue(value.session, expected.session) ||
    !sameValue(value.report, expected.report ?? null)
  )
    return null;
  return value;
};

type ObserveWorkerLifecycleInput = NativeWorkerObservation & {
  store: TaskStore;
  authority: VerifiedWorker;
  authorityOwner: object;
  caller: Caller;
  now?: Utc;
};

const applyWorkerLifecycle = (input: ObserveWorkerLifecycleInput): Result<Entry<Worker>> => {
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
  if (!task.ok) return task;
  const workspace = input.store.readWorkspace();
  if (!workspace.ok) return workspace;
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
  // Compare-and-swap first: a stale observation (another process launched
  // and observed this worker meanwhile) must not pass as a no-op below.
  if (input.expectedRevision !== task.data.revision)
    return failure("revision_conflict", "worker observation is stale; re-read the task", {
      expectedRevision: input.expectedRevision,
      actualRevision: task.data.revision,
    });
  if (input.report && input.state !== "stopped")
    return failure("invalid_input", "worker reports require a stopped worker");
  if (
    (input.state === "running" || input.state === "cancelling" || input.state === "stopped") &&
    !input.session
  )
    return failure("invalid_input", "running worker observations require a session");
  if (entry.data.session && !sameValue(entry.data.session, input.session))
    return failure("permission_denied", "worker session does not match its assignment");
  // `unknown` from `assigned` records a launch whose outcome was never
  // observed (its launcher died); the lead must cancel before a relaunch.
  if (
    entry.data.state === "assigned" &&
    input.state !== "running" &&
    input.state !== "stopped" &&
    input.state !== "unknown"
  )
    return failure("invalid_transition", "worker has not started");
  if (input.state === "running" && entry.data.state === "stopped")
    return failure("invalid_transition", "stopped worker cannot run again");
  const terminalCancel = entry.data.state === "cancelling" && input.state === "running";
  // The first observation replaces the assigning provenance with the child's,
  // so the assigning coordinator session is kept on the worker: a restarted
  // host still attributes the running child to its coordinator.
  const coordinator =
    entry.data.coordinator ??
    (entry.data.state === "assigned" && entry.provenance.session?.kind === "host"
      ? entry.provenance.session
      : undefined);
  const nextEntry = {
    ...entry,
    recordedAt: input.now ?? entry.recordedAt,
    provenance: authority.provenance,
    data: {
      ...entry.data,
      ...(coordinator ? { coordinator } : {}),
      state: terminalCancel ? ("cancelling" as const) : input.state,
      session: input.session,
      report: entry.data.report ?? input.report ?? null,
    },
  } satisfies Entry<Worker>;
  // A no-op observation (same state, same session)
  // must not rewrite the entry: hosts observe on every session event, and a
  // revision bump per event livelocks worker sessions — each call would
  // invalidate the revision the previous call returned.
  if (
    entry.data.state === nextEntry.data.state &&
    sameValue(entry.data.session, input.session) &&
    sameValue(entry.data.report, nextEntry.data.report)
  )
    return success(task.data.revision, workspace.data.revision, entry);
  const changed = input.store.mutateTaskAndWorkspace({
    taskId: task.data.id,
    expectedRevision: input.expectedRevision,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    now: input.now,
    workspace: (current, mutation) => success(mutation.revision, mutation.revision, current),
    task: (current, mutation) =>
      success(mutation.revision, null, {
        ...current,
        workers: current.workers.map((candidate) =>
          candidate.id === nextEntry.id ? { ...nextEntry, recordedAt: mutation.now } : candidate,
        ),
      }),
  });
  if (!changed.ok) return changed;
  const updated = changed.data.task.workers.find((candidate) => candidate.id === input.workerId);
  return updated
    ? success(changed.data.task.revision, changed.data.workspace.revision, updated)
    : failure("recovery_required", "worker disappeared during lifecycle observation");
};

const refsWithinScope = (refs: Ref[], scope: Scope): boolean =>
  refs.every(
    (ref) =>
      ref.kind !== "file" ||
      bindingCovers(scope, { description: "", paths: [ref.path], exclusions: [] }),
  );

/** Actions that take a taskId; without one they apply to the implicit task. */
const TASK_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  "task.inspect",
  "task.revise",
  "task.progress",
  "task.pause",
  "task.resume",
  "task.close",
  "policy.assess",
  "policy.preview",
  "policy.explain",
  "evidence.record",
  "finding.record",
  "finding.resolve",
  "decision.record",
  "decision.revoke",
  "worker.assign",
  "worker.report",
  "worker.cancel",
  "state.export",
]);
/** Recording actions that create the implicit task on first use. */
const CREATING_ACTIONS: ReadonlySet<string> = new Set([
  "task.revise",
  "task.progress",
  "policy.assess",
  "evidence.record",
  "finding.record",
  "decision.record",
  "worker.assign",
]);
/** Commit attempts for a call whose revisions the engine filled (see retryFilledRevisions). */
const REVISION_RETRY_ATTEMPTS = 8;
const retryPause = new Int32Array(new SharedArrayBuffer(4));
/** Which revisions the caller left for the engine to fill from its own read. */
type FilledRevisions = { task: boolean; workspace: boolean };
const filledRevisions = (request: unknown): FilledRevisions => {
  const value = (typeof request === "object" && request !== null ? request : {}) as {
    expectedRevision?: unknown;
    expectedWorkspaceRevision?: unknown;
  };
  return {
    task: value.expectedRevision === undefined,
    workspace: value.expectedWorkspaceRevision === undefined,
  };
};
/**
 * A store compare-and-swap rejection (it carries the actual revision) on a
 * revision the engine filled. A conflict on a caller-supplied revision, or a
 * semantic conflict such as a changed import source, is never retried.
 */
const filledConflict = (result: Result<unknown>, filled: FilledRevisions): boolean =>
  !result.ok &&
  result.code === "revision_conflict" &&
  (("actualRevision" in result.details && filled.task) ||
    ("actualWorkspaceRevision" in result.details && filled.workspace));
/**
 * Re-run `run` while it loses a compare-and-swap race on an engine-filled
 * revision. Each attempt commits at most once and a CAS rejection commits
 * nothing, so a success is applied exactly once. Attempts stop at
 * REVISION_RETRY_ATTEMPTS or once the lock budget has elapsed — so blocking
 * stays within about twice that budget — and end as retryable busy.
 */
const retryFilledRevisions = <T>(filled: FilledRevisions, run: () => Result<T>): Result<T> => {
  if (!filled.task && !filled.workspace) return run();
  let result = run();
  // The deadline starts after the first attempt, so a slow first lock wait
  // still leaves at least one retry.
  const deadline = Date.now() + defaultLockTimeout();
  for (let attempt = 1; filledConflict(result, filled); attempt += 1) {
    if (attempt >= REVISION_RETRY_ATTEMPTS || Date.now() >= deadline)
      return failure("busy", "records kept changing under concurrent writers; retry the call");
    // Jittered backoff de-synchronizes writers that lost the same race.
    Atomics.wait(retryPause, 0, 0, Math.floor(Math.random() * 4 * attempt) + 1);
    result = run();
  }
  return result;
};

const trustedNow = (context: OperationContext): Utc =>
  typeof context.now === "function" ? context.now() : context.now;

const mapRef = (ref: Ref, ids: Map<string, string>): Ref => {
  if (ref.kind !== "record") return ref;
  return { ...ref, id: ids.get(ref.id) ?? ref.id };
};

const portableRef = (ref: Ref | null): Ref | null =>
  ref && (ref.kind === "file" || ref.kind === "record") ? ref : null;
const importedProvenance = (context: OperationContext): Provenance => ({
  kind: "imported",
  host: context.caller.host,
  session: null,
  workerId: null,
});

const portableTask = (task: TaskRecord): TaskRecord => {
  // Schema-driven ref stripping: every Ref anywhere in the record is mapped
  // by shape (arrays drop unportable refs, nullable fields null them), so a
  // new ref-bearing field can never silently leak across checkouts.
  const stripped = rewriteRecordRefs(task, taskRecordSchema, portableRef);
  if (typeof stripped !== "object" || stripped === null || Array.isArray(stripped))
    throw new TypeError("portable task rewrite produced a non-record");
  const clone = structuredClone(stripped) as TaskRecord;
  // Candidate metadata can contain environment-derived paths and digests. The destination
  // must recapture its own candidate instead of receiving source checkout material.
  clone.candidates = [];
  return clone;
};

const importedTask = (
  source: TaskRecord,
  bundle: ExportBundle,
  destinationWorkspaceId: string,
  context: OperationContext,
  timestamp: Utc,
): TaskRecord => {
  const ids = new Map<string, string>();
  const allocate = (id: string) => {
    const existing = ids.get(id);
    if (existing) return existing;
    const value = newId();
    ids.set(id, value);
    return value;
  };
  for (const entry of [
    source.intent,
    ...source.assessments,
    ...(source.judgments ?? []),
    ...source.evidence,
    ...source.decisions,
    ...source.findings,
    ...source.workers,
  ])
    allocate(entry.id);
  const fresh = (id: string) => allocate(id);
  const imported = importedProvenance(context);
  const remap = (ref: Ref): Ref | null => mapRef(ref, ids);
  const intent = {
    ...source.intent,
    id: fresh(source.intent.id),
    recordedAt: timestamp,
    provenance: imported,
    data: rewriteRecordRefs(source.intent.data, intentSchema, remap) as typeof source.intent.data,
  };
  const assessments = source.assessments.map((entry) => {
    const data = entry.data;
    return {
      ...entry,
      id: fresh(entry.id),
      recordedAt: timestamp,
      provenance: imported,
      data: rewriteRecordRefs(data, legacyAssessmentSchema, remap) as typeof data,
    };
  });
  const judgments = source.judgments?.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance: imported,
    data: rewriteRecordRefs(entry.data, judgmentSchema, remap) as typeof entry.data,
  }));
  const evidence = source.evidence.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance: imported,
    data: rewriteRecordRefs(entry.data, evidenceSchema, remap) as typeof entry.data,
  }));
  const decisions = source.decisions.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance: imported,
  }));
  const findings = source.findings.map((entry) => {
    const data = rewriteRecordRefs(entry.data, findingSchema, remap) as typeof entry.data;
    return {
      ...entry,
      id: fresh(entry.id),
      recordedAt: timestamp,
      provenance: imported,
      data: {
        ...data,
        resolution: data.resolution
          ? {
              ...data.resolution,
              evidenceIds: data.resolution.evidenceIds.map((id) => ids.get(id) ?? id),
              decisionIds: data.resolution.decisionIds.map((id) => ids.get(id) ?? id),
            }
          : null,
      },
    };
  });
  const workers = source.workers.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance: imported,
    data: {
      ...entry.data,
      state: "stopped" as const,
      session: null,
      assignment: {
        ...entry.data.assignment,
        decisionIds: entry.data.assignment.decisionIds.map((id) => ids.get(id) ?? id),
      },
      report: entry.data.report
        ? {
            ...entry.data.report,
            evidenceIds: entry.data.report.evidenceIds.map((id) => ids.get(id) ?? id),
            findingIds: entry.data.report.findingIds.map((id) => ids.get(id) ?? id),
          }
        : null,
    },
  }));
  const task: TaskRecord = {
    ...source,
    id: newId(),
    workspaceId: destinationWorkspaceId,
    revision: newId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    origin: {
      workspaceId: bundle.sourceWorkspaceId,
      taskId: bundle.task.id,
      exportDigest: bundle.digest,
    },
    intent,
    constraints: context.constraints,
    status: "paused",
    closure: null,
    assessments,
    ...(judgments ? { judgments } : {}),
    evidence,
    decisions: decisions.map((entry) => {
      const data = rewriteRecordRefs(entry.data, decisionSchema, remap) as typeof entry.data;
      return {
        ...entry,
        data: {
          ...data,
          binding: {
            ...data.binding,
            taskId: "",
            workspaceId: destinationWorkspaceId,
          },
        },
      };
    }),
    findings,
    workers,
    candidates: [],
    policy: null,
    progress: {
      ...source.progress,
      blockers: source.progress.blockers.map((blocker) => ({
        ...blocker,
        refs: blocker.refs.map((ref) => mapRef(ref, ids)),
      })),
    },
  };
  task.decisions = task.decisions.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      binding: { ...entry.data.binding, taskId: task.id },
      digest: decisionDigest(entry.data),
    },
  }));
  return task;
};

export class WorkitCore {
  private readonly authorityOwner = {};

  constructor(
    private readonly store: TaskStore,
    private readonly context: OperationContext,
  ) {}

  /** Optional host actions are coordinator-owned; supervised worker contexts cannot invoke them. */
  public isDelegatedCaller(): boolean {
    return this.context.workerId !== null && this.context.workerId !== undefined;
  }

  private contextRootError(): Result<null> {
    try {
      // The same checkout: any directory inside it resolves to its top level.
      realpathSync(this.context.root);
      const root = checkoutRootOf(this.context.root);
      if (root !== this.store.root && !sameDirectoryIdentity(root, this.store.root))
        return failure(
          "invalid_input",
          "operation context root does not match the task store root",
        );
    } catch {
      return failure("invalid_input", "operation context root cannot be resolved");
    }
    return success(null, null, null);
  }

  /**
   * Omitted revisions default to the records read for this call; explicit values
   * stay CAS-enforced downstream. Call after loading task/workspace records.
   */
  private fillRevisions(
    input: { expectedRevision?: string; expectedWorkspaceRevision?: string | null },
    task?: { revision: string },
    workspace?: { revision: string } | null,
  ): void {
    if (input.expectedRevision === undefined && task) input.expectedRevision = task.revision;
    if (input.expectedWorkspaceRevision === undefined)
      input.expectedWorkspaceRevision = workspace ? workspace.revision : null;
  }

  /**
   * A revision the caller omitted is not a compare-and-swap request: when
   * another writer commits between this call's read and its locked commit,
   * re-run the whole operation — fresh read, policy, requirement and
   * candidate checks, then commit — so a re-check that now fails returns that
   * failure. Caller-supplied revisions stay strict CAS.
   */
  private retryOmittedRevisions<T>(request: unknown, run: () => Result<T>): Result<T> {
    return retryFilledRevisions(filledRevisions(request), run);
  }

  /**
   * A task-scoped request without a `taskId` applies to the implicit task of
   * this checkout's branch (D3). Recording actions create that task on first
   * use; reads and lifecycle actions only look it up. Helpers never create.
   */
  private implicitTask(family: OperationFamily, raw: unknown): Result<unknown> {
    // Flat tool inputs become the canonical request first (S17).
    const request = normalizeOperationInput(family, raw, this.context.caller.host);
    if (typeof request !== "object" || request === null || Array.isArray(request))
      return success(null, null, request);
    const value = request as { action?: unknown; taskId?: unknown };
    if (value.taskId !== undefined || typeof value.action !== "string")
      return success(null, null, request);
    const action = `${family}.${value.action}`;
    if (!TASK_SCOPED_ACTIONS.has(action)) return success(null, null, request);
    const root = this.contextRootError();
    if (!root.ok) return root;
    const create = CREATING_ACTIONS.has(action) && (this.context.workerId ?? null) === null;
    const found = this.store.implicitTask({
      provenance: provenance(this.context),
      create,
      now: trustedNow(this.context),
    });
    if (!found.ok) return found;
    if (!found.data)
      return failure(
        "not_found",
        'no task for this branch yet; pass taskId, or record something first (`workit task start "<objective>"`, a note, a check) to create it',
      );
    return success(null, null, { ...request, taskId: found.data.task.id });
  }

  private helperEntry(
    task: TaskRecord,
    requireSession = false,
    requireActive = false,
  ): Result<Entry<import("./task-contract").Worker>> {
    const workerId = this.context.workerId ?? null;
    if (workerId === null) return failure("permission_denied", "operation is lead-only");
    const worker = task.workers.find((entry) => entry.id === workerId);
    if (!worker) return failure("permission_denied", "worker is not assigned to this task");
    if (worker.data.session && !sameSession(worker.data.session, this.context))
      return failure("permission_denied", "worker session does not match the caller");
    if (requireSession && (!worker.data.session || !sameSession(worker.data.session, this.context)))
      return failure("permission_denied", "worker session has not been observed");
    if (requireActive && worker.data.state !== "running")
      return failure("permission_denied", "worker is not active");
    return success(null, null, worker);
  }

  private helperTaskGuard(task: TaskRecord, allowRead = false): Result<null> {
    if ((this.context.workerId ?? null) === null) return success(null, null, null);
    const worker = this.helperEntry(task);
    if (!worker.ok) return worker;
    return allowRead
      ? success(null, null, null)
      : failure("permission_denied", "helpers cannot control task lifecycle or scope");
  }

  private activeWorkerBlocker(task: TaskRecord) {
    if (task.workers.some((entry) => workerBlocksTransition("close", entry.data.state)))
      return failure("recovery_required", "worker state requires reconciliation");
    return null;
  }

  state(request: unknown): Result<ExportBundle | TaskSummary | TaskRecord | WorkspaceRecord> {
    const resolved = this.implicitTask("state", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return (value as { action?: unknown } | null)?.action === "import"
      ? this.retryOmittedRevisions(value, () => this.stateOnce(value))
      : this.stateOnce(value);
  }

  private stateOnce(
    request: unknown,
  ): Result<ExportBundle | TaskSummary | TaskRecord | WorkspaceRecord> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot control task state");
    const parsed = parseOperation("state", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    if (input.action === "export") {
      const task = this.store.readTask(input.taskId);
      if (!task.ok) return task;
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace;
      if (!workspace.data) return failure("not_found", "workspace not found");
      const portable = taskRecordSchema.safeParse(portableTask(task.data));
      if (!portable.success)
        return failure("storage_error", "portable task is invalid after sanitization");
      const bundle = {
        schemaVersion: 1 as const,
        exportedAt: trustedNow(this.context),
        sourceWorkspaceId: workspace.data.id,
        task: portable.data,
      };
      const checked = exportBundleSchema.safeParse({
        ...bundle,
        digest: exportDigest(bundle),
      });
      if (!checked.success) return failure("storage_error", "portable export bundle is invalid");
      return success(task.data.revision, workspace.data.revision, checked.data);
    }
    if (input.action === "import") {
      const checked = exportBundleSchema.safeParse(input.bundle);
      if (!checked.success) return failure("invalid_input", "export bundle is invalid");
      const bundle = checked.data;
      if (
        bundle.sourceWorkspaceId !== bundle.task.workspaceId ||
        exportDigest({
          schemaVersion: bundle.schemaVersion,
          exportedAt: bundle.exportedAt,
          sourceWorkspaceId: bundle.sourceWorkspaceId,
          task: bundle.task,
        }) !== bundle.digest
      )
        return failure("invalid_input", "export bundle digest is invalid");
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace;
      const destinationWorkspaceId = workspace.data?.id ?? newId();
      this.fillRevisions(input, undefined, workspace.data ?? null);
      const timestamp = trustedNow(this.context);
      const task = importedTask(
        bundle.task,
        bundle,
        destinationWorkspaceId,
        this.context,
        timestamp,
      );
      const imported = this.store.importTask({
        task,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        workspaceId: destinationWorkspaceId,
        now: timestamp,
      });
      if (!imported.ok) return imported;
      return this.summary(imported.data);
    }
    return failure("invalid_input", "unknown state action");
  }

  task(request: unknown): Result<TaskSummary | TaskListItem[] | TaskView> {
    const resolved = this.implicitTask("task", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return this.retryOmittedRevisions(value, () => this.taskOnce(value));
  }

  private taskOnce(request: unknown): Result<TaskSummary | TaskListItem[] | TaskView> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("task", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    if ((this.context.workerId ?? null) !== null) {
      if (input.action !== "inspect" && input.action !== "list")
        return failure("permission_denied", "helpers cannot control task lifecycle or scope");
    }
    switch (input.action) {
      case "start": {
        if (input.expectedWorkspaceRevision === undefined) {
          const workspace = this.store.readWorkspace();
          if (!workspace.ok) return workspace;
          input.expectedWorkspaceRevision = workspace.data?.revision ?? null;
        }
        const created = this.store.create({
          intent: input.intent,
          provenance: provenance(this.context),
          expectedWorkspaceRevision: input.expectedWorkspaceRevision,
          now: trustedNow(this.context),
        });
        if (!created.ok) return created;
        return this.summary(created.data);
      }
      case "list": {
        const listed = this.store.listTasks();
        if (!listed.ok) return listed;
        const status = input.status ?? "open";
        const limit = input.limit ?? 20;
        const query = input.query?.toLowerCase().split(/\s+/);
        const selected = listed.data
          .filter((task) =>
            status === "all"
              ? true
              : status === "closed"
                ? task.status === "closed"
                : task.status !== "closed",
          )
          .filter(
            (task) =>
              !query ||
              query.every((term: string) =>
                JSON.stringify({
                  id: task.id,
                  workspaceId: task.workspaceId,
                  origin: task.origin,
                  createdAt: task.createdAt,
                  updatedAt: task.updatedAt,
                  source: task.intent.provenance,
                  objective: task.intent.data.objective,
                  progress: task.progress,
                  decisions: task.decisions.map(({ data }) => data),
                })
                  .toLowerCase()
                  .includes(term),
              ),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit);
        if (selected.length === 0) return success(null, null, []);
        const workspace = this.store.readWorkspace();
        if (!workspace.ok) return workspace;
        if (!workspace.data) return failure("not_found", "workspace not found");
        const tasks = selected.map((task): TaskListItem => ({
          id: task.id,
          revision: task.revision,
          workspaceRevision: workspace.data!.revision,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          runtime: task.runtime ?? null,
          objective: task.intent.data.objective,
          status: task.status,
          closure: task.closure,
          progress: task.progress,
          source: {
            host: task.intent.provenance.host,
            kind: task.intent.provenance.kind,
          },
        }));
        return success(null, null, tasks);
      }
      case "inspect": {
        const task = this.store.readTask(input.taskId);
        if (!task.ok) return task;
        const helper = this.helperTaskGuard(task.data, true);
        if (!helper.ok) return helper;
        if ((input.view ?? "summary") === "summary") return this.summary(task.data);
        return this.view(task.data);
      }
      case "pause":
        return this.transition(input, "paused");
      case "resume":
        return this.transition(input, "active");
      case "progress":
        return this.progress(input);
      case "revise":
        return this.revise(input);
      case "close":
        return this.close(input);
      default:
        return failure("invalid_transition", `task action ${input.action} is not implemented`);
    }
  }

  policy(request: unknown): Result<Policy | null> {
    const resolved = this.implicitTask("policy", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return this.retryOmittedRevisions(value, () => this.policyOnce(value));
  }

  private policyOnce(request: unknown): Result<Policy | null> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("policy", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    if (input.action === "explain") return success(task.data.revision, null, task.data.policy);
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot change task requirements");
    this.fillRevisions(input, task.data);
    const previous = latestJudgment(task.data);
    const judged = normalizeJudgment(input.judgment, previous);
    if (!judged.ok) return judged;
    const judgment = judged.data.judgment;
    const resolved = this.resolve(task.data, judgment);
    if (!resolved.ok) return resolved;
    if (input.action === "preview") return success(null, null, resolved.data);
    if (input.action !== "assess")
      return failure("invalid_transition", "unsupported policy action");
    // M6: a session lifting a before-write blocker it judged itself gives a
    // reason; every assess is recorded in the ledger below either way.
    const lifted = liftedBlockers(previous, judgment);
    const why = givenReason(input.judgment);
    const own = ownLiftedBlockers(task.data.judgments ?? [], lifted, this.context.caller.actor);
    if (own.length && !why)
      return failure(
        "invalid_input",
        `this session judged ${own.join(" and ")} true on this task; lifting it needs a reason: re-run with --why "<reason>" (recorded in the ledger)`,
      );
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, mutation) => {
        if (current.status === "closed")
          return failure("invalid_transition", "closed task cannot be assessed");
        const nextChange = diffPolicy(
          current.policy,
          resolved.data,
          "policy reassessed",
          mutation.now,
        );
        const entry = {
          id: newId(),
          recordedAt: mutation.now,
          provenance: provenance(this.context),
          data: judgment,
        };
        const next = {
          ...current,
          constraints: this.context.constraints,
          judgments: [...(current.judgments ?? []), entry],
          // Older readers would drop judgments on rewrite: they fail closed instead.
          critical: [...new Set([...(current.critical ?? []), "judgments"])],
          policy: resolved.data,
          policyChanges: nextChange
            ? [...current.policyChanges, nextChange]
            : current.policyChanges,
        };
        return success(mutation.revision, null, next);
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed;
    this.recordJudged(task.data.id, input.judgment, judgment, changed.data.policy, lifted, why);
    return success(changed.data.revision, null, changed.data.policy);
  }

  /**
   * Make a judge call auditable (M6): who judged, what was sent, what it
   * resolved to and which blockers it lifted. Best effort: the assessment
   * already stands in the task store, and an unwritable ledger must not undo it.
   */
  private recordJudged(
    taskId: string,
    input: unknown,
    judgment: Judgment,
    policy: Policy | null,
    lifted: readonly string[],
    why: string | null,
  ): void {
    const root = this.store.root;
    const branch = currentBranch(root);
    appendObserved(root, {
      type: "policy.judged",
      actor: {
        host: this.context.caller.host,
        session: this.context.caller.actor,
        agentId: this.context.workerId ?? null,
      },
      branch,
      head: branch ? headSha(root) : null,
      taskId,
      input: input ?? {},
      judgment,
      requirements: (policy?.requirements ?? []).map((requirement) => requirement.ruleId),
      lifted,
      why,
    });
  }

  evidence(request: unknown): Result<Entry<Evidence>> {
    const resolved = this.implicitTask("evidence", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return this.retryOmittedRevisions(value, () => this.evidenceOnce(value));
  }

  private evidenceOnce(request: unknown): Result<Entry<Evidence>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("evidence", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot record evidence");
    this.fillRevisions(input, task.data);
    const helper =
      (this.context.workerId ?? null) === null ? null : this.helperEntry(task.data, true, true);
    if (helper && !helper.ok) return helper;
    const evidence = input.evidence as Evidence;
    if (
      (evidence.result === "missing" || evidence.result === "skipped") &&
      !evidence.summary.trim()
    )
      return failure("invalid_input", "missing or skipped evidence requires a reason");
    if (evidence.kind === "review") {
      if (!sameSession(evidence.reviewContext, this.context))
        return failure("invalid_input", "review context must match the trusted caller session");
    }
    const currentCandidate = captureCandidate(
      this.store.root,
      task.data.intent.data.scope,
      environment(),
    );
    if (!currentCandidate.ok) return currentCandidate;
    // Resolve the binding first (explicit IDs, else the worker pin, else the
    // current candidate), then validate and pin-check the resolved values —
    // never the caller's possibly-empty fields. The input itself is untouched.
    const pin = helper && helper.ok ? helper.data.data.assignment.candidateId : null;
    const bound = resolveBinding(evidence, pin, currentCandidate.data.id);
    if (helper?.ok) {
      const assignment = helper.data.data.assignment;
      if (
        evidence.requirementIds.some((id: string) => !assignment.requirementIds.includes(id)) ||
        !checkPin(assignment, bound.beforeCandidateId, bound.candidateId) ||
        !refsWithinScope(evidence.refs, assignment.scope) ||
        !refsWithinScope(evidence.refs, task.data.intent.data.scope)
      )
        return failure("permission_denied", "evidence is outside the worker assignment");
    }
    const knownCandidates = new Set(task.data.candidates.map((candidate) => candidate.id));
    for (const candidateId of [bound.beforeCandidateId, bound.candidateId]) {
      if (
        candidateId &&
        candidateId !== currentCandidate.data.id &&
        !knownCandidates.has(candidateId)
      )
        return failure("invalid_input", "evidence candidate is not a captured candidate");
    }
    const boundEvidence = { ...evidence, ...bound };
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, mutation) => {
        const candidates = current.candidates.some((item) => item.id === currentCandidate.data.id)
          ? current.candidates
          : [...current.candidates, currentCandidate.data];
        const entry = {
          id: newId(),
          recordedAt: mutation.now,
          provenance: provenance(this.context, "agent_reported"),
          data: boundEvidence,
        };
        return success(mutation.revision, null, {
          ...current,
          candidates,
          evidence: [...current.evidence, entry],
          findings: current.findings.map((finding) => {
            if (finding.data.disposition === "open" || boundEvidence.result === "skipped")
              return finding;
            if (finding.data.disposition !== "fixed") return finding;
            // A fix stands while its verification still passes on the current
            // tree; it reopens only on lapse or direct contradiction. Judged
            // dispositions never auto-reopen.
            const withEntry = { ...current, candidates, evidence: [...current.evidence, entry] };
            const statuses = new Map(
              evaluateEvidence(
                withEntry,
                currentCandidate.data,
                treeFreshness(this.store.root),
              ).map((item) => [item.evidenceId, item.status]),
            );
            const verified = withEntry.evidence.some((item) =>
              findingVerificationPasses(finding.data.candidateId, {
                kind: item.data.kind,
                candidateId: item.data.candidateId,
                status: statuses.get(item.id) ?? "missing",
              }),
            );
            const contradicted =
              boundEvidence.result === "failed" &&
              finding.data.refs.some((left: Ref) =>
                boundEvidence.refs.some((right: Ref) => sameValue(left, right)),
              );
            return verified && !contradicted
              ? finding
              : { ...finding, data: { ...finding.data, disposition: "open", resolution: null } };
          }),
        });
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed;
    return success(changed.data.revision, null, changed.data.evidence.at(-1)!);
  }

  /**
   * Record a check the CLI itself ran and observed (`workit check`, design
   * §2.1 S9). Host-only, like observeDecision: the caller must be the workit
   * CLI (never a helper), and agents reach evidence only through
   * `evidence.record`, which stays agent_reported and cannot carry an
   * observation. The entry is `host_observed` by `workit_cli`, keyed to the
   * worktree tree in the observation, and the task lists the observation
   * path as critical so an older reader fails closed instead of dropping it.
   * Outside git (no tree key) it is bound to the current candidate instead.
   */
  observeCheck(request: ObserveCheckRequest): Result<Entry<Evidence>> {
    return this.retryOmittedRevisions(request, () => this.observeCheckOnce(request));
  }

  private observeCheckOnce(request: ObserveCheckRequest): Result<Entry<Evidence>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    if (this.context.caller.host !== "workit_cli" || (this.context.workerId ?? null) !== null)
      return failure("permission_denied", "only the workit CLI records observed checks");
    const observation = checkObservationSchema.safeParse(request?.observation);
    if (!observation.success)
      return failure("invalid_input", "check observation is invalid", {
        fields: observation.error.issues.map((issue) => ({
          path: issue.path.join("."),
          reason: issue.message,
        })),
      });
    const task = this.store.readTask(request.taskId);
    if (!task.ok) return task;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot record evidence");
    const observed: CheckObservation = observation.data;
    let candidate: Candidate | null = null;
    if (observed.tree === null) {
      const captured = captureCandidate(
        this.store.root,
        task.data.intent.data.scope,
        environment(),
      );
      if (!captured.ok) return captured;
      candidate = captured.data;
    }
    const label = observed.name ?? observed.argv.join(" ");
    const data: Evidence = {
      kind: "check",
      claim: `workit check ${label}`.slice(0, 500),
      requirementIds: [],
      ...(candidate ? { beforeCandidateId: candidate.id, candidateId: candidate.id } : {}),
      result: observed.exitCode === 0 ? "passed" : "failed",
      summary: `${observed.configured ? "configured" : "ad-hoc"} check exited ${observed.exitCode}${observed.timedOut ? " (timed out)" : ""} in ${observed.durationMs} ms`,
      refs: [],
      exitCode: observed.exitCode,
      reviewContext: null,
      observation: observed,
    };
    const changed = this.store.mutateTask(
      task.data.id,
      request.expectedRevision ?? task.data.revision,
      (current, mutation) => {
        const candidates =
          candidate === null || current.candidates.some((item) => item.id === candidate.id)
            ? current.candidates
            : [...current.candidates, candidate];
        const critical = [...new Set([...(current.critical ?? []), CHECK_OBSERVATION_PATH])];
        return success(mutation.revision, null, {
          ...current,
          critical,
          candidates,
          evidence: [
            ...current.evidence,
            {
              id: newId(),
              recordedAt: mutation.now,
              provenance: provenance(this.context, "host_observed"),
              data,
            },
          ],
        });
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed;
    return success(changed.data.revision, null, changed.data.evidence.at(-1)!);
  }

  decision(request: unknown): Result<Entry<Decision>> {
    const resolved = this.implicitTask("decision", request);
    return resolved.ok ? this.recordDecision(resolved.data) : resolved;
  }

  /**
   * Commit a task mutation whose update re-validates everything it depends on
   * under the lock: a CAS loss on an engine-filled revision re-reads the
   * record, repeats `recheck` against it and retries the commit.
   */
  private commitTask(
    taskId: string,
    expected: string,
    filled: boolean,
    recheck: (fresh: TaskRecord) => Result<unknown>,
    update: Parameters<TaskStore["mutateTask"]>[2],
  ): Result<TaskRecord> {
    let revision = expected;
    let first = true;
    return retryFilledRevisions({ task: filled, workspace: false }, () => {
      if (!first) {
        const fresh = this.store.readTask(taskId);
        if (!fresh.ok) return fresh;
        const checked = recheck(fresh.data);
        if (!checked.ok) return checked;
        revision = fresh.data.revision;
      }
      first = false;
      return this.store.mutateTask(taskId, revision, update, trustedNow(this.context));
    });
  }

  /**
   * A decision is a durable, agent-asserted record (D2, D18). It satisfies
   * `decisions` requirements and accepted limitations; it never authorizes an
   * external effect, so no host attestation is minted or checked.
   */
  private recordDecision(request: unknown): Result<Entry<Decision>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("decision", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    const stated = input.action === "record" && input.response === "stated";
    if (stated && !input.binding?.statedChoice)
      return failure("invalid_input", "stated choices require binding.statedChoice");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot record or revoke decisions");
    const filled = input.expectedRevision === undefined;
    this.fillRevisions(input, task.data);
    if (input.action === "record") {
      if (task.data.status === "closed")
        return failure("invalid_transition", "closed task cannot record a decision");
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace;
      if (!workspace.data) return failure("not_found", "workspace not found");
      // Flat inputs omit the binding ids: a decision binds to where it is recorded.
      const binding = {
        ...input.binding,
        taskId: input.binding.taskId ?? task.data.id,
        workspaceId: input.binding.workspaceId ?? workspace.data.id,
      } as Decision["binding"];
      if (binding.taskId !== task.data.id || binding.workspaceId !== workspace.data.id)
        return failure("invalid_input", "decision task or workspace binding is invalid");
      const content = verifyDecisionContentAtRoot(this.store.root, binding);
      if (!content.ok) return content;
      const knownRequirements = new Set(
        task.data.policy?.requirements.map((item) => item.id) ?? [],
      );
      if (input.requirementIds.some((id: string) => !knownRequirements.has(id)))
        return failure("invalid_input", "decision references an unknown requirement");
      const base = {
        purpose: input.purpose,
        binding,
        response: input.response,
        requirementIds: input.requirementIds,
        revoked: null,
      } satisfies Omit<Decision, "digest">;
      const data: Decision = { ...base, digest: decisionDigest(base) };
      const changed = this.commitTask(
        task.data.id,
        input.expectedRevision,
        filled,
        (fresh) =>
          fresh.status === "closed"
            ? failure("invalid_transition", "closed task cannot record a decision")
            : success(null, null, null),
        (current, mutation) => {
          if (current.status === "closed")
            return failure("invalid_transition", "closed task cannot record a decision");
          const known = new Set(current.policy?.requirements.map((item) => item.id) ?? []);
          if (input.requirementIds.some((id: string) => !known.has(id)))
            return failure("invalid_input", "decision references an unknown requirement");
          const entry: Entry<Decision> = {
            id: newId(),
            recordedAt: mutation.now,
            provenance: provenance(this.context, "agent_reported"),
            data,
          };
          return success(mutation.revision, null, {
            ...current,
            decisions: [...current.decisions, entry],
          });
        },
      );
      if (!changed.ok) return changed;
      return success(changed.data.revision, null, changed.data.decisions.at(-1)!);
    }
    const decision = task.data.decisions.find((entry) => entry.id === input.decisionId);
    if (!decision) return failure("not_found", "decision not found");
    if (!input.reason.trim())
      return failure("invalid_input", "decision revocation requires a reason");
    if (decision.data.revoked) return failure("invalid_transition", "decision is already revoked");
    const changed = this.commitTask(
      task.data.id,
      input.expectedRevision,
      filled,
      () => success(null, null, null),
      (current, mutation) => {
        const entry = current.decisions.find((candidate) => candidate.id === input.decisionId);
        if (!entry) return failure("not_found", "decision not found");
        if (entry.data.revoked) return failure("invalid_transition", "decision is already revoked");
        const data = {
          ...entry.data,
          revoked: { at: mutation.now, reason: input.reason },
        };
        const updated = { ...entry, data };
        return success(mutation.revision, null, {
          ...current,
          decisions: current.decisions.map((candidate) =>
            candidate.id === input.decisionId ? updated : candidate,
          ),
        });
      },
    );
    if (!changed.ok) return changed;
    const entry = changed.data.decisions.find((candidate) => candidate.id === input.decisionId);
    return entry
      ? success(changed.data.revision, null, entry)
      : failure("recovery_required", "decision disappeared");
  }

  finding(request: unknown): Result<Entry<Finding>> {
    const resolved = this.implicitTask("finding", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return this.retryOmittedRevisions(value, () => this.findingOnce(value));
  }

  private findingOnce(request: unknown): Result<Entry<Finding>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("finding", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot mutate findings");
    this.fillRevisions(input, task.data);
    const helper =
      (this.context.workerId ?? null) === null ? null : this.helperEntry(task.data, true, true);
    if (helper && !helper.ok) return helper;
    if (input.action === "record") {
      if (helper?.ok) {
        const assignment = helper.data.data.assignment;
        if (
          !bindingCovers(assignment.scope, input.scope) ||
          !bindingCovers(task.data.intent.data.scope, input.scope) ||
          !checkPin(assignment, null, input.candidateId ?? null) ||
          !refsWithinScope(input.refs, assignment.scope) ||
          !refsWithinScope(input.refs, task.data.intent.data.scope)
        )
          return failure("permission_denied", "finding is outside the worker assignment");
      }
      if (
        input.candidateId &&
        !task.data.candidates.some((candidate) => candidate.id === input.candidateId)
      )
        return failure("invalid_input", "finding candidate is not a captured candidate");
      const changed = this.store.mutateTask(
        task.data.id,
        input.expectedRevision,
        (current, mutation) => {
          const entry: Entry<Finding> = {
            id: newId(),
            recordedAt: mutation.now,
            provenance: provenance(this.context, "agent_reported"),
            data: {
              claim: input.claim,
              consequence: input.consequence,
              scope: input.scope,
              candidateId: input.candidateId ?? null,
              refs: input.refs,
              disposition: "open",
              resolution: null,
            },
          };
          return success(mutation.revision, null, {
            ...current,
            findings: [...current.findings, entry],
          });
        },
        trustedNow(this.context),
      );
      if (!changed.ok) return changed;
      return success(changed.data.revision, null, changed.data.findings.at(-1)!);
    }
    if (helper?.ok) return failure("permission_denied", "helpers cannot resolve findings");
    const finding = task.data.findings.find((entry) => entry.id === input.findingId);
    if (!finding) return failure("not_found", "finding not found");
    if (!input.reason.trim())
      return failure("invalid_input", "finding resolution requires a reason");
    const evidence = task.data.evidence.filter((entry) => input.evidenceIds.includes(entry.id));
    const decisions = task.data.decisions.filter((entry) => input.decisionIds.includes(entry.id));
    if (
      evidence.length !== input.evidenceIds.length ||
      decisions.length !== input.decisionIds.length
    )
      return failure("invalid_input", "finding resolution references an unknown record");
    if (input.disposition === "fixed") {
      const current = captureCandidate(this.store.root, task.data.intent.data.scope, environment());
      if (!current.ok) return current;
      const evaluations = evaluateEvidence(task.data, current.data, treeFreshness(this.store.root));
      const verified = evidence.some((entry) => {
        const evaluation = evaluations.find((item) => item.evidenceId === entry.id);
        return (
          entry.recordedAt >= finding.recordedAt &&
          findingVerificationPasses(finding.data.candidateId, {
            kind: entry.data.kind,
            candidateId: entry.data.candidateId,
            status: evaluation?.status ?? "missing",
          })
        );
      });
      if (!verified)
        return failure("permission_denied", "fixed findings require passing verification evidence");
    }
    if (input.disposition === "dismissed" && evidence.length === 0)
      return failure("permission_denied", "dismissal requires supporting evidence");
    if (input.disposition === "dismissed") {
      const relevant = evidence.every((entry) => {
        if (entry.data.result === "missing" || entry.data.result === "skipped") return false;
        const candidateMatches =
          finding.data.candidateId === null
            ? entry.data.candidateId === null
            : entry.data.candidateId === finding.data.candidateId ||
              entry.data.beforeCandidateId === finding.data.candidateId;
        const referenceMatches = finding.data.refs.some((left) =>
          entry.data.refs.some((right) => sameValue(left, right)),
        );
        return candidateMatches && (referenceMatches || entry.data.claim === finding.data.claim);
      });
      if (!relevant)
        return failure("permission_denied", "dismissal evidence is unrelated to the finding");
    }
    if (input.disposition === "deferred") {
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace;
      if (!workspace.data) return failure("not_found", "workspace not found");
      const allowed = decisions.some(
        (entry) =>
          entry.provenance.kind !== "imported" &&
          entry.data.purpose === "limitation" &&
          entry.data.response === "approved" &&
          entry.data.revoked === null &&
          verifyDecisionContentAtRoot(this.store.root, entry.data.binding).ok &&
          entry.data.binding.taskId === task.data.id &&
          entry.data.binding.workspaceId === workspace.data!.id &&
          bindingCovers(entry.data.binding.scope, finding.data.scope) &&
          entry.data.requirementIds.some((id: string) =>
            task.data.policy?.requirements.some(
              (requirement) => requirement.id === id && requirement.acceptanceAllowed,
            ),
          ),
      );
      if (!allowed)
        return failure(
          "permission_denied",
          "deferred findings require an approved limitation decision that references an acceptanceAllowed requirement and covers the finding scope",
        );
    }
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, mutation) => {
        const existing = current.findings.find((entry) => entry.id === input.findingId);
        if (!existing) return failure("not_found", "finding not found");
        const data =
          input.disposition === "open"
            ? { ...existing.data, disposition: "open" as const, resolution: null }
            : {
                ...existing.data,
                disposition: input.disposition,
                resolution: {
                  reason: input.reason,
                  evidenceIds: input.evidenceIds,
                  decisionIds: input.decisionIds,
                },
              };
        const updated = { ...existing, data };
        return success(mutation.revision, null, {
          ...current,
          findings: current.findings.map((entry) =>
            entry.id === input.findingId ? updated : entry,
          ),
        });
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed;
    const entry = changed.data.findings.find((candidate) => candidate.id === input.findingId);
    return entry
      ? success(changed.data.revision, null, entry)
      : failure("recovery_required", "finding disappeared");
  }

  worker(request: unknown): Result<Entry<Worker>> {
    const resolved = this.implicitTask("worker", request);
    if (!resolved.ok) return resolved;
    const value = resolved.data;
    return this.retryOmittedRevisions(value, () => this.workerOnce(value));
  }

  private workerOnce(request: unknown): Result<Entry<Worker>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const parsed = parseOperation("worker", request);
    if (!parsed.ok) return parsed;
    const input = parsed.data;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    this.fillRevisions(input, task.data, workspace.data);
    const helperId = this.context.workerId ?? null;
    if (input.action === "assign") {
      if (helperId !== null) return failure("permission_denied", "helpers cannot assign workers");
      if (task.data.status !== "active")
        return failure("invalid_transition", "paused or closed tasks cannot assign workers");
      if (!bindingCovers(task.data.intent.data.scope, input.assignment.scope))
        return failure("permission_denied", "worker assignment is outside task scope", {
          fields: [
            {
              path: "assignment.scope",
              reason: `paths ${JSON.stringify(input.assignment.scope.paths)} must be contained by lead paths ${JSON.stringify(task.data.intent.data.scope.paths)}`,
            },
            {
              path: "task.intent.scope",
              reason: `lead paths are ${JSON.stringify(task.data.intent.data.scope.paths)}`,
            },
          ],
        });
      if (
        input.assignment.decisionIds.some(
          (id: string) => !task.data.decisions.some((entry) => entry.id === id),
        )
      )
        return failure("invalid_input", "worker assignment references an unknown decision");
      if (
        input.assignment.requirementIds.some(
          (id: string) =>
            !task.data.policy?.requirements.some((requirement) => requirement.id === id),
        )
      )
        return failure("invalid_input", "worker assignment references an unknown requirement");
      const reviewRequirements = (task.data.policy?.requirements ?? []).filter(
        (requirement) => requirement.dimension === "review",
      );
      if (
        input.assignment.role === "reviewer" &&
        input.assignment.requirementIds.length === 0 &&
        reviewRequirements.length
      )
        return failure(
          "invalid_input",
          "reviewer assignment needs the review requirement ids it will evidence",
          { requirementIds: reviewRequirements.map((requirement) => requirement.id) },
        );
      if (
        input.assignment.candidateId &&
        !task.data.candidates.some((candidate) => candidate.id === input.assignment.candidateId)
      )
        return failure("invalid_input", "worker assignment references an unknown candidate");
      input.assignment.candidateId ??= null;
      const workerId = newId();
      const changed = this.store.mutateTaskAndWorkspace({
        taskId: task.data.id,
        expectedRevision: input.expectedRevision,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        now: trustedNow(this.context),
        workspace: (current, mutation) => success(mutation.revision, mutation.revision, current),
        task: (current, mutation) => {
          const entry: Entry<Worker> = {
            id: workerId,
            recordedAt: mutation.now,
            provenance: provenance(this.context, "agent_reported"),
            data: { assignment: input.assignment, state: "assigned", session: null, report: null },
          };
          return success(mutation.revision, null, {
            ...current,
            workers: [...current.workers, entry],
          });
        },
      });
      if (!changed.ok) return changed;
      return success(
        changed.data.task.revision,
        changed.data.workspace.revision,
        changed.data.task.workers.at(-1)!,
      );
    }

    const entry = task.data.workers.find((candidate) => candidate.id === input.workerId);
    if (!entry) return failure("not_found", "worker not found");
    if (input.action === "report") {
      if (helperId === null || helperId !== input.workerId)
        return failure("permission_denied", "workers can submit only their own report");
      const helper = this.helperEntry(task.data, true, true);
      if (!helper.ok) return helper;
      const evidence = task.data.evidence.filter((candidate) =>
        input.report.evidenceIds.includes(candidate.id),
      );
      const findings = task.data.findings.filter((candidate) =>
        input.report.findingIds.includes(candidate.id),
      );
      if (
        evidence.length !== input.report.evidenceIds.length ||
        findings.length !== input.report.findingIds.length
      )
        return failure("invalid_input", "worker report references an unknown record");
      if (
        evidence.some((candidate) => candidate.provenance.workerId !== helperId) ||
        findings.some((candidate) => candidate.provenance.workerId !== helperId) ||
        evidence.some(
          (candidate) =>
            !refsWithinScope(candidate.data.refs, helper.data.data.assignment.scope) ||
            !refsWithinScope(candidate.data.refs, task.data.intent.data.scope),
        ) ||
        findings.some(
          (candidate) =>
            !refsWithinScope(candidate.data.refs, helper.data.data.assignment.scope) ||
            !refsWithinScope(candidate.data.refs, task.data.intent.data.scope),
        )
      )
        return failure("permission_denied", "worker report is outside the worker assignment");
      const changed = this.store.mutateTaskAndWorkspace({
        taskId: task.data.id,
        expectedRevision: input.expectedRevision,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        now: trustedNow(this.context),
        workspace: (current, mutation) => success(mutation.revision, mutation.revision, current),
        task: (current, mutation) =>
          success(mutation.revision, null, {
            ...current,
            workers: current.workers.map((candidate) =>
              candidate.id === input.workerId
                ? {
                    ...candidate,
                    recordedAt: mutation.now,
                    data: { ...candidate.data, report: input.report },
                  }
                : candidate,
            ),
          }),
      });
      if (!changed.ok) return changed;
      const updated = changed.data.task.workers.find(
        (candidate) => candidate.id === input.workerId,
      );
      return updated
        ? success(changed.data.task.revision, changed.data.workspace.revision, updated)
        : failure("recovery_required", "worker disappeared during report");
    }

    if (helperId !== null)
      return failure("permission_denied", "helpers cannot cancel or control workers");
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot cancel workers");
    if (entry.data.state === "stopped") {
      // Idempotent cancel: repeating a settled stop succeeds with the
      // current entry instead of failing the retry.
      const stopped = task.data.workers.find((candidate) => candidate.id === input.workerId)!;
      return success(task.data.revision, workspace.data.revision, stopped);
    }
    // Lead-attested cancel is terminal for every live or unknown state: the lead
    // saw the run end (or chose to abandon it), so no host observation is awaited. A later live-child
    // sighting against a stopped worker is a new anomaly for the host to
    // flag, not a reason to strand the worker short of stopped.
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (current, mutation) => success(mutation.revision, mutation.revision, current),
      task: (current, mutation) =>
        success(mutation.revision, null, {
          ...current,
          workers: current.workers.map((candidate) =>
            candidate.id === input.workerId
              ? {
                  ...candidate,
                  recordedAt: mutation.now,
                  data: { ...candidate.data, state: "stopped" as const },
                }
              : candidate,
          ),
        }),
    });
    if (!changed.ok) return changed;
    return success(
      changed.data.task.revision,
      changed.data.workspace.revision,
      changed.data.task.workers.find((candidate) => candidate.id === input.workerId)!,
    );
  }

  observeWorkerLifecycle(input: NativeWorkerObservation): Result<Entry<Worker>> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    if (
      this.context.workerId !== undefined &&
      this.context.workerId !== null &&
      this.context.workerId !== input.workerId
    )
      return failure("permission_denied", "worker observation does not match the caller");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const authority = verifyNativeWorker(
      this.context.nativeWorker,
      {
        observation: input.observation,
        expected: { ...input, workspaceId: workspace.data.id },
        caller: this.context.caller,
      },
      {
        owner: this.authorityOwner,
        store: this.store,
        root: this.store.root,
        caller: this.context.caller,
      },
    );
    if (!authority.ok) return authority;
    return applyWorkerLifecycle({
      ...input,
      store: this.store,
      authority: authority.data,
      authorityOwner: this.authorityOwner,
      caller: this.context.caller,
      now: trustedNow(this.context),
    });
  }

  private resolve(task: TaskRecord, judgment: Judgment): Result<Policy> {
    return resolvePolicy({
      intent: task.intent.data,
      judgment,
      constraints: this.context.constraints,
      verification: workspaceVerification(this.context.root),
    });
  }

  private summary(task: TaskRecord): Result<TaskSummary> {
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const historical = task.status === "closed" ? task.candidates.at(-1) : undefined;
    const current = historical
      ? success(null, null, historical)
      : captureCandidate(this.store.root, task.intent.data.scope, environment());
    if (!current.ok) return current;
    const evaluationWorkspace = workspace.data;
    const tree = treeFreshness(this.store.root);
    const requirements = evaluateRequirements(
      task,
      evaluationWorkspace,
      this.context.capabilities,
      current.data,
      this.store.root,
      this.context.caller,
      tree,
    );
    return success(task.revision, workspace.data.revision, {
      id: task.id,
      revision: task.revision,
      workspaceRevision: workspace.data.revision,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      runtime: task.runtime ?? null,
      objective: task.intent.data.objective,
      status: task.status,
      closure: task.closure,
      progress: task.progress,
      policy: task.policy,
      requirements,
    });
  }

  /**
   * Compact task context for per-turn host injection. Unlike `inspect`
   * view:"full", it never captures a candidate: evidence and requirements are
   * judged against the last recorded candidate, and live staleness is
   * detected by evidence, close, resume, and full inspection, which capture.
   */
  compactContext(taskId: string, freshness?: Freshness): Result<string> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    const task = this.store.readTask(taskId);
    if (!task.ok) return task;
    const helper = this.helperTaskGuard(task.data, true);
    if (!helper.ok) return helper;
    // Per-turn path: the cheap worktree signal, never the object-writing tree hash.
    const view = this.view(task.data, false, freshness ?? signalFreshness(this.store.root));
    if (!view.ok) return view;
    return success(view.revision, view.workspaceRevision, compactTaskContext(view.data));
  }

  private view(
    task: TaskRecord,
    capture = true,
    freshness: Freshness = treeFreshness(this.store.root),
  ): Result<TaskView> {
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const historical = task.status === "closed" ? task.candidates.at(-1) : undefined;
    const current = historical
      ? success(null, null, historical)
      : capture
        ? captureCandidate(this.store.root, task.intent.data.scope, environment())
        : success<Candidate | null>(null, null, task.candidates.at(-1) ?? null);
    if (!current.ok) return current;
    const evaluationWorkspace = workspace.data;
    const tree = freshness;
    const requirements = evaluateRequirements(
      task,
      evaluationWorkspace,
      this.context.capabilities,
      current.data,
      this.store.root,
      this.context.caller,
      tree,
    );
    return success(task.revision, workspace.data.revision, {
      task,
      workspace: evaluationWorkspace,
      capabilities: this.context.capabilities,
      requirements,
      evidence: evaluateEvidence(task, current.data, tree),
    });
  }

  reconcileResume(
    view: TaskView,
    observations: NativeWorkerObservation[] = [],
  ): Result<ResumeReconciliation> {
    const root = this.contextRootError();
    if (!root.ok) return root;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot reconcile task workers");
    if (view.task.workspaceId !== view.workspace.id)
      return failure("invalid_input", "task and workspace bindings are invalid");
    try {
      if (realpathSync(view.workspace.root) !== this.store.root)
        return failure("invalid_input", "task view root does not match the task store");
    } catch {
      return failure("invalid_input", "task view root cannot be resolved");
    }
    const updates: NativeWorkerObservation[] = [];
    const seen = new Set<string>();
    const binding: WorkerBinding = {
      owner: this.authorityOwner,
      store: this.store,
      root: this.store.root,
      caller: this.context.caller,
    };
    for (const observation of observations) {
      if (seen.has(observation.workerId))
        return failure("invalid_input", "worker observations must be unique");
      seen.add(observation.workerId);
      // Anchor on fresh reads, not the passed view: a view captured before
      // recent mutations must not stale-fail observations that match the
      // current state. Genuinely stale observations still conflict below.
      const freshTask = this.store.readTask(view.task.id);
      const freshWorkspace = this.store.readWorkspace();
      if (!freshTask.ok) return freshTask;
      if (!freshWorkspace.ok) return freshWorkspace;
      if (!freshWorkspace.data) return failure("not_found", "workspace not found");
      if (
        observation.taskId !== view.task.id ||
        observation.expectedRevision !== freshTask.data.revision ||
        observation.expectedWorkspaceRevision !== freshWorkspace.data.revision
      )
        return failure("revision_conflict", "worker observation is stale");
      if (!view.task.workers.some((entry) => entry.id === observation.workerId))
        return failure("permission_denied", "worker observation is not assigned");
      const verified = verifyNativeWorker(
        this.context.nativeWorker,
        {
          observation: observation.observation,
          expected: { ...observation, workspaceId: view.workspace.id },
          caller: this.context.caller,
        },
        binding,
      );
      if (!verified.ok) return verified;
      if (!takeWorker(verified.data, binding, observation))
        return failure("permission_denied", "worker observation authority was not retained");
      updates.push(observation);
    }
    const observedStates = new Map(updates.map((entry) => [entry.workerId, entry.state]));
    const effectiveView: TaskView = {
      ...view,
      task: {
        ...view.task,
        workers: view.task.workers.map((entry) => {
          const update = updates.find((item) => item.workerId === entry.id);
          return update
            ? {
                ...entry,
                data: { ...entry.data, state: update.state, session: update.session },
              }
            : entry;
        }),
      },
    };
    const base = reconcileResumeContext(effectiveView);
    if (!base.ok) return base;
    const needsReconciliation = view.task.workers.some((entry) =>
      isUncertainWorker(observedStates.get(entry.id) ?? entry.data.state),
    );
    const blockers = [...base.data.blockers];
    if (
      needsReconciliation &&
      !blockers.some((entry) => entry.reason === "worker state requires reconciliation")
    )
      blockers.push({
        reason: "worker state requires reconciliation",
        dependentAction: "resume",
        refs: [],
      });
    return success(null, null, { ...base.data, workerUpdates: updates, blockers });
  }

  private transition(input: any, status: "active" | "paused"): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper;
    if (
      (status === "paused" && task.data.status !== "active") ||
      (status === "active" && task.data.status !== "paused")
    )
      return failure("invalid_transition", `cannot transition ${task.data.status} to ${status}`);
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    this.fillRevisions(input, task.data, workspace.data);
    let resumeCandidate: import("./task-contract").Candidate | null = null;
    if (status === "active" && task.data.origin) {
      if (!task.data.policy)
        return failure("needs_input", "imported task requires a current policy");
      if (task.data.policy.policyVersion !== POLICY_VERSION)
        return failure(
          "needs_input",
          "stored policy version is unsupported; reassessment is required",
        );
      const view = this.view(task.data);
      if (!view.ok) return view;
      const current = reconcileResumeContext(view.data);
      if (!current.ok) return current;
      const requirements = view.data.requirements;
      if (
        requirements.some(
          (requirement) =>
            requirement.status === "unsatisfied" || requirement.status === "unavailable",
        )
      )
        return failure("requirements_unsatisfied", "imported task requires current requirements", {
          requirementIds: requirements
            .filter(
              (requirement) =>
                requirement.status === "unsatisfied" || requirement.status === "unavailable",
            )
            .map((requirement) => requirement.requirementId),
        });
      if (current.data.reassessmentRequired)
        return failure("needs_input", "imported task requires destination policy reassessment");
      if (current.data.staleEvidenceIds.length)
        return failure("needs_input", "imported task requires fresh destination evidence");
      if (
        current.data.blockers.some(
          (blocker) =>
            blocker.dependentAction === "resume" ||
            blocker.reason === "worker state requires reconciliation",
        )
      )
        return failure("recovery_required", "imported task requires resume reconciliation");
      resumeCandidate = current.data.candidate;
    }
    const blocker = status === "paused" ? null : this.activeWorkerBlocker(task.data);
    if (blocker) return blocker;
    let pauseCandidate: import("./task-contract").Candidate | null = null;
    if (status === "paused") {
      // Freezing records the tree state the task resumes from.
      const captured = captureCandidate(
        this.store.root,
        task.data.intent.data.scope,
        environment(),
      );
      if (!captured.ok) return captured;
      pauseCandidate = captured.data;
    }
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (unchanged, context) => success(context.revision, context.revision, unchanged),
      task: (current, context) =>
        success(context.revision, null, {
          ...current,
          status,
          candidates:
            (resumeCandidate ?? pauseCandidate) &&
            !current.candidates.some(
              (candidate) => candidate.id === (resumeCandidate ?? pauseCandidate)!.id,
            )
              ? [...current.candidates, (resumeCandidate ?? pauseCandidate)!]
              : current.candidates,
          progress: current.progress,
          pauseReason: status === "paused" ? (input.reason ?? null) : null,
        }),
    });
    if (!changed.ok) return changed;
    return this.summary(changed.data.task);
  }

  private progress(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot update progress");
    this.fillRevisions(input, task.data);
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, context) =>
        success(context.revision, null, { ...current, progress: input.progress }),
      trustedNow(this.context),
    );
    if (!changed.ok) return changed;
    return this.summary(changed.data);
  }

  private revise(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot be revised");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const revisionBlocker = this.activeWorkerBlocker(task.data);
    if (revisionBlocker) return revisionBlocker;
    this.fillRevisions(input, task.data, workspace.data);
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (unchanged, context) => success(context.revision, context.revision, unchanged),
      task: (current, context) =>
        success(context.revision, null, {
          ...current,
          intent: {
            id: newId(),
            recordedAt: context.now,
            provenance: provenance(this.context),
            data: input.intent,
          },
          policy: null,
          progress: { ...current.progress, summary: `Policy invalidated: ${input.reason}` },
        }),
    });
    if (!changed.ok) return changed;
    return this.summary(changed.data.task);
  }

  private close(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper;
    if (task.data.status !== "active" && task.data.status !== "paused")
      return failure("invalid_transition", "closed task cannot be reopened or closed again");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const blocker = this.activeWorkerBlocker(task.data);
    if (blocker) return blocker;
    this.fillRevisions(input, task.data, workspace.data);
    const current = captureCandidate(this.store.root, task.data.intent.data.scope, environment());
    if (!current.ok) return current;
    const withCandidate = current.data;
    const taskForView =
      withCandidate.id === task.data.candidates.at(-1)?.id
        ? task.data
        : { ...task.data, candidates: [...task.data.candidates, withCandidate] };
    const tree = treeFreshness(this.store.root);
    const requirements = evaluateRequirements(
      taskForView,
      workspace.data,
      this.context.capabilities,
      withCandidate,
      this.store.root,
      this.context.caller,
      tree,
    );
    const view = {
      task: taskForView,
      workspace: workspace.data,
      capabilities: this.context.capabilities,
      requirements,
      evidence: evaluateEvidence(taskForView, withCandidate, tree),
    } satisfies TaskView;
    const closure = evaluateClosure(input.outcome, view);
    if (!closure.ok) return closure;
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (value, context) => success(context.revision, context.revision, value),
      task: (value, context) =>
        success(context.revision, null, {
          ...value,
          status: "closed",
          candidates: taskForView.candidates,
          closure: {
            outcome: closure.data.outcome,
            at: context.now,
            summary: input.summary,
            decisionIds: closure.data.decisionIds,
            evidenceIds: closure.data.evidenceIds,
          },
        }),
    });
    if (!changed.ok) return changed;
    return this.summary(changed.data.task);
  }
}
