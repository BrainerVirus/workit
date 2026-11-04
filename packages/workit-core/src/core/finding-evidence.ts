// Which evidence resolves a finding (#317), so a refused `finding resolve`
// names what would work instead of only "unrelated" or "requires evidence".
// It mirrors the engine's rules (task-engine.ts findingOnce) as a read-only
// explanation; the engine stays the judge.
//
// fixed:     check or review evidence, result passed, recorded after the
//            finding, still current on the tree (bound to a candidate when
//            the finding names one).
// dismissed: evidence of any kind with result passed or failed, on the
//            finding's candidate (both none, or the same one), that shares a
//            ref with the finding or makes the same claim.
// deferred:  an approved limitation decision covering the finding's scope.
import {
  canonicalJson,
  type Entry,
  type Evidence,
  type Finding,
  type TaskRecord,
} from "./task-contract";

export type ResolveDisposition = "fixed" | "dismissed" | "deferred";

const RULES: Record<ResolveDisposition, string> = {
  fixed:
    "check or review evidence with result passed, recorded after the finding and still current on this tree",
  dismissed:
    "evidence (check, review, investigation or artifact) with result passed or failed, on the finding's candidate, that shares a ref with the finding or repeats its claim",
  deferred:
    "an approved limitation decision (decisionIds) that references an acceptanceAllowed requirement and covers the finding's scope",
};

const sameRef = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const sameCandidate = (finding: Finding, evidence: Evidence): boolean =>
  finding.candidateId === null
    ? (evidence.candidateId ?? null) === null
    : evidence.candidateId === finding.candidateId ||
      evidence.beforeCandidateId === finding.candidateId;

/** Evidence ids in the task that meet the disposition's recorded-shape rule. */
export function matchingEvidence(
  task: Pick<TaskRecord, "evidence">,
  finding: Entry<Finding>,
  disposition: ResolveDisposition,
): string[] {
  if (disposition === "deferred") return [];
  return task.evidence
    .filter((entry) => {
      const data = entry.data;
      if (disposition === "fixed")
        return (
          entry.recordedAt >= finding.recordedAt &&
          data.result === "passed" &&
          (data.kind === "check" || data.kind === "review") &&
          (finding.data.candidateId === null || data.candidateId != null)
        );
      return (
        (data.result === "passed" || data.result === "failed") &&
        sameCandidate(finding.data, data) &&
        (finding.data.refs.some((left) => data.refs.some((right) => sameRef(left, right))) ||
          data.claim === finding.data.claim)
      );
    })
    .map((entry) => entry.id);
}

/**
 * The sentence a refused resolve gains: the evidence the disposition
 * accepts, the ids in this task that fit it, or how to record one.
 */
export function acceptedEvidenceText(
  task: Pick<TaskRecord, "evidence">,
  finding: Entry<Finding>,
  disposition: ResolveDisposition,
): string {
  const accepted = `accepted for ${disposition}: ${RULES[disposition]}`;
  if (disposition === "deferred") return accepted;
  const ids = matchingEvidence(task, finding, disposition);
  if (ids.length) return `${accepted}; evidence in this task that fits: ${ids.join(", ")}`;
  const ref = finding.data.refs[0];
  const refs = ref ? JSON.stringify([ref]) : "[]";
  return `${accepted}; none recorded in this task yet: workit evidence record --payload '{"kind":"${disposition === "fixed" ? "check" : "review"}","claim":${JSON.stringify(finding.data.claim)},"result":"passed","refs":${refs},…}' (or workit check <name> for a check)`;
}
