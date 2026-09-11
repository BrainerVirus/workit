// Commit message flavors: matchers plus history detection for the git.commit
// gate. Detection is deterministic (majority vote, no LLM): sample recent
// subjects, classify each, take the majority above threshold, else null so the
// caller falls back to the configured preset.

export type CommitFlavor = "conventional" | "gitmoji" | "ticket-prefix" | "freeform";
export type CommitFlavorPreset = CommitFlavor | "custom" | "auto";

const CONVENTIONAL_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?(!)?: .+/;
const TICKET_RE = /^[A-Z]{2,}-\d+\b/;
const GITMOJI_RE = /^\p{Extended_Pictographic}/u;

export const matchCommitFlavor = (
  message: string,
  flavor: CommitFlavorPreset,
  pattern?: string,
): boolean => {
  const subject = message.split("\n", 1)[0] ?? "";
  switch (flavor) {
    case "conventional":
      return CONVENTIONAL_RE.test(subject);
    case "gitmoji":
      return GITMOJI_RE.test(subject);
    case "ticket-prefix":
      return TICKET_RE.test(subject);
    case "freeform":
      return subject.trim().length > 0;
    case "custom":
      if (!pattern) return false;
      try {
        return new RegExp(pattern).test(subject);
      } catch {
        return false;
      }
    case "auto":
      return subject.trim().length > 0;
  }
};

const DETECTABLE: CommitFlavor[] = ["conventional", "gitmoji", "ticket-prefix"];

export const detectCommitFlavor = (
  subjects: string[],
  threshold = 0.7,
): { flavor: CommitFlavor | null; confidence: number } => {
  if (subjects.length === 0) return { flavor: null, confidence: 0 };
  const votes = new Map<CommitFlavor, number>();
  for (const subject of subjects) {
    const hit = DETECTABLE.find((flavor) => matchCommitFlavor(subject, flavor));
    if (hit) votes.set(hit, (votes.get(hit) ?? 0) + 1);
  }
  let best: CommitFlavor | null = null;
  let count = 0;
  for (const [flavor, votesFor] of votes) {
    if (votesFor > count) {
      best = flavor;
      count = votesFor;
    }
  }
  const confidence = count / subjects.length;
  return best !== null && confidence >= threshold
    ? { flavor: best, confidence }
    : { flavor: null, confidence };
};
