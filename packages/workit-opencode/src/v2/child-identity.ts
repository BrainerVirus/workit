// An OpenCode child (subagent) session that its lead never bound to a Workit
// worker still has a host-derived identity, `<lead>:<child>`: the same id its
// shell carries as WORKIT_SESSION_ID (shell-session.ts). Under it the child
// may record what a reviewer or verifier produces, evidence and findings, on
// a task that already exists, so its records are told apart from the lead's.
// Everything else (task lifecycle, workers, decisions, policy) stays with a
// validated worker or the lead.
import type { OperationFamily, TaskStore } from "@brainervirus/workit-core/src/core";

const CHILD_RECORDS: Partial<Record<OperationFamily, ReadonlySet<string>>> = {
  evidence: new Set(["record"]),
  finding: new Set(["record"]),
};

const fields = (input: unknown): { action?: unknown; taskId?: unknown } =>
  typeof input === "object" && input !== null ? input : {};

/** Whether a child without a worker may run this family call under its derived identity. */
export const childMayRecord = (family: OperationFamily | null, input: unknown): boolean => {
  const action = fields(input).action;
  return (
    family !== null && typeof action === "string" && CHILD_RECORDS[family]?.has(action) === true
  );
};

/** A child without a worker may read the bounded task summary; the engine refuses the rest. */
export const childMayInspect = (family: OperationFamily | null, input: unknown): boolean =>
  family === "task" && fields(input).action === "inspect";

/** A child never creates a task: without a taskId the branch must already have one. */
export const childTaskMissing = (store: TaskStore, input: unknown): boolean => {
  if (fields(input).taskId !== undefined) return false;
  const report = store.keyReport();
  return !report.ok || report.data.bound.length === 0;
};

export const childDenial = (identity: string): string =>
  `OpenCode child session has no validated Workit worker: as ${identity} it may only inspect the task summary (workit_task action "inspect") or record evidence or findings (workit_evidence/workit_finding action "record") on an existing task; for anything else the lead assigns it a worker with workit_worker before launching it`;
