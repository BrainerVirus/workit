import {
  POLICY_VERSION,
  canonicalJson,
  failure,
  sha256,
  success,
  type Candidate,
  type Decision,
  type Provenance,
  type Progress,
  type Result,
  type TaskView,
  type Utc,
} from "./task-contract";
import { captureCandidate, evaluateEvidence } from "./task-evaluation";
import type { NativeWorkerObservation } from "./workers";

export type ResumeObservation = {
  observation: NativeWorkerObservation;
  authority: Provenance | null;
};
export type ResumeObservationInput = ResumeObservation | NativeWorkerObservation;

export type ResumeReconciliation = {
  candidate: Candidate;
  staleEvidenceIds: string[];
  workerUpdates: NativeWorkerObservation[];
  blockers: Progress["blockers"];
  reassessmentRequired: boolean;
};

const importedAuthority = (value: ResumeObservation, view: TaskView): boolean => {
  const authority = value.authority;
  const observation = value.observation;
  return (
    authority !== null &&
    authority.kind === "host_observed" &&
    authority.workerId === observation.workerId &&
    canonicalJson(authority.session) === canonicalJson(observation.session) &&
    (authority.session === null ||
      (observation.session !== null && authority.host === observation.session.host)) &&
    authority.receipts.length > 0 &&
    view.task.workers.some((entry) => entry.id === observation.workerId)
  );
};

export function reconcileResume(
  view: TaskView,
  observations: ResumeObservationInput[] = [],
): Result<ResumeReconciliation> {
  const candidate = captureCandidate(view.workspace.root, view.task.intent.data.scope, []);
  if (!candidate.ok) return candidate as Result<never>;
  const staleEvidenceIds = evaluateEvidence(view.task, candidate.data)
    .filter((entry) => entry.status === "stale")
    .map((entry) => entry.evidenceId);
  const workerUpdates: NativeWorkerObservation[] = [];
  for (const raw of observations) {
    const value: ResumeObservation =
      "authority" in raw
        ? raw
        : {
            observation: raw,
            authority: null,
          };
    if (!importedAuthority(value, view))
      return failure("permission_denied", "worker observation was not attested");
    if (
      value.observation.taskId !== view.task.id ||
      value.observation.expectedRevision !== view.task.revision ||
      value.observation.expectedWorkspaceRevision !== view.workspace.revision
    )
      return failure("revision_conflict", "worker observation is stale");
    workerUpdates.push(value.observation);
  }
  const blockers = [...view.task.progress.blockers];
  if (
    view.task.workers.some((entry) =>
      ["running", "cancelling", "unknown"].includes(entry.data.state),
    )
  )
    blockers.push({
      reason: "worker state requires reconciliation",
      dependentAction: "resume",
      refs: [],
    });
  return success(null, null, {
    candidate: candidate.data,
    staleEvidenceIds,
    workerUpdates,
    blockers,
    reassessmentRequired: view.task.policy?.policyVersion !== POLICY_VERSION,
  });
}

type CompactDecision = { purpose: Decision["purpose"]; content: string };
export type CompactTaskContext = {
  objective: string;
  status: TaskView["task"]["status"];
  decisions: CompactDecision[];
  gaps: string[];
  nextAction: string | null;
};

export function compactTaskContext(view: TaskView): string {
  const decisions: CompactDecision[] = view.task.decisions.map((entry) => ({
    purpose: entry.data.purpose,
    content: entry.data.binding.approvedContent,
  }));
  const gaps = Array.from(
    new Set([
      ...view.requirements
        .filter((entry) => entry.status !== "satisfied")
        .map((entry) => entry.reason),
      ...view.task.progress.blockers.map((entry) => entry.reason),
    ]),
  );
  return JSON.stringify({
    objective: view.task.intent.data.objective,
    status: view.task.status,
    decisions,
    gaps,
    nextAction: view.task.progress.nextAction,
  } satisfies CompactTaskContext);
}

export const exportDigest = (bundle: {
  schemaVersion: 1;
  exportedAt: Utc;
  sourceWorkspaceId: string;
  task: unknown;
}): string =>
  sha256({
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    sourceWorkspaceId: bundle.sourceWorkspaceId,
    task: bundle.task,
  });
