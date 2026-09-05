import { realpathSync } from "node:fs";
import {
  failure,
  newId,
  parseOperation,
  success,
  type Assessment,
  type Capability,
  type Caller,
  type Constraint,
  type Entry,
  type Evidence,
  type Policy,
  type Result,
  type TaskRecord,
  type TaskSummary,
  type TaskView,
  type Utc,
} from "./task-contract";
import { diffPolicy, resolvePolicy } from "./policy-resolver";
import { TaskStore } from "./task-store";
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
};

const provenance = (
  context: OperationContext,
  kind: "host_observed" | "agent_reported" = "host_observed",
) => ({
  kind,
  host: context.caller.host,
  session: { kind: "host" as const, host: context.caller.host, handle: context.caller.actor },
  workerId: null,
  receipts: [],
});
const environment = (): CandidateEnvironment => [];
const sameSession = (value: unknown, context: OperationContext): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as any).kind === "host" &&
  (value as any).host === context.caller.host &&
  (value as any).handle === context.caller.actor;

const trustedNow = (context: OperationContext): Utc =>
  typeof context.now === "function" ? context.now() : context.now;

export class WorkitCore {
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

  task(request: unknown): Result<TaskSummary | TaskSummary[] | TaskView> {
    const root = this.contextRootError();
    if (!root.ok) return root as Result<never>;
    const parsed = parseOperation("task", request);
    if (!parsed.ok) return parsed as Result<never>;
    const input = parsed.data as any;
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
        });
      },
      trustedNow(this.context),
    );
    if (!changed.ok) return changed as Result<never>;
    return success(changed.data.revision, null, changed.data.evidence.at(-1)!);
  }

  private resolve(task: TaskRecord, assessment: Assessment): Result<Policy> {
    return resolvePolicy({
      intent: task.intent.data,
      assessment,
      constraints: this.context.constraints,
      prior: {
        decisions: task.decisions.map((entry) => entry.data),
        findings: task.findings.map((entry) => entry.data),
        requirements: task.policy?.requirements ?? [],
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

  private transition(input: any, status: "active" | "paused"): Result<TaskSummary> {
    const task = this.store.readTask(input.taskId);
    if (!task.ok) return task as Result<never>;
    if (
      (status === "paused" && task.data.status !== "active") ||
      (status === "active" && task.data.status !== "paused")
    )
      return failure("invalid_transition", `cannot transition ${task.data.status} to ${status}`);
    if (status === "active" && input.authorityRefs.length === 0)
      return failure("permission_denied", "resuming a task requires authority references");
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
    if (task.data.status === "closed")
      return failure("invalid_transition", "closed task cannot be revised");
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
    if (task.data.status !== "active" && task.data.status !== "paused")
      return failure("invalid_transition", "closed task cannot be reopened or closed again");
    const workspace = this.store.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data) return failure("not_found", "workspace not found");
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
