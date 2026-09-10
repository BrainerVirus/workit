import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export {
  SCHEMA_VERSION,
  POLICY_VERSION,
  OPERATION_FAMILIES,
  operationSchemas,
  operationJsonSchema,
  boundedOperationJsonSchema,
  OPERATION_SCHEMA_DEPTH,
  canonicalFieldsDescription,
  parseOperation,
  success,
  failure,
  canonicalJson,
  sha256,
  newId,
  newRevision,
  decisionDigest,
  candidateDigest,
  requirementId,
} from "./core/task-contract";
export type {
  OperationFamily,
  OperationRequest,
  TaskStartRequest,
  Caller,
  Scope,
  Ref,
  Assessment,
  Dimension,
  Requirement,
  Constraint,
  Intent,
  Progress,
  Policy,
  Candidate,
  Capability,
  Entry,
  EvidenceEvaluation,
  Evidence,
  Outcome,
  Decision,
  Finding,
  Assignment,
  WorkerReport,
  Worker,
  TaskRecord,
  WorkspaceRecord,
  TaskView,
  TaskSummary,
  ExportBundle,
  Result as ContractResult,
} from "./core/task-contract";
export { TaskStore } from "./core/task-store";
export type { MetadataLock, ProcessEvidence, RecoveryInput } from "./core/task-store";
export { compactTaskContext, reconcileResume } from "./core/task-context";
export type {
  CompactTaskContext,
  ResumeObservation,
  ResumeObservationInput,
  ResumeReconciliation,
} from "./core/task-context";
export { METHODS, invariantBootstrap, selectMethods } from "./core/methods";
export type { MethodId, SelectedMethod } from "./core/methods";
export { applicableDecision, reserveAction, settleAction, reconcileAction } from "./core/authority";
export {
  createAuthorizedExternalActionRunner,
  runAuthorizedExternalAction,
} from "./core/external-action";
export type {
  AuthorizedActionInput,
  ExternalActionResult,
  ExternalActionRunner,
  ExternalActionEffect,
  ExternalActionBinding,
  NativeExternalActionObservation,
  ExternalActionRequest,
  ExternalActionOperation,
} from "./core/external-action";
export {
  approvedExternalAction,
  externalActionState,
  priorExternalAction,
  externalActionRef,
  externalActionDescriptor,
  externalActionHelp,
  externalActionRequest,
  matchesNativeExternalAction,
  nativeExternalActionObservation,
  readNativeExternalActionObservation,
} from "./core/external-action";
export type {
  ActionReservation,
  NativeAuthorityContext,
  NativeAuthorityVerifier,
  NativeActionVerification,
  NativeReconciliationVerification,
  NativeDecisionVerification,
  ReserveActionInput,
  SettleActionInput,
  ReconcileActionInput,
} from "./core/authority";
export {
  captureCandidate,
  evaluateEvidence,
  evaluateRequirements,
  evaluateClosure,
} from "./core/task-evaluation";
export type { CandidateEnvironment, ClosureEvaluation } from "./core/task-evaluation";
export { WorkitCore } from "./core/task-engine";
export type { OperationContext } from "./core/task-engine";
export { assertProductWriteAllowed } from "./core/workers";
export type {
  CallerContext,
  HostSession,
  NativeWorkerDispatchVerification,
  NativeWorkerObservation,
  NativeWorkerVerification,
  NativeWorkerVerifier,
  ProductWriteInput,
  WorkerDispatch,
  WorkerDispatchCommit,
  WorkerDispatchRequest,
  WorkerDispatchStage,
} from "./core/workers";

export type Result<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: T | null; error: string };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data, error: null });
export const fail = <T = never>(error: string, data: T | null = null): Result<T> => ({
  ok: false,
  data,
  error,
});

const revision = /^[A-Za-z0-9@][A-Za-z0-9@._/~^{}-]*$/;

export function gitRevisionParts(value: string): string[] {
  if (!value || value.startsWith("-") || /[\s\\'"`$;|&<>]/.test(value)) {
    throw new Error("invalid Git revision or range");
  }
  const separator = value.includes("...") ? "..." : value.includes("..") ? ".." : null;
  const parts = separator ? value.split(separator) : [value];
  if (parts.length > 2 || parts.some((part) => !revision.test(part))) {
    throw new Error("invalid Git revision or range");
  }
  return parts;
}

export function resolveGitRevision(root: string, value: string): void {
  for (const part of gitRevisionParts(value)) {
    const result = run(root, "git", [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${part}^{commit}`,
    ]);
    if (result.exitCode !== 0) throw new Error(`invalid Git revision or range: ${value}`);
  }
}

export function resolveInside(root: string, candidate: string): string {
  const base = realpathSync(root);
  const target = path.resolve(base, candidate);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("path must stay inside repository root");
  }

  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalAncestor = realpathSync(ancestor);
  if (canonicalAncestor !== base && !canonicalAncestor.startsWith(base + path.sep)) {
    throw new Error("path must stay inside repository root");
  }
  return target;
}

export function run(
  root: string,
  executable: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const cwd = realpathSync(root);
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    cwd,
  };
}
