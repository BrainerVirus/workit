import {
  POLICY_VERSION,
  failure,
  sha256,
  success,
  type Candidate,
  type Decision,
  type Provenance,
  type Progress,
  type Ref,
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

export function reconcileResume(
  view: TaskView,
  observations: ResumeObservationInput[] = [],
): Result<ResumeReconciliation> {
  if (observations.length > 0)
    return failure("permission_denied", "worker observations require native host verification");
  const candidate = captureCandidate(view.workspace.root, view.task.intent.data.scope, []);
  if (!candidate.ok) return candidate as Result<never>;
  const staleEvidenceIds = evaluateEvidence(view.task, candidate.data)
    .filter((entry) => entry.status === "stale")
    .map((entry) => entry.evidenceId);
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
    workerUpdates: [],
    blockers,
    reassessmentRequired: view.task.policy?.policyVersion !== POLICY_VERSION,
  });
}

type CompactReference = { kind: Ref["kind"] } & Partial<
  Pick<Extract<Ref, { kind: "file" }>, "path">
> &
  Partial<Pick<Extract<Ref, { kind: "record" }>, "collection" | "id">>;
type CompactDecision = {
  id: string;
  purpose: Decision["purpose"];
  status: Decision["response"];
  digest: string;
  references: CompactReference[];
};
export type CompactTaskContext = {
  objective: string;
  status: TaskView["task"]["status"];
  decisions: CompactDecision[];
  gaps: string[];
  nextAction: string | null;
};

const COMPACT_MAX_BYTES = 4096;
const COMPACT_MAX_ITEMS = 8;
const COMPACT_TEXT_BYTES = 128;
const compactText = (value: string | null, limit: number): string | null =>
  value === null ? null : value.slice(0, limit);
const compactReference = (ref: Ref): CompactReference => {
  if (ref.kind === "file") return { kind: "file", path: ref.path.slice(0, COMPACT_TEXT_BYTES) };
  if (ref.kind === "record")
    return {
      kind: "record",
      collection: ref.collection,
      id: ref.id,
    };
  return { kind: ref.kind };
};

export function compactTaskContext(view: TaskView): string {
  const decisions: CompactDecision[] = view.task.decisions
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, COMPACT_MAX_ITEMS)
    .map((entry) => ({
      id: entry.id,
      purpose: entry.data.purpose,
      status: entry.data.response,
      digest: entry.data.digest,
      references: entry.data.binding.contentRefs.slice(0, 1).map(compactReference),
    }));
  const gaps = Array.from(
    new Set([
      ...view.evidence
        .filter((entry) => entry.status === "stale")
        .map((entry) => `stale evidence: ${entry.evidenceId}`),
      ...view.requirements
        .filter((entry) => entry.status !== "satisfied")
        .map((entry) => entry.reason),
      ...view.task.progress.blockers.map((entry) => entry.reason),
    ]),
  )
    .sort()
    .slice(0, COMPACT_MAX_ITEMS)
    .map((gap) => compactText(gap, COMPACT_TEXT_BYTES)!);
  const context: CompactTaskContext = {
    objective: compactText(view.task.intent.data.objective, COMPACT_TEXT_BYTES) ?? "",
    status: view.task.status,
    decisions,
    gaps,
    nextAction: compactText(view.task.progress.nextAction, COMPACT_TEXT_BYTES),
  };
  let encoded = JSON.stringify(context);
  while (encoded.length > COMPACT_MAX_BYTES && (context.decisions.length || context.gaps.length)) {
    if (context.gaps.length) context.gaps.pop();
    else context.decisions.pop();
    encoded = JSON.stringify(context);
  }
  if (encoded.length > COMPACT_MAX_BYTES) {
    context.objective = compactText(context.objective, 64) ?? "";
    context.nextAction = compactText(context.nextAction, 64);
    encoded = JSON.stringify(context);
  }
  return encoded;
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
