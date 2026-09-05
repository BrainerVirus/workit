import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  decisionDigest,
  failure,
  refSchema,
  success,
  type Decision,
  type Entry,
  type Id,
  type Provenance,
  type Ref,
  type Result,
  type Revision,
  type TaskRecord,
  type Utc,
} from "./task-contract";
import { TaskStore } from "./task-store";
import { scopeCovers } from "./task-evaluation";

export type NativeAuthorityContext = {
  provenance: Provenance;
  now: Utc;
};

export type ReserveActionInput = {
  store: TaskStore;
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  binding?: Decision["binding"];
  step?: string;
  steps?: string[];
  native?: NativeAuthorityContext;
};

export type ActionReservation = {
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  taskRevision: Revision;
  workspaceRevision: Revision;
  completedSteps: string[];
  remainingSteps: string[];
};

export type SettleActionInput = {
  store: TaskStore;
  taskId: Id;
  decisionId: Id;
  actionRef: Ref;
  taskRevision: Revision;
  workspaceRevision: Revision;
  outcome: "succeeded" | "not_started" | "unknown";
  nativeEvidence?: boolean;
  evidenceRefs?: Ref[];
  step?: string;
  completedSteps?: string[];
  native?: NativeAuthorityContext;
};

type Workflow = { steps: string[]; completed: string[] };
const workflows = new Map<string, Workflow>();

const scopeEqual = (
  left: Decision["binding"]["scope"],
  right: Decision["binding"]["scope"],
): boolean => canonicalJson(left) === canonicalJson(right);

const workflowKey = (taskId: Id, decisionId: Id) => `${taskId}:${decisionId}`;
const parseSteps = (content: string): string[] => {
  try {
    const value = JSON.parse(content) as { steps?: unknown };
    return Array.isArray(value.steps) && value.steps.every((step) => typeof step === "string")
      ? value.steps
      : [];
  } catch {
    return [];
  }
};

const decisionMatches = (
  entry: Entry<Decision>,
  purpose: Decision["purpose"],
  binding: Decision["binding"],
): boolean => {
  const decision = entry.data;
  return (
    binding.taskId === decision.binding.taskId &&
    binding.workspaceId === decision.binding.workspaceId &&
    decision.purpose === purpose &&
    decision.response === "approved" &&
    decision.revoked === null &&
    (purpose !== "action" || decision.consumption === null) &&
    decision.digest === decisionDigest(decision) &&
    scopeEqual(decision.binding.scope, binding.scope) &&
    canonicalJson(decision.binding) === canonicalJson(binding)
  );
};

/** Return only still-valid, approved decisions for the exact requested binding. */
export function applicableDecision(
  task: TaskRecord,
  purpose: Decision["purpose"],
  binding: Decision["binding"],
): Decision[] {
  if (binding.taskId !== task.id || binding.workspaceId !== task.workspaceId) return [];
  return task.decisions
    .filter((entry) => decisionMatches(entry, purpose, binding))
    .map((entry) => entry.data);
}

const digestBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const verifyContentRefs = (store: TaskStore, binding: Decision["binding"]): Result<null> => {
  for (const reference of binding.contentRefs) {
    if (reference.kind !== "file") continue;
    if (!reference.digest)
      return failure("invalid_input", "document references require a byte digest");
    const target = path.resolve(store.root, reference.path);
    if (target !== store.root && !target.startsWith(`${store.root}${path.sep}`))
      return failure("invalid_input", "document reference escapes checkout");
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink())
        return failure("invalid_input", "document reference is not a regular file");
      if (digestBytes(fs.readFileSync(target)) !== reference.digest)
        return failure("permission_denied", "approved document bytes have changed");
    } catch {
      return failure("permission_denied", "approved document is unavailable");
    }
  }
  return success(null, null, null);
};

const validateAction = (
  store: TaskStore,
  task: TaskRecord,
  workspaceId: Id,
  input: ReserveActionInput,
): Result<{ entry: Entry<Decision>; workflow: Workflow }> => {
  if (task.status !== "active")
    return failure("invalid_transition", "only active tasks can authorize actions");
  if (!refSchema.safeParse(input.actionRef).success)
    return failure("invalid_input", "action reference is invalid");
  const entry = task.decisions.find((candidate) => candidate.id === input.decisionId);
  if (!entry) return failure("not_found", "decision not found");
  const decision = entry.data;
  if (decision.purpose !== "action")
    return failure("permission_denied", "decision is not an action approval");
  if (decision.response !== "approved")
    return failure("permission_denied", "decision was rejected");
  if (decision.revoked) return failure("permission_denied", "decision is revoked");
  if (decision.digest !== decisionDigest(decision))
    return failure("permission_denied", "decision binding is invalid");
  if (decision.binding.taskId !== task.id || decision.binding.workspaceId !== workspaceId)
    return failure("permission_denied", "decision task or workspace binding is invalid");
  if (input.binding && canonicalJson(input.binding) !== canonicalJson(decision.binding))
    return failure("permission_denied", "action binding does not match the approved decision");
  const content = verifyContentRefs(store, decision.binding);
  if (!content.ok) return content as Result<never>;
  const requestedSteps = input.steps ?? parseSteps(decision.binding.approvedContent);
  if (
    requestedSteps.some((step) => !step || typeof step !== "string") ||
    new Set(requestedSteps).size !== requestedSteps.length
  )
    return failure("invalid_input", "bounded action steps must be unique and non-empty");
  const workflow = workflows.get(workflowKey(task.id, input.decisionId)) ?? {
    steps: requestedSteps,
    completed: [],
  };
  if (
    workflow.steps.length &&
    requestedSteps.length &&
    canonicalJson(workflow.steps) !== canonicalJson(requestedSteps)
  )
    return failure("permission_denied", "bounded action scope changed");
  return success(null, null, { entry, workflow });
};

export function reserveAction(input: ReserveActionInput): Result<ActionReservation> {
  if (!input.store || !input.expectedRevision || !input.expectedWorkspaceRevision)
    return failure("invalid_input", "action reservation preconditions are required");
  const changed = input.store.mutateTask(
    input.taskId,
    input.expectedRevision,
    (current, mutation) => {
      const workspace = input.store.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
      if (!workspace.data) return failure("not_found", "workspace not found");
      if (workspace.data.revision !== input.expectedWorkspaceRevision)
        return failure("revision_conflict", "workspace revision does not match", {
          expectedWorkspaceRevision: input.expectedWorkspaceRevision,
          actualWorkspaceRevision: workspace.data.revision,
        });
      const valid = validateAction(input.store, current, workspace.data.id, input);
      if (!valid.ok) return valid as Result<never>;
      const { entry, workflow } = valid.data;
      const existing = entry.data.consumption;
      if (existing?.state === "uncertain")
        return failure("external_outcome_unknown", "previous action outcome is unknown", {
          operation: "reserve_action",
          outcome: "unknown",
        });
      if (existing?.state === "consumed")
        return failure("permission_denied", "action approval is consumed");
      const priorWorkflow = workflows.get(workflowKey(current.id, input.decisionId));
      if (
        existing?.state === "reserved" &&
        (!priorWorkflow || priorWorkflow.completed.length === 0)
      )
        return failure("permission_denied", "action approval is already reserved");
      const requestedStep = input.step ?? workflow.steps[workflow.completed.length];
      if (
        workflow.steps.length &&
        (!requestedStep || requestedStep !== workflow.steps[workflow.completed.length])
      )
        return failure(
          "permission_denied",
          "action step is outside the approved remaining workflow",
        );
      if (requestedStep && workflow.completed.includes(requestedStep))
        return failure("permission_denied", "action step was already completed");
      const nextWorkflow = workflow.steps.length
        ? { ...workflow, completed: [...workflow.completed] }
        : workflow;
      workflows.set(workflowKey(current.id, input.decisionId), nextWorkflow);
      const nextDecision = {
        ...entry.data,
        consumption: { state: "reserved" as const, at: mutation.now, actionRef: input.actionRef },
      };
      return success(mutation.revision, null, {
        ...current,
        decisions: current.decisions.map((candidate) =>
          candidate.id === input.decisionId ? { ...candidate, data: nextDecision } : candidate,
        ),
      });
    },
    input.native?.now,
  );
  if (!changed.ok) return changed as Result<never>;
  const workspace = input.store.readWorkspace();
  if (!workspace.ok || !workspace.data)
    return failure("recovery_required", "workspace disappeared after reservation");
  const entry = changed.data.decisions.find((candidate) => candidate.id === input.decisionId);
  if (!entry) return failure("recovery_required", "reserved decision disappeared");
  const workflow = workflows.get(workflowKey(input.taskId, input.decisionId)) ?? {
    steps: [],
    completed: [],
  };
  return success(changed.data.revision, workspace.data.revision, {
    taskId: input.taskId,
    decisionId: input.decisionId,
    actionRef: input.actionRef,
    taskRevision: changed.data.revision,
    workspaceRevision: workspace.data.revision,
    completedSteps: [...workflow.completed],
    remainingSteps: workflow.steps.slice(workflow.completed.length),
  });
}

export function settleAction(input: SettleActionInput): Result<Entry<Decision>> {
  if (!input.store || !input.taskRevision || !input.workspaceRevision)
    return failure("invalid_input", "action settlement preconditions are required");
  if (!refSchema.safeParse(input.actionRef).success)
    return failure("invalid_input", "action reference is invalid");
  if (
    input.outcome === "not_started" &&
    input.nativeEvidence !== true &&
    !input.evidenceRefs?.length
  )
    return failure("permission_denied", "not_started requires native evidence");
  if (input.evidenceRefs?.some((reference) => !refSchema.safeParse(reference).success))
    return failure("invalid_input", "native settlement evidence is invalid");
  let outcomeResult: Result<Entry<Decision>> | null = null;
  const changed = input.store.mutateTask(
    input.taskId,
    input.taskRevision,
    (current, mutation) => {
      const workspace = input.store.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
      if (!workspace.data) return failure("not_found", "workspace not found");
      if (workspace.data.revision !== input.workspaceRevision)
        return failure("revision_conflict", "workspace revision does not match", {
          expectedWorkspaceRevision: input.workspaceRevision,
          actualWorkspaceRevision: workspace.data.revision,
        });
      const entry = current.decisions.find((candidate) => candidate.id === input.decisionId);
      if (!entry) return failure("not_found", "decision not found");
      if (entry.data.purpose !== "action" || entry.data.digest !== decisionDigest(entry.data))
        return failure("permission_denied", "decision binding is invalid");
      if (entry.data.consumption?.state === "uncertain")
        return failure("external_outcome_unknown", "previous action outcome is unknown", {
          operation: "settle_action",
          outcome: "unknown",
        });
      if (entry.data.consumption?.state !== "reserved")
        return failure("permission_denied", "action is not reserved");
      if (canonicalJson(entry.data.consumption.actionRef) !== canonicalJson(input.actionRef))
        return failure("permission_denied", "settlement reference does not match reservation");
      const key = workflowKey(input.taskId, input.decisionId);
      const workflow = workflows.get(key) ?? { steps: [], completed: [] };
      const currentStep = input.step ?? workflow.steps[workflow.completed.length];
      if (
        workflow.steps.length &&
        (!currentStep || currentStep !== workflow.steps[workflow.completed.length])
      )
        return failure("permission_denied", "settlement step is outside the approved workflow");
      if (input.outcome === "unknown") {
        outcomeResult = failure("external_outcome_unknown", "external action outcome is unknown", {
          operation: "settle_action",
          outcome: "unknown",
        });
        const uncertain = {
          ...entry.data,
          consumption: { ...entry.data.consumption, state: "uncertain" as const, at: mutation.now },
        };
        workflows.delete(key);
        return success(mutation.revision, null, {
          ...current,
          decisions: current.decisions.map((candidate) =>
            candidate.id === input.decisionId ? { ...candidate, data: uncertain } : candidate,
          ),
        });
      }
      if (input.outcome === "not_started") {
        const released = { ...entry.data, consumption: null };
        workflows.delete(key);
        return success(mutation.revision, null, {
          ...current,
          decisions: current.decisions.map((candidate) =>
            candidate.id === input.decisionId ? { ...candidate, data: released } : candidate,
          ),
        });
      }
      if (currentStep) workflow.completed.push(currentStep);
      const complete = !workflow.steps.length || workflow.completed.length >= workflow.steps.length;
      workflows.set(key, workflow);
      const settled = {
        ...entry.data,
        consumption: complete
          ? { ...entry.data.consumption, state: "consumed" as const, at: mutation.now }
          : entry.data.consumption,
      };
      if (complete) workflows.delete(key);
      const next = {
        ...current,
        decisions: current.decisions.map((candidate) =>
          candidate.id === input.decisionId ? { ...candidate, data: settled } : candidate,
        ),
      };
      if (!complete) {
        outcomeResult = success(mutation.revision, input.workspaceRevision, {
          ...entry,
          data: settled,
        });
      }
      return success(mutation.revision, null, next);
    },
    input.native?.now,
  );
  if (!changed.ok) return changed as Result<never>;
  const entry = changed.data.decisions.find((candidate) => candidate.id === input.decisionId);
  if (!entry) return failure("recovery_required", "settled decision disappeared");
  if (outcomeResult) return outcomeResult;
  return success(changed.data.revision, input.workspaceRevision, entry);
}

export const bindingCovers = scopeCovers;
export const verifyDecisionContent = verifyContentRefs;
