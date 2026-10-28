// Which configured checks a verdict needs on a head, and whether each has
// fresh evidence there (#509): a local `workit check` run on that exact
// commit, or (where the lane lets CI cover it) a green CI check of that name.
// A focused lane lets CI cover a check; a full lane needs a local run.
import type { ReviewLane } from "./lane";

export type CheckEvidenceStatus = "fresh" | "failing" | "missing";

export type CheckEvidence = {
  name: string;
  status: CheckEvidenceStatus;
  /** Where the fresh (or failing) evidence came from. */
  via: "local" | "ci" | null;
  /** Whether green CI may stand in for a local run at this lane. */
  ciCovers: boolean;
};

export type CheckEvidenceDoc = {
  lane: ReviewLane;
  head: string;
  /** Every configured check the verdict needs; empty for a lane without a verdict. */
  needed: CheckEvidence[];
  /** True when every needed check has fresh evidence (vacuously true when none is needed). */
  satisfied: boolean;
};

export type LocalCheckRow = { name: string; head: string; dirty: boolean; passed: boolean };
export type CiCheck = { name: string; state: "passing" | "failing" | "pending" };

/** The aggregate `check` script repeats the others; it is never asked for on its own. */
const AGGREGATE = "check";

/** The checks a lane's verdict needs, from the configured gate names. */
export function neededChecks(lane: ReviewLane, configured: readonly string[]): string[] {
  if (lane !== "focused" && lane !== "full") return [];
  const names = configured.filter((name) => name !== AGGREGATE);
  return names.length ? names : [...configured];
}

const ciMatch = (ci: CiCheck, name: string): boolean =>
  ci.name.toLowerCase().includes(name.toLowerCase());

export function checkEvidence(input: {
  lane: ReviewLane;
  head: string;
  configured: readonly string[];
  /** Observed `workit check` runs, oldest first. */
  local: readonly LocalCheckRow[];
  ci: readonly CiCheck[];
}): CheckEvidenceDoc {
  const ciCovers = input.lane === "focused";
  const needed = neededChecks(input.lane, input.configured).map((name): CheckEvidence => {
    const last = input.local.findLast(
      (row) => row.name === name && row.head === input.head && !row.dirty,
    );
    if (last?.passed) return { name, status: "fresh", via: "local", ciCovers };
    const ci = input.ci.filter((check) => ciMatch(check, name));
    if (ci.some((check) => check.state === "failing"))
      return { name, status: "failing", via: "ci", ciCovers };
    if (last) return { name, status: "failing", via: "local", ciCovers };
    if (ciCovers && ci.some((check) => check.state === "passing"))
      return { name, status: "fresh", via: "ci", ciCovers };
    return { name, status: "missing", via: null, ciCovers };
  });
  return {
    lane: input.lane,
    head: input.head,
    needed,
    satisfied: needed.every((item) => item.status === "fresh"),
  };
}

/** One line per check for a status render. */
export function evidenceLines(doc: CheckEvidenceDoc): string[] {
  if (!doc.needed.length) return [`evidence: lane ${doc.lane} needs no check run`];
  return [
    `evidence for lane ${doc.lane} on ${doc.head.slice(0, 7)}: ${doc.satisfied ? "complete" : "incomplete"}`,
    ...doc.needed.map(
      (item) =>
        `  ${item.status === "fresh" ? "ok" : "x"} ${item.name}: ${item.status}${item.via ? ` (${item.via})` : item.ciCovers ? " (run it, or green CI covers it)" : " (run workit check " + item.name + " on this head)"}`,
    ),
  ];
}
