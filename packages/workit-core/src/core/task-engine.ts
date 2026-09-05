import { realpathSync } from "node:fs";
import {
  POLICY_VERSION,
  canonicalJson,
  failure,
  decisionDigest,
  exportBundleSchema,
  newId,
  parseOperation,
  success,
  type Assessment,
  type Capability,
  type Caller,
  type Constraint,
  type Decision,
  type Entry,
  type Evidence,
  type ExportBundle,
  type Finding,
  type Policy,
  provenanceSchema,
  type Ref,
  type Result,
  type Scope,
  type TaskRecord,
  type TaskSummary,
  type TaskView,
  type Utc,
  type Provenance,
  type Worker,
  type WorkspaceRecord,
  taskRecordSchema,
} from "./task-contract";
import {
  bindingCovers,
  applicableDecision,
  storedDecisionApplicable,
  reserveAction as reserveBoundedAction,
  settleAction as settleBoundedAction,
  verifyNativeAction,
  verifyNativeDecision,
  verifyDecisionContent,
  retireNativeAuthority,
  type ActionReservation,
  type NativeAuthorityVerifier,
  type ReserveActionInput,
  type SettleActionInput,
} from "./authority";
import { diffPolicy, resolvePolicy } from "./policy-resolver";
import { TaskStore, type MetadataLock, type ProcessEvidence } from "./task-store";
import {
  exportDigest,
  reconcileResume as reconcileResumeContext,
  type ResumeReconciliation,
} from "./task-context";
import {
  assertProductWriteAllowed,
  type CallerContext,
  type NativeWorkerObservation,
  type NativeWorkerVerification,
  type NativeWorkerVerifier,
} from "./workers";
import {
  captureCandidate,
  evaluateClosure,
  evaluateEvidence,
  evaluateRequirements,
  type CandidateEnvironment,
} from "./task-evaluation";

export type OperationContext = {
  root: string;
  caller: Caller;
  capabilities: Capability[];
  constraints: Constraint[];
  now: Utc | (() => Utc);
  nativeAuthority?: NativeAuthorityVerifier;
  nativeWorker?: NativeWorkerVerifier;
  nativeRecovery?: (input: {
    lock: MetadataLock | null;
    writer: WorkspaceRecord["writer"];
    reason: string;
    authorityRefs: Ref[];
  }) => Result<ProcessEvidence>;
  workerId?: string | null;
};

const provenance = (
  context: OperationContext,
  kind: "host_observed" | "agent_reported" = "host_observed",
) => ({
  kind,
  host: context.caller.host,
  session: { kind: "host" as const, host: context.caller.host, handle: context.caller.actor },
  workerId: context.workerId ?? null,
  receipts: [],
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
  const provenance = value as Provenance;
  return (
    provenance.kind === "host_observed" &&
    provenance.host === caller.host &&
    provenance.workerId === expected.workerId &&
    sameValue(provenance.session, expected.session) &&
    provenance.receipts.some((receipt) => receipt.kind === "host" && receipt.host === caller.host)
  );
};

const validResumeApproval = (
  task: TaskRecord,
  workspace: WorkspaceRecord,
  authorityRefs: Ref[],
  context: OperationContext,
): boolean =>
  authorityRefs.some((ref) => {
    if (ref.kind !== "record" || ref.collection !== "decisions") return false;
    const entry = task.decisions.find((candidate) => candidate.id === ref.id);
    if (!entry || entry.provenance.kind !== "host_observed") return false;
    if (
      entry.provenance.host !== context.caller.host ||
      !sameSession(entry.provenance.session, context) ||
      !entry.provenance.receipts.some(
        (receipt) => receipt.kind === "host" && receipt.host === context.caller.host,
      )
    )
      return false;
    const decision = entry.data;
    if (
      !["design", "action"].includes(decision.purpose) ||
      decision.response !== "approved" ||
      decision.revoked !== null ||
      decision.binding.approvedContent !== "resume" ||
      decision.binding.taskId !== task.id ||
      decision.binding.workspaceId !== workspace.id ||
      canonicalJson(decision.binding.scope) !== canonicalJson(task.intent.data.scope)
    )
      return false;
    return (["design", "action"] as const).some((purpose) =>
      applicableDecision(task, purpose, decision.binding, workspace.root).some(
        (candidate) => candidate.digest === decision.digest,
      ),
    );
  });

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
    !sameValue(value.session, expected.session)
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
  if (entry.data.session && !sameValue(entry.data.session, input.session))
    return failure("permission_denied", "worker session does not match its assignment");
  if (input.state !== "running" && entry.data.state === "assigned" && input.state !== "stopped")
    return failure("invalid_transition", "worker has not started");
  if (input.state === "running" && entry.data.state === "stopped")
    return failure("invalid_transition", "stopped worker cannot run again");
  const nextEntry = {
    ...entry,
    recordedAt: input.now ?? entry.recordedAt,
    provenance: authority.provenance,
    data: { ...entry.data, state: input.state, session: input.session },
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
};

const refsWithinScope = (refs: Ref[], scope: Scope): boolean =>
  refs.every(
    (ref) =>
      ref.kind !== "file" ||
      bindingCovers(scope, { description: "", paths: [ref.path], exclusions: [] }),
  );

const trustedNow = (context: OperationContext): Utc =>
  typeof context.now === "function" ? context.now() : context.now;

const mapRef = (ref: Ref, ids: Map<string, string>): Ref => {
  if (ref.kind !== "record") return ref;
  return { ...ref, id: ids.get(ref.id) ?? ref.id };
};

const portableRefs = (refs: Ref[]): Ref[] =>
  refs.filter((ref) => ref.kind === "file" || ref.kind === "record");
const portableRef = (ref: Ref | null): Ref | null =>
  ref && (ref.kind === "file" || ref.kind === "record") ? ref : null;
const portableFact = (fact: Assessment["facts"][number]) => {
  const refs = portableRefs(fact.refs);
  return fact.basis === "observed" && refs.length === 0
    ? { ...fact, basis: "unknown" as const, refs }
    : { ...fact, refs };
};
const portableSignal = (signal: Assessment["signals"][keyof Assessment["signals"]]) => {
  const refs = portableRefs(signal.refs);
  return signal.basis === "observed" && refs.length === 0
    ? {
        ...signal,
        value: "unknown" as const,
        basis: "unknown" as const,
        reason: "portable supporting reference was removed",
        refs,
      }
    : { ...signal, refs };
};

const importedProvenance = (context: OperationContext): Provenance => ({
  kind: "imported",
  host: context.caller.host,
  session: null,
  workerId: null,
  receipts: [],
});

const portableTask = (task: TaskRecord): TaskRecord => {
  const clone = structuredClone(task);
  const portableProvenance = (value: Provenance): Provenance => ({
    ...value,
    session: null,
    receipts: [],
  });
  const entries = [
    clone.intent,
    ...clone.assessments,
    ...clone.evidence,
    ...clone.decisions,
    ...clone.findings,
    ...clone.workers,
  ];
  for (const entry of entries) entry.provenance = portableProvenance(entry.provenance);
  for (const worker of clone.workers) worker.data.session = null;
  clone.intent = {
    ...clone.intent,
    data: { ...clone.intent.data, authorityRefs: portableRefs(clone.intent.data.authorityRefs) },
  };
  clone.constraints = clone.constraints.flatMap((constraint) => {
    const source = portableRef(constraint.source);
    return source
      ? [
          {
            ...constraint,
            source,
            requires: constraint.requires.map((requirement) => ({
              ...requirement,
              refs: portableRefs(requirement.refs),
            })),
          },
        ]
      : [];
  });
  clone.assessments = clone.assessments.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      facts: entry.data.facts.map(portableFact),
      signals: Object.fromEntries(
        Object.entries(entry.data.signals).map(([name, signal]) => [name, portableSignal(signal)]),
      ) as typeof entry.data.signals,
      consequences: entry.data.consequences.map((consequence) => ({
        ...consequence,
        fact: portableFact(consequence.fact),
      })),
      verification: entry.data.verification.map((verification) => ({
        ...verification,
        availableChecks: portableRefs(verification.availableChecks),
      })),
    },
  }));
  clone.progress = {
    ...clone.progress,
    blockers: clone.progress.blockers.map((blocker) => ({
      ...blocker,
      refs: portableRefs(blocker.refs),
    })),
  };
  clone.evidence = clone.evidence.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      refs: portableRefs(entry.data.refs),
      reviewContext: portableRef(entry.data.reviewContext),
    },
  }));
  clone.decisions = clone.decisions.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      consumption: entry.data.consumption
        ? portableRef(entry.data.consumption.actionRef)
          ? {
              ...entry.data.consumption,
              actionRef: portableRef(entry.data.consumption.actionRef)!,
            }
          : null
        : null,
      binding: {
        ...entry.data.binding,
        contentRefs: portableRefs(entry.data.binding.contentRefs),
      },
    },
  }));
  clone.findings = clone.findings.map((entry) => ({
    ...entry,
    data: { ...entry.data, refs: portableRefs(entry.data.refs) },
  }));
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
    ...source.evidence,
    ...source.decisions,
    ...source.findings,
    ...source.workers,
  ])
    allocate(entry.id);
  const fresh = (id: string) => allocate(id);
  const provenance = importedProvenance(context);
  const intent = {
    ...source.intent,
    id: fresh(source.intent.id),
    recordedAt: timestamp,
    provenance,
    data: {
      ...source.intent.data,
      authorityRefs: source.intent.data.authorityRefs.map((ref) => mapRef(ref, ids)),
    },
  };
  const assessments = source.assessments.map((entry) => {
    const data = entry.data;
    return {
      ...entry,
      id: fresh(entry.id),
      recordedAt: timestamp,
      provenance,
      data: {
        ...data,
        facts: data.facts.map((fact) => ({
          ...fact,
          refs: fact.refs.map((ref) => mapRef(ref, ids)),
        })),
        signals: Object.fromEntries(
          Object.entries(data.signals).map(([name, signal]) => [
            name,
            { ...signal, refs: signal.refs.map((ref) => mapRef(ref, ids)) },
          ]),
        ) as typeof data.signals,
        consequences: data.consequences.map((consequence) => ({
          ...consequence,
          fact: {
            ...consequence.fact,
            refs: consequence.fact.refs.map((ref) => mapRef(ref, ids)),
          },
        })),
        verification: data.verification.map((verification) => ({
          ...verification,
          availableChecks: verification.availableChecks.map((ref) => mapRef(ref, ids)),
        })),
      },
    };
  });
  const evidence = source.evidence.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance,
    data: {
      ...entry.data,
      refs: entry.data.refs.map((ref) => mapRef(ref, ids)),
      reviewContext: entry.data.reviewContext ? mapRef(entry.data.reviewContext, ids) : null,
    },
  }));
  const decisions = source.decisions.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance,
  }));
  const findings = source.findings.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance,
    data: {
      ...entry.data,
      refs: entry.data.refs.map((ref) => mapRef(ref, ids)),
      resolution: entry.data.resolution
        ? {
            ...entry.data.resolution,
            evidenceIds: entry.data.resolution.evidenceIds.map((id) => ids.get(id) ?? id),
            decisionIds: entry.data.resolution.decisionIds.map((id) => ids.get(id) ?? id),
          }
        : null,
    },
  }));
  const workers = source.workers.map((entry) => ({
    ...entry,
    id: fresh(entry.id),
    recordedAt: timestamp,
    provenance,
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
  const actionProgress = source.actionProgress?.map((entry) => ({
    ...entry,
    decisionId: ids.get(entry.decisionId) ?? entry.decisionId,
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
    evidence,
    decisions: decisions.map((entry) => ({
      ...entry,
      data: {
        ...entry.data,
        binding: {
          ...entry.data.binding,
          taskId: "",
          workspaceId: destinationWorkspaceId,
          contentRefs: entry.data.binding.contentRefs.map((ref) => mapRef(ref, ids)),
        },
        consumption: null,
      },
    })),
    ...(actionProgress ? { actionProgress } : {}),
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

  private contextRootError(): Result<null> {
    try {
      if (realpathSync(this.context.root) !== this.store.root)
        return failure(
          "invalid_input",
          "operation context root does not match the task store root",
        );
    } catch {
      return failure("invalid_input", "operation context root cannot be resolved");
    }
    return success(null, null, null);
  }

  private callerContext(): CallerContext {
    return {
      ...this.context.caller,
      workerId: this.context.workerId ?? null,
    };
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
    if (!worker.ok) return worker as Result<never>;
    return allowRead
      ? success(null, null, null)
      : failure("permission_denied", "helpers cannot control task lifecycle or scope");
  }

  private activeWorkerBlocker(
    task: TaskRecord,
    workspace: import("./task-contract").WorkspaceRecord,
  ) {
    if (workspace.writer)
      return failure("recovery_required", "writer ownership must be released first");
    if (
      task.workers.some((entry) => ["running", "cancelling", "unknown"].includes(entry.data.state))
    )
      return failure("recovery_required", "worker state requires reconciliation");
    return null;
  }

  state(request: unknown): Result<ExportBundle | TaskSummary | TaskRecord | WorkspaceRecord> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot control task state");
    const parsed = parseOperation("state", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    if (input.action === "export") {
      const task = this.store.readTask(input.taskId);
      if (!task.ok) return task as Result<never>;
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
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
      if (!workspace.ok) return workspace as Result<never>;
      const destinationWorkspaceId = workspace.data?.id ?? newId();
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
      if (!imported.ok) return imported as Result<never>;
      return this.summary(imported.data);
    }
    if (!this.context.nativeRecovery)
      return failure("permission_denied", "native recovery authority is unavailable");
    const processEvidence = (
      lock: MetadataLock | null,
      writer: WorkspaceRecord["writer"],
    ): Result<ProcessEvidence> =>
      this.context.nativeRecovery!({
        lock,
        writer,
        reason: input.reason,
        authorityRefs: input.authorityRefs,
      });
    if (input.target === "workspace")
      return this.store.recoverWorkspace({
        expectedBytes: input.expectedBytes,
        snapshotDigest: input.snapshotDigest,
        reason: input.reason,
        authorityRefs: input.authorityRefs,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        processEvidence,
      });
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    return this.store.recoverTask(input.taskId, {
      expectedBytes: input.expectedBytes,
      snapshotDigest: input.snapshotDigest,
      reason: input.reason,
      authorityRefs: input.authorityRefs,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      processEvidence,
    });
  }

  task(request: unknown): Result<TaskSummary | TaskSummary[] | TaskView> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("task", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    if ((this.context.workerId ?? null) !== null) {
      if (input.action !== "inspect")
        return failure("permission_denied", "helpers cannot control task lifecycle or scope");
    }
    switch (input.action) {
      case "start": {
        const created = this.store.create({
          intent: input.intent,
          provenance: provenance(this.context),
          expectedWorkspaceRevision: input.expectedWorkspaceRevision,
          now: trustedNow(this.context),
        });
        if (!created.ok) return created as Result<never>;
        return this.summary(created.data);
      }
      case "list": {
        const listed = this.store.listTasks();
        if (!listed.ok) return listed as Result<never>;
        const summaries: TaskSummary[] = [];
        for (const task of listed.data) {
          const summary = this.summary(task);
          if (!summary.ok) return summary;
          summaries.push(summary.data);
        }
        return success(null, null, summaries);
      }
      case "inspect": {
        const task = this.store.readTask(input.taskId);
        if (!task.ok) return task as Result<never>;
        const helper = this.helperTaskGuard(task.data, true);
        if (!helper.ok) return helper as Result<never>;
        if (input.view === "summary") return this.summary(task.data);
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
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("policy", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    if (input.action === "explain") return success(task.data.revision, null, task.data.policy);
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot change task requirements");
    const resolved = this.resolve(task.data, input.assessment);
    if (!resolved.ok) return resolved;
    if (input.action === "preview") return success(null, null, resolved.data);
    if (input.action !== "assess")
      return failure("invalid_transition", "unsupported policy action");
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
        const assessment = {
          id: newId(),
          recordedAt: mutation.now,
          provenance: provenance(this.context),
          data: input.assessment as Assessment,
        };
        const next = {
          ...current,
          constraints: this.context.constraints,
          assessments: [...current.assessments, assessment],
          policy: resolved.data,
          policyChanges: nextChange
            ? [...current.policyChanges, nextChange]
            : current.policyChanges,
        };
        return success(mutation.revision, null, next);
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed as Result<never>;
    return success(changed.data.revision, null, changed.data.policy);
  }

  evidence(request: unknown): Result<Entry<Evidence>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("evidence", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot record evidence");
    const helper =
      (this.context.workerId ?? null) === null ? null : this.helperEntry(task.data, true, true);
    if (helper && !helper.ok) return helper as Result<never>;
    const evidence = input.evidence as Evidence;
    if (helper?.ok) {
      const assignment = helper.data.data.assignment;
      if (
        evidence.requirementIds.some((id: string) => !assignment.requirementIds.includes(id)) ||
        (assignment.candidateId !== null &&
          evidence.candidateId !== assignment.candidateId &&
          evidence.beforeCandidateId !== assignment.candidateId) ||
        !refsWithinScope(evidence.refs, assignment.scope) ||
        !refsWithinScope(evidence.refs, task.data.intent.data.scope)
      )
        return failure("permission_denied", "evidence is outside the worker assignment");
    }
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
    if (!currentCandidate.ok) return currentCandidate as Result<never>;
    const knownCandidates = new Set(task.data.candidates.map((candidate) => candidate.id));
    for (const candidateId of [evidence.beforeCandidateId, evidence.candidateId]) {
      if (
        candidateId &&
        candidateId !== currentCandidate.data.id &&
        !knownCandidates.has(candidateId)
      )
        return failure("invalid_input", "evidence candidate is not a captured candidate");
    }
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
          data: evidence,
        };
        return success(mutation.revision, null, {
          ...current,
          candidates,
          evidence: [...current.evidence, entry],
          findings: current.findings.map((finding) => {
            const relevant =
              finding.data.candidateId === null ||
              evidence.candidateId !== finding.data.candidateId ||
              finding.data.refs.some((left: Ref) =>
                evidence.refs.some((right: Ref) => JSON.stringify(left) === JSON.stringify(right)),
              );
            return finding.data.disposition === "open" || evidence.result === "skipped" || !relevant
              ? finding
              : { ...finding, data: { ...finding.data, disposition: "open", resolution: null } };
          }),
        });
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed as Result<never>;
    return success(changed.data.revision, null, changed.data.evidence.at(-1)!);
  }

  decision(request: unknown): Result<Entry<Decision>> {
    return this.recordDecision(request);
  }

  observeDecision(request: unknown, observation: unknown): Result<Entry<Decision>> {
    return this.recordDecision(request, observation, true);
  }

  private recordDecision(
    request: unknown,
    nativeObservation?: unknown,
    nativeRequired = false,
  ): Result<Entry<Decision>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("decision", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    if (nativeRequired && input.action !== "record")
      return failure(
        "permission_denied",
        "native observation is only valid for recording decisions",
      );
    if (nativeRequired && nativeObservation === undefined)
      return failure("permission_denied", "native decision observation is required");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot record or revoke decisions");
    if (input.action === "record") {
      if (task.data.status === "closed")
        return failure("invalid_transition", "closed task cannot record a decision");
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
      if (!workspace.data) return failure("not_found", "workspace not found");
      if (input.binding.taskId !== task.data.id || input.binding.workspaceId !== workspace.data.id)
        return failure("permission_denied", "decision task or workspace binding is invalid");
      const content = verifyDecisionContent(this.store, input.binding);
      if (!content.ok) return content as Result<never>;
      const knownRequirements = new Set(
        task.data.policy?.requirements.map((item) => item.id) ?? [],
      );
      if (input.requirementIds.some((id: string) => !knownRequirements.has(id)))
        return failure("invalid_input", "decision references an unknown requirement");
      const base = {
        purpose: input.purpose,
        binding: input.binding,
        response: input.response,
        requirementIds: input.requirementIds,
        revoked: null,
        consumption: null,
      } satisfies Omit<Decision, "digest">;
      const data: Decision = { ...base, digest: decisionDigest(base) };
      const native = nativeRequired
        ? verifyNativeDecision(
            this.context.nativeAuthority,
            {
              observation: nativeObservation,
              expected: {
                taskId: task.data.id,
                workspaceId: workspace.data.id,
                purpose: input.purpose,
                response: input.response,
                binding: input.binding,
                bindingBytes: canonicalJson(input.binding),
                digest: data.digest,
                requirementIds: [...input.requirementIds],
              },
              caller: this.context.caller,
            },
            { owner: this.authorityOwner, store: this.store, root: this.store.root },
          )
        : null;
      if (native && !native.ok) return native as Result<never>;
      const nativeProvenance = native?.ok ? retireNativeAuthority(native.data) : null;
      if (native?.ok && !nativeProvenance)
        return failure("permission_denied", "native decision authority was retired");
      const changed = this.store.mutateTask(
        task.data.id,
        input.expectedRevision,
        (current, mutation) => {
          const content = verifyDecisionContent(this.store, input.binding);
          if (!content.ok) return content as Result<never>;
          const known = new Set(current.policy?.requirements.map((item) => item.id) ?? []);
          if (input.requirementIds.some((id: string) => !known.has(id)))
            return failure("invalid_input", "decision references an unknown requirement");
          if (
            nativeProvenance &&
            current.decisions.some((entry) =>
              entry.provenance.receipts.some((existingReceipt) =>
                nativeProvenance.receipts.some(
                  (receipt) => canonicalJson(receipt) === canonicalJson(existingReceipt),
                ),
              ),
            )
          )
            return failure("permission_denied", "native decision receipt was already consumed");
          const entry: Entry<Decision> = {
            id: newId(),
            recordedAt: mutation.now,
            provenance: nativeProvenance ?? provenance(this.context, "agent_reported"),
            data,
          };
          return success(mutation.revision, null, {
            ...current,
            decisions: [...current.decisions, entry],
          });
        },
        trustedNow(this.context),
      );
      if (!changed.ok) return changed as Result<never>;
      return success(changed.data.revision, null, changed.data.decisions.at(-1)!);
    }
    const decision = task.data.decisions.find((entry) => entry.id === input.decisionId);
    if (!decision) return failure("not_found", "decision not found");
    if (!input.reason.trim())
      return failure("invalid_input", "decision revocation requires a reason");
    if (decision.data.revoked) return failure("invalid_transition", "decision is already revoked");
    if (decision.data.consumption)
      return failure("permission_denied", "consumed decision cannot be revoked");
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, mutation) => {
        const entry = current.decisions.find((candidate) => candidate.id === input.decisionId);
        if (!entry) return failure("not_found", "decision not found");
        if (entry.data.revoked) return failure("invalid_transition", "decision is already revoked");
        if (entry.data.consumption)
          return failure("permission_denied", "consumed decision cannot be revoked");
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
      trustedNow(this.context),
    );
    if (!changed.ok) return changed as Result<never>;
    const entry = changed.data.decisions.find((candidate) => candidate.id === input.decisionId);
    return entry
      ? success(changed.data.revision, null, entry)
      : failure("recovery_required", "decision disappeared");
  }

  finding(request: unknown): Result<Entry<Finding>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("finding", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot mutate findings");
    const helper =
      (this.context.workerId ?? null) === null ? null : this.helperEntry(task.data, true, true);
    if (helper && !helper.ok) return helper as Result<never>;
    if (input.action === "record") {
      if (helper?.ok) {
        const assignment = helper.data.data.assignment;
        if (
          !bindingCovers(assignment.scope, input.scope) ||
          !bindingCovers(task.data.intent.data.scope, input.scope) ||
          (assignment.candidateId !== null && input.candidateId !== assignment.candidateId) ||
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
              candidateId: input.candidateId,
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
      if (!changed.ok) return changed as Result<never>;
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
      if (!current.ok) return current as Result<never>;
      const evaluations = evaluateEvidence(task.data, current.data);
      const verified = evidence.some((entry) => {
        const evaluation = evaluations.find((item) => item.evidenceId === entry.id);
        return (
          evaluation?.status === "passed" &&
          (entry.data.kind === "check" || entry.data.kind === "review") &&
          (finding.data.candidateId === null || entry.data.candidateId === finding.data.candidateId)
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
          entry.data.refs.some((right) => JSON.stringify(left) === JSON.stringify(right)),
        );
        return candidateMatches && (referenceMatches || entry.data.claim === finding.data.claim);
      });
      if (!relevant)
        return failure("permission_denied", "dismissal evidence is unrelated to the finding");
    }
    if (input.disposition === "deferred") {
      const workspace = this.store.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
      if (!workspace.data) return failure("not_found", "workspace not found");
      const allowed = decisions.some(
        (entry) =>
          entry.provenance.kind !== "imported" &&
          entry.data.purpose === "limitation" &&
          entry.data.response === "approved" &&
          entry.data.revoked === null &&
          entry.data.digest === decisionDigest(entry.data) &&
          verifyDecisionContent(this.store, entry.data.binding).ok &&
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
        return failure("permission_denied", "deferred findings require an applicable limitation");
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
    if (!changed.ok) return changed as Result<never>;
    const entry = changed.data.findings.find((candidate) => candidate.id === input.findingId);
    return entry
      ? success(changed.data.revision, null, entry)
      : failure("recovery_required", "finding disappeared");
  }

  worker(request: unknown): Result<Entry<Worker>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("worker", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const helperId = this.context.workerId ?? null;
    if (input.action === "assign") {
      if (helperId !== null) return failure("permission_denied", "helpers cannot assign workers");
      if (task.data.status !== "active")
        return failure("invalid_transition", "paused or closed tasks cannot assign workers");
      if (!bindingCovers(task.data.intent.data.scope, input.assignment.scope))
        return failure("permission_denied", "worker assignment is outside task scope");
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
      if (
        input.assignment.candidateId &&
        !task.data.candidates.some((candidate) => candidate.id === input.assignment.candidateId)
      )
        return failure("invalid_input", "worker assignment references an unknown candidate");
      const workerId = newId();
      const changed = this.store.mutateTaskAndWorkspace({
        taskId: task.data.id,
        expectedTaskRevision: input.expectedRevision,
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
      if (!changed.ok) return changed as Result<never>;
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
      if (!helper.ok) return helper as Result<never>;
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
        expectedTaskRevision: input.expectedRevision,
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
      if (!changed.ok) return changed as Result<never>;
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
    if (entry.data.state === "unknown")
      return failure("recovery_required", "worker state requires recovery");
    if (entry.data.state === "stopped")
      return failure("invalid_transition", "stopped worker cannot be cancelled");
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedTaskRevision: input.expectedRevision,
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
                  data: { ...candidate.data, state: "cancelling" as const },
                }
              : candidate,
          ),
        }),
    });
    if (!changed.ok) return changed as Result<never>;
    return success(
      changed.data.task.revision,
      changed.data.workspace.revision,
      changed.data.task.workers.find((candidate) => candidate.id === input.workerId)!,
    );
  }

  observeWorkerLifecycle(input: NativeWorkerObservation): Result<Entry<Worker>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    if (
      this.context.workerId !== undefined &&
      this.context.workerId !== null &&
      this.context.workerId !== input.workerId
    )
      return failure("permission_denied", "worker observation does not match the caller");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
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
    if (!authority.ok) return authority as Result<never>;
    return applyWorkerLifecycle({
      ...input,
      store: this.store,
      authority: authority.data,
      authorityOwner: this.authorityOwner,
      caller: this.context.caller,
      now: trustedNow(this.context),
    });
  }

  writer(request: unknown): Result<WorkspaceRecord> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("writer", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    if (task.data.status !== "active")
      return failure("invalid_transition", "paused or closed tasks cannot own product writes");
    const helperId = this.context.workerId ?? null;
    if (input.action === "acquire") {
      if (input.workerId !== helperId)
        return failure("permission_denied", "writer identity does not match the caller");
      if (workspace.data.writer) {
        if (workspace.data.writer.state === "uncertain")
          return failure("recovery_required", "checkout writer requires recovery", {
            owner: workspace.data.writer.owner,
          });
        const currentOwner = workspace.data.writer.owner;
        if (currentOwner.workerId) {
          const ownerWorker = task.data.workers.find(
            (candidate) => candidate.id === currentOwner.workerId,
          );
          if (ownerWorker?.data.state === "cancelling" || ownerWorker?.data.state === "unknown")
            return failure("recovery_required", "current worker has not stopped", {
              owner: currentOwner,
            });
        }
        return failure("writer_conflict", "checkout already has a writer", { owner: currentOwner });
      }
      if (helperId !== null) {
        const helper = this.helperEntry(task.data);
        if (!helper.ok) return helper as Result<never>;
        if (helper.data.data.assignment.role !== "implementer")
          return failure("permission_denied", "only implementers can own product writes");
        if (helper.data.data.state !== "running" || !helper.data.data.session)
          return failure(
            "permission_denied",
            "writer ownership requires an observed running worker",
          );
        if (!sameSession(helper.data.data.session, this.context))
          return failure("permission_denied", "worker session does not match the caller");
      }
      const owner = {
        taskId: task.data.id,
        workerId: helperId,
        session: {
          kind: "host" as const,
          host: this.context.caller.host,
          handle: this.context.caller.actor,
        },
      };
      const changed = this.store.mutateTaskAndWorkspace({
        taskId: task.data.id,
        expectedTaskRevision: input.expectedRevision,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        now: trustedNow(this.context),
        workspace: (current, mutation) =>
          success(mutation.revision, mutation.revision, {
            ...current,
            writer: { state: "held" as const, owner, acquiredAt: mutation.now },
          }),
        task: (current) => success(null, null, current),
      });
      if (!changed.ok) return changed as Result<never>;
      return success(
        changed.data.task.revision,
        changed.data.workspace.revision,
        changed.data.workspace,
      );
    }
    const current = workspace.data.writer;
    if (!current) return failure("permission_denied", "checkout has no writer owner");
    if (current.state === "uncertain")
      return failure("recovery_required", "checkout writer requires recovery", {
        owner: current.owner,
      });
    if (
      current.owner.taskId !== task.data.id ||
      current.owner.workerId !== helperId ||
      !sameSession(current.owner.session, this.context)
    )
      return failure("permission_denied", "only the current writer can release ownership");
    if (helperId !== null) {
      const helper = this.helperEntry(task.data);
      if (!helper.ok) return helper as Result<never>;
      if (helper.data.data.state !== "running")
        return failure("recovery_required", "worker must be observed stopped before release");
    }
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedTaskRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (currentWorkspace, mutation) =>
        success(mutation.revision, mutation.revision, { ...currentWorkspace, writer: null }),
      task: (currentTask) => success(null, null, currentTask),
    });
    if (!changed.ok) return changed as Result<never>;
    return success(
      changed.data.task.revision,
      changed.data.workspace.revision,
      changed.data.workspace,
    );
  }

  assertProductWriteAllowed(input: {
    task: TaskRecord;
    workspace: WorkspaceRecord;
    paths: string[];
  }) {
    return assertProductWriteAllowed({ ...input, caller: this.callerContext(), store: this.store });
  }

  applicableDecision(
    taskId: string,
    purpose: Decision["purpose"],
    binding: Decision["binding"],
  ): Result<Entry<Decision>[]> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const task = this.store.readTask(taskId);
    if (!task.ok) return task as Result<never>;
    const entries = storedDecisionApplicable(this.store, task.data, purpose, binding);
    return success(task.data.revision, null, entries);
  }

  reserveAction(
    input: Omit<
      ReserveActionInput,
      "store" | "native" | "authority" | "authorityOwner" | "authorityCaller"
    > & { observation: unknown },
  ): Result<ActionReservation> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot reserve external actions");
    if (input.observation === undefined)
      return failure("invalid_input", "native action observation is required");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const decision = task.data.decisions.find((entry) => entry.id === input.decisionId);
    if (!decision) return failure("not_found", "decision not found");
    const authority = verifyNativeAction(
      this.context.nativeAuthority,
      {
        observation: input.observation,
        expected: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          decisionId: input.decisionId,
          actionRef: input.actionRef,
          taskRevision: input.expectedRevision,
          workspaceRevision: input.expectedWorkspaceRevision,
          outcome: "reserve",
          decision: decision.data,
        },
        caller: this.context.caller,
      },
      { owner: this.authorityOwner, store: this.store, root: this.store.root },
    );
    if (!authority.ok) return authority as Result<never>;
    return reserveBoundedAction({
      ...input,
      store: this.store,
      authority: authority.data,
      authorityOwner: this.authorityOwner,
      authorityCaller: this.context.caller,
      native: { now: trustedNow(this.context) },
    });
  }

  settleAction(
    input: Omit<
      SettleActionInput,
      "store" | "native" | "authority" | "authorityOwner" | "authorityCaller"
    > & { observation: unknown },
  ): Result<Entry<Decision>> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    if ((this.context.workerId ?? null) !== null)
      return failure("permission_denied", "helpers cannot settle external actions");
    if (input.observation === undefined)
      return failure("invalid_input", "native action observation is required");
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const decision = task.data.decisions.find((entry) => entry.id === input.decisionId);
    if (!decision) return failure("not_found", "decision not found");
    const authority = verifyNativeAction(
      this.context.nativeAuthority,
      {
        observation: input.observation,
        expected: {
          taskId: task.data.id,
          workspaceId: workspace.data.id,
          decisionId: input.decisionId,
          actionRef: input.actionRef,
          taskRevision: input.taskRevision,
          workspaceRevision: input.workspaceRevision,
          outcome: input.outcome,
          decision: decision.data,
        },
        caller: this.context.caller,
      },
      { owner: this.authorityOwner, store: this.store, root: this.store.root },
    );
    if (!authority.ok) return authority as Result<never>;
    return settleBoundedAction({
      ...input,
      store: this.store,
      authority: authority.data,
      authorityOwner: this.authorityOwner,
      authorityCaller: this.context.caller,
      native: { now: trustedNow(this.context) },
    });
  }

  private resolve(task: TaskRecord, assessment: Assessment): Result<Policy> {
    return resolvePolicy({
      intent: task.intent.data,
      assessment,
      constraints: this.context.constraints,
      prior: {
        decisions: task.decisions
          .filter((entry) => entry.provenance.kind !== "imported")
          .map((entry) => entry.data),
        findings: task.findings
          .filter((entry) => entry.provenance.kind !== "imported")
          .map((entry) => entry.data),
        requirements: task.origin || task.policy === null ? [] : task.policy.requirements,
      },
    });
  }

  private summary(task: TaskRecord): Result<TaskSummary> {
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const current = captureCandidate(this.store.root, task.intent.data.scope, environment());
    if (!current.ok) return current as Result<never>;
    const requirements = evaluateRequirements(
      task,
      workspace.data,
      this.context.capabilities,
      current.data,
      this.store.root,
      this.context.caller,
    );
    return success(task.revision, workspace.data.revision, {
      id: task.id,
      revision: task.revision,
      workspaceRevision: workspace.data.revision,
      objective: task.intent.data.objective,
      status: task.status,
      closure: task.closure,
      progress: task.progress,
      policy: task.policy,
      requirements,
      writer: workspace.data.writer,
    });
  }

  private view(task: TaskRecord): Result<TaskView> {
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const current = captureCandidate(this.store.root, task.intent.data.scope, environment());
    if (!current.ok) return current as Result<never>;
    const requirements = evaluateRequirements(
      task,
      workspace.data,
      this.context.capabilities,
      current.data,
      this.store.root,
      this.context.caller,
    );
    return success(task.revision, workspace.data.revision, {
      task,
      workspace: workspace.data,
      capabilities: this.context.capabilities,
      requirements,
      evidence: evaluateEvidence(task, current.data),
    });
  }

  reconcileResume(
    view: TaskView,
    observations: NativeWorkerObservation[] = [],
  ): Result<ResumeReconciliation> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
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
      if (
        observation.taskId !== view.task.id ||
        observation.expectedRevision !== view.task.revision ||
        observation.expectedWorkspaceRevision !== view.workspace.revision
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
      if (!verified.ok) return verified as Result<never>;
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
      ["running", "cancelling", "unknown"].includes(
        observedStates.get(entry.id) ?? entry.data.state,
      ),
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
    if (!task.ok) return task as Result<never>;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper as Result<never>;
    if (
      (status === "paused" && task.data.status !== "active") ||
      (status === "active" && task.data.status !== "paused")
    )
      return failure("invalid_transition", `cannot transition ${task.data.status} to ${status}`);
    if (status === "active" && input.authorityRefs.length === 0)
      return failure("permission_denied", "resuming a task requires authority references");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
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
      if (!view.ok) return view as Result<never>;
      const current = reconcileResumeContext(view.data);
      if (!current.ok) return current as Result<never>;
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
      if (!validResumeApproval(task.data, workspace.data, input.authorityRefs, this.context))
        return failure("permission_denied", "imported resume requires native destination approval");
      resumeCandidate = current.data.candidate;
    }
    const blocker = this.activeWorkerBlocker(task.data, workspace.data);
    if (blocker) return blocker as Result<never>;
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedTaskRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (workspace, context) => success(context.revision, context.revision, workspace),
      task: (current, context) =>
        success(context.revision, null, {
          ...current,
          status,
          candidates:
            resumeCandidate &&
            !current.candidates.some((candidate) => candidate.id === resumeCandidate!.id)
              ? [...current.candidates, resumeCandidate]
              : current.candidates,
          progress:
            status === "paused" ? { ...current.progress, summary: input.reason } : current.progress,
        }),
    });
    if (!changed.ok) return changed as Result<never>;
    return this.summary(changed.data.task);
  }

  private progress(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper as Result<never>;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot update progress");
    const changed = this.store.mutateTask(
      task.data.id,
      input.expectedRevision,
      (current, context) =>
        success(context.revision, null, { ...current, progress: input.progress }),
      trustedNow(this.context),
    );
    if (!changed.ok) return changed as Result<never>;
    return this.summary(changed.data);
  }

  private revise(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper as Result<never>;
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot be revised");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    if (workspace.data.writer || task.data.workers.some((entry) => entry.data.state !== "stopped"))
      return failure(
        "recovery_required",
        "scope revision requires worker ownership reconciliation",
      );
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedTaskRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (workspace, context) => success(context.revision, context.revision, workspace),
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
    if (!changed.ok) return changed as Result<never>;
    return this.summary(changed.data.task);
  }

  private close(input: any): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    const helper = this.helperTaskGuard(task.data);
    if (!helper.ok) return helper as Result<never>;
    if (task.data.status !== "active" && task.data.status !== "paused")
      return failure("invalid_transition", "closed task cannot be reopened or closed again");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
    const blocker = this.activeWorkerBlocker(task.data, workspace.data);
    if (blocker) return blocker as Result<never>;
    const current = captureCandidate(this.store.root, task.data.intent.data.scope, environment());
    if (!current.ok) return current as Result<never>;
    const withCandidate = current.data;
    const taskForView =
      withCandidate.id === task.data.candidates.at(-1)?.id
        ? task.data
        : { ...task.data, candidates: [...task.data.candidates, withCandidate] };
    const requirements = evaluateRequirements(
      taskForView,
      workspace.data,
      this.context.capabilities,
      withCandidate,
      this.store.root,
      this.context.caller,
    );
    const view = {
      task: taskForView,
      workspace: workspace.data,
      capabilities: this.context.capabilities,
      requirements,
      evidence: evaluateEvidence(taskForView, withCandidate),
    } satisfies TaskView;
    const closure = evaluateClosure(input.outcome, view);
    if (!closure.ok) return closure as Result<never>;
    const changed = this.store.mutateTaskAndWorkspace({
      taskId: task.data.id,
      expectedTaskRevision: input.expectedRevision,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      now: trustedNow(this.context),
      workspace: (value, context) => success(context.revision, context.revision, value),
      task: (value, context) =>
        success(context.revision, null, {
          ...value,
          status: "closed",
          candidates: value.candidates.some((item) => item.id === withCandidate.id)
            ? value.candidates
            : [...value.candidates, withCandidate],
          closure: {
            outcome: closure.data.outcome,
            at: context.now,
            summary: input.summary,
            decisionIds: closure.data.decisionIds,
            evidenceIds: closure.data.evidenceIds,
          },
        }),
    });
    if (!changed.ok) return changed as Result<never>;
    return this.summary(changed.data.task);
  }
}
