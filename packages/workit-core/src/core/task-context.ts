import { isUncertainWorker } from "./workers";
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
import { captureCandidate, evaluateEvidence, treeFreshness } from "./task-evaluation";
import { selectMethods, type SelectedMethod } from "./methods";
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
  if (!candidate.ok) return candidate;
  const staleEvidenceIds = evaluateEvidence(
    view.task,
    candidate.data,
    treeFreshness(view.workspace.root),
  )
    .filter((entry) => entry.status === "stale")
    .map((entry) => entry.evidenceId);
  const blockers = [...view.task.progress.blockers];
  if (view.task.workers.some((entry) => isUncertainWorker(entry.data.state)))
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
  choice: string;
  references: CompactReference[];
  /** Where an inherited decision was recorded ("branch develop"); absent for the task's own. */
  origin?: string;
};
type CompactMethod = Pick<SelectedMethod, "id" | "assurance"> & { reason: string };
/** Decisions of a task the current one inherits from (its base branch's task). */
export type InheritedDecisions = {
  origin: string;
  taskId: string;
  decisions: TaskView["task"]["decisions"];
};
export type CompactTaskContext = {
  objective: string;
  /** Null when the checkout has no task yet and only inherited decisions apply. */
  status: TaskView["task"]["status"] | null;
  decisions: CompactDecision[];
  methods: CompactMethod[];
  gaps: string[];
  nextAction: string | null;
};

const COMPACT_MAX_BYTES = 4096;
const COMPACT_MAX_ITEMS = 8;
const COMPACT_TEXT_BYTES = 128;
const sensitiveUrl = /\bhttps?:\/\/[^/\s:@]+:[^@\s]+@/gi;
const sensitiveValue =
  /(?:token|secret|password|passwd|api[-_ ]?key|private[-_ ]?key|authorization)\s*[:=]\s*(?:bearer\s+)?\S+|\bbearer\s+\S+/gi;
const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const compactText = (value: string | null, limit: number): string | null =>
  value === null
    ? null
    : value
        .replace(privateKey, "<redacted-private-key>")
        .replace(sensitiveUrl, "<redacted-url>")
        .replace(sensitiveValue, (match) => {
          const separator = match.search(/[:=]/u);
          if (separator >= 0) return `${match.slice(0, separator)}=<redacted>`;
          const space = match.search(/\s/u);
          return `${match.slice(0, space)} <redacted>`;
        })
        .slice(0, limit);
const compactBytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const compactTimestamp = (value: Utc): string =>
  `${value.slice(0, 19)}.${value.slice(20, -1).padEnd(9, "0")}`;
const compactDecisionChoice = (entry: TaskView["task"]["decisions"][number]): string | null => {
  const stated = entry.data.binding.statedChoice?.text;
  const approved = entry.data.response === "approved" ? entry.data.binding.presented : "";
  const source = stated?.trim() || approved.trim() || null;
  return compactText(source, COMPACT_TEXT_BYTES);
};
const compactReference = (ref: Ref): CompactReference => {
  if (ref.kind === "file")
    return {
      kind: "file",
      path: compactText(ref.path, COMPACT_TEXT_BYTES) ?? "",
    };
  if (ref.kind === "record")
    return {
      kind: "record",
      collection: ref.collection,
      id: ref.id,
    };
  return { kind: ref.kind };
};

type TaskDecision = TaskView["task"]["decisions"][number];
const newestDecisionFirst = (left: TaskDecision, right: TaskDecision): number => {
  const leftAt = compactTimestamp(left.recordedAt);
  const rightAt = compactTimestamp(right.recordedAt);
  if (leftAt !== rightAt) return leftAt > rightAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};
/**
 * The task's own decisions (newest first), then the live (unrevoked) ones it
 * inherits (origin set), at most COMPACT_MAX_ITEMS.
 */
const compactDecisions = (
  sources: Array<{ origin: string | null; taskId: string; decisions: TaskDecision[] } | null>,
): CompactDecision[] =>
  sources
    .flatMap((source) =>
      source
        ? source.decisions
            .filter((entry) => source.origin === null || entry.data.revoked === null)
            .toSorted(newestDecisionFirst)
            .map((entry) => ({
              id: entry.id,
              purpose: entry.data.purpose,
              status: entry.data.response,
              digest: entry.data.digest,
              choice:
                compactDecisionChoice(entry) ||
                `task.inspect taskId=${source.taskId} view=full; decision=${entry.id}`,
              references: entry.data.binding.contentRefs.slice(0, 1).map(compactReference),
              // Undefined (dropped from the JSON) for the task's own decisions.
              origin: source.origin ?? undefined,
            }))
        : [],
    )
    .slice(0, COMPACT_MAX_ITEMS);

/**
 * The compact context of `view`'s task plus the decisions it inherits; with
 * a null `view` (the branch has no task of its own yet) only the inherited
 * decisions. Stale evidence is one counted gap with the command that lists it.
 */
export function compactTaskContext(
  view: TaskView | null,
  inherited: InheritedDecisions | null = null,
): string {
  const decisions = compactDecisions([
    view && { origin: null, taskId: view.task.id, decisions: view.task.decisions },
    inherited,
  ]);
  const methods: CompactMethod[] = view?.task.policy
    ? selectMethods(view.task.policy, view.capabilities).map((method) => ({
        id: method.id,
        assurance: method.assurance,
        reason: compactText(method.reason, COMPACT_TEXT_BYTES) ?? "",
      }))
    : [];
  const stale = view?.evidence.filter((entry) => entry.status === "stale").length;
  const gaps = Array.from(
    new Set([
      ...(stale
        ? [`stale evidence: ${stale}; workit task inspect --task ${view.task.id} --view full`]
        : []),
      ...(view?.requirements ?? [])
        .filter((entry) => entry.status !== "satisfied")
        .map((entry) => entry.reason),
      ...(view?.task.progress.blockers ?? []).map((entry) => entry.reason),
    ]),
  )
    .toSorted()
    .slice(0, COMPACT_MAX_ITEMS)
    .map((gap) => compactText(gap, COMPACT_TEXT_BYTES)!);
  const context: CompactTaskContext = {
    objective: view
      ? (compactText(view.task.intent.data.objective, COMPACT_TEXT_BYTES) ?? "")
      : "no task on this branch yet",
    status: view?.task.status ?? null,
    decisions,
    methods,
    gaps,
    nextAction: compactText(view?.task.progress.nextAction ?? null, COMPACT_TEXT_BYTES),
  };
  let encoded = JSON.stringify(context);
  while (
    compactBytes(encoded) > COMPACT_MAX_BYTES &&
    (context.decisions.length || context.methods.length || context.gaps.length)
  ) {
    if (context.gaps.length) context.gaps.pop();
    else if (context.decisions.length) context.decisions.pop();
    else context.methods.pop();
    encoded = JSON.stringify(context);
  }
  if (compactBytes(encoded) > COMPACT_MAX_BYTES) {
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
