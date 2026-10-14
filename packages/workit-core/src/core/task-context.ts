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
const compactDecision = (
  entry: TaskDecision,
  taskId: string,
  origin: string | null,
): CompactDecision => ({
  id: entry.id,
  purpose: entry.data.purpose,
  status: entry.data.response,
  digest: entry.data.digest,
  choice:
    compactDecisionChoice(entry) || `task.inspect taskId=${taskId} view=full; decision=${entry.id}`,
  references: entry.data.binding.contentRefs.slice(0, 1).map(compactReference),
  ...(origin === null ? {} : { origin: compactText(origin, COMPACT_TEXT_BYTES)! }),
});
/**
 * The task's own decisions (newest first), then the live (unrevoked)
 * decisions it inherits, nearest origin first, at most COMPACT_MAX_ITEMS.
 */
const compactDecisions = (
  own: { taskId: string; decisions: TaskDecision[] } | null,
  inherited: InheritedDecisions[],
): CompactDecision[] =>
  [
    ...(own
      ? own.decisions
          .toSorted(newestDecisionFirst)
          .map((entry) => compactDecision(entry, own.taskId, null))
      : []),
    ...inherited.flatMap((source) =>
      source.decisions
        .filter((entry) => entry.data.revoked === null)
        .toSorted(newestDecisionFirst)
        .map((entry) => compactDecision(entry, source.taskId, source.origin)),
    ),
  ].slice(0, COMPACT_MAX_ITEMS);

/** One gap for every stale evidence row, with the one command that lists them. */
const staleEvidenceGap = (count: number, taskId: string): string =>
  `${count} stale evidence ${count === 1 ? "row" : "rows"}; inspect: workit task inspect --task ${taskId} --view full`;

/** Shrink `context` until it fits COMPACT_MAX_BYTES (gaps, then decisions, then methods). */
const encodeBounded = (context: CompactTaskContext): string => {
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
};

/**
 * Compact context for a checkout with no task of its own yet: only the
 * decisions it inherits from the branches it was cut from. Empty string when
 * there are none.
 */
export function compactInheritedContext(label: string, inherited: InheritedDecisions[]): string {
  const decisions = compactDecisions(null, inherited);
  if (decisions.length === 0) return "";
  return encodeBounded({
    objective: compactText(`no task for ${label} yet`, COMPACT_TEXT_BYTES) ?? "",
    status: null,
    decisions,
    methods: [],
    gaps: [],
    nextAction: null,
  });
}

export function compactTaskContext(view: TaskView, inherited: InheritedDecisions[] = []): string {
  const decisions = compactDecisions(
    { taskId: view.task.id, decisions: view.task.decisions },
    inherited,
  );
  const methods: CompactMethod[] = view.task.policy
    ? selectMethods(view.task.policy, view.capabilities).map((method) => ({
        id: method.id,
        assurance: method.assurance,
        reason: compactText(method.reason, COMPACT_TEXT_BYTES) ?? "",
      }))
    : [];
  const stale = view.evidence.filter((entry) => entry.status === "stale").length;
  const gaps = Array.from(
    new Set([
      ...(stale ? [staleEvidenceGap(stale, view.task.id)] : []),
      ...view.requirements
        .filter((entry) => entry.status !== "satisfied")
        .map((entry) => entry.reason),
      ...view.task.progress.blockers.map((entry) => entry.reason),
    ]),
  )
    .toSorted()
    .slice(0, COMPACT_MAX_ITEMS)
    .map((gap) => compactText(gap, COMPACT_TEXT_BYTES)!);
  const context: CompactTaskContext = {
    objective: compactText(view.task.intent.data.objective, COMPACT_TEXT_BYTES) ?? "",
    status: view.task.status,
    decisions,
    methods,
    gaps,
    nextAction: compactText(view.task.progress.nextAction, COMPACT_TEXT_BYTES),
  };
  return encodeBounded(context);
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
