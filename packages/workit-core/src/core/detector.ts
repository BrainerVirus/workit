import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_GAP_MARKER } from "./config-guard";
import { readEffectiveFlowState, type FlowReadResult } from "./flow-state";

export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;

export const detectConfigGapError = (text: string): boolean => text.includes(CONFIG_GAP_MARKER);

// Enforcement-rail detectors: case-insensitive word-boundary heuristics.
// Conservative bias (D-03): require 1+ signal word AND 0 evidence words;
// when any evidence wording appears, do NOT fire.

const COMPLETION_CLAIMS = /\b(?:done|fixed|passing|green|complete|all set)\b/i;
const VERIFICATION_EVIDENCE =
  /\bbun run check\b|\bworkflow_verify\b|\bbun test\b|\bchecks?\s+pass(?:es|ing)?\b|\btests?\s+pass(?:es|ing)?\b/i;

// Claims completion without verification-command evidence in the same text.
export const detectVerificationClaim = (text: string): boolean =>
  COMPLETION_CLAIMS.test(text) && !VERIFICATION_EVIDENCE.test(text);

const IMPLEMENTATION_SIGNALS =
  /\b(?:changed|implemented|implementing|added|refactored|commit(?:ted|s)?|edited)\b/i;
const FAILING_TEST_WORDS =
  /\b(?:failing test|test failed|watch it fail|red-green|tdd|test first)\b/i;

// Implementation signal without a preceding failing-test mention.
export const detectUntestedImplementation = (text: string): boolean =>
  IMPLEMENTATION_SIGNALS.test(text) && !FAILING_TEST_WORDS.test(text);

const IMPLEMENTATION_ACTION =
  /\b(?:implement|add the feature|write the code|create the component|build (?:the )?(?:feature|component|module|command|screen|service))\b/i;
const DESIGN_WORDS =
  /\b(?:design|spec|brainstorm|approved|plan|requested|instruction|as you asked|as you said)\b/i;

// Implementation action without a presented/approved design.
export const detectImplementationWithoutDesign = (text: string): boolean =>
  IMPLEMENTATION_ACTION.test(text) && !DESIGN_WORDS.test(text);

const FIX_SIGNALS = /\b(?:fixed|fix|patch|solved)\b/i;
const ROOT_CAUSE_WORDS =
  /\b(?:root cause|caused by|reproduced|stack trace|investigation|because)\b/i;

// Fix proposal without root-cause evidence.
export const detectFixWithoutRootCause = (text: string): boolean =>
  FIX_SIGNALS.test(text) && !ROOT_CAUSE_WORDS.test(text);

const ACCEPTANCE_SIGNALS = /\b(?:agreed|makes sense|good point|will implement)\b/i;
const REVIEW_VERIFICATION_WORDS =
  /\b(?:verif(?:y|ied)|check(?:ed|ing)?|reproduced|tested|confirmed)\b/i;

// Review acceptance without verification wording.
export const detectBlindReviewAcceptance = (text: string): boolean =>
  ACCEPTANCE_SIGNALS.test(text) && !REVIEW_VERIFICATION_WORDS.test(text);

// Instruction-option detector: a clickable `question` option whose label is an
// instruction to type free text. Clicking such an option returns the label
// literal, not the typed value. Conservative: instruction verb + free-text noun.
export const INSTRUCTION_OPTION_RE =
  /^(type|provide|paste|enter|write|give me)\b.*\b(url|id|issue|text|notes|number)\b/i;

// Accepts the question tool-call input: an array of questions OR { questions: [...] }.
export const detectInstructionOption = (questions: unknown): boolean => {
  const list = Array.isArray(questions)
    ? questions
    : (questions as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return false;
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const options = (q as { options?: unknown }).options;
    if (!Array.isArray(options)) continue;
    for (const opt of options) {
      if (!opt || typeof opt !== "object") continue;
      const label = (opt as { label?: unknown }).label;
      if (typeof label !== "string" || !label) continue;
      if (INSTRUCTION_OPTION_RE.test(label)) return true;
    }
  }
  return false;
};

// Raw delivery: an UNLABELED fenced block carrying doc markers — the agent pasted
// the doc instead of rendering it. Rendered docs keep labeled fences (```mermaid)
// and never match; reminders use angle-bracket blocks, so no false positives.
// Labeled blocks are stripped first so their plain closing fence (```) can't match.
export const detectRawDocDelivery = (text: string): boolean =>
  /^```\s*$/m.test(text.replace(/```\S[^\n]*\r?\n[\s\S]*?```/g, "")) &&
  (text.includes("# Spec") ||
    text.includes("# Plan") ||
    text.includes("**Spec:**") ||
    text.includes("**Branch:**"));

// Interrogative gate: a literal question mark OR explicit interrogative phrases.
// Plain "I want to confirm..." or "the script which runs" must NOT match.
const INTERROGATIVE =
  /[?¿]|which\s+one|choose\s+(?:one|between|among)|do\s+you\s+(?:want|prefer)|want\s+me\s+to/i;

export const detectProseChoices = (text: string): Detection => {
  if (!INTERROGATIVE.test(text)) return null;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const alphaAll = [...text.matchAll(/([a-dA-D])[.)]\s+([^\n]*?)(?=\s+[a-dA-D][.)]\s|$)/g)].map(
    (m) => ({ letter: m[1].toLowerCase(), choice: m[2].trim() }),
  );
  const alphaLines = lines
    .map((l) => /^([a-dA-D])[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ letter: m[1].toLowerCase(), choice: m[2] }));
  const alpha = alphaAll.length >= alphaLines.length ? alphaAll : alphaLines;

  if (alpha.length >= 2) {
    const letters = alpha.map((a) => a.letter);
    const expected = ["a", "b", "c", "d"].slice(0, alpha.length);
    if (letters.every((l, i) => l === expected[i])) {
      return { choices: alpha.map((a) => a.choice), pattern: "alpha" };
    }
  }

  const numericAll = [...text.matchAll(/(\d+)[.)]\s+([^\n]*?)(?=\s+\d+[.)]\s|$)/g)].map((m) => ({
    num: Number(m[1]),
    choice: m[2].trim(),
  }));
  const numericLines = lines
    .map((l) => /^(\d+)[.)]\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ num: Number(m[1]), choice: m[2] }));
  const numeric = numericAll.length >= numericLines.length ? numericAll : numericLines;

  if (numeric.length >= 2) {
    const nums = numeric.map((n) => n.num);
    if (nums.every((n, i) => n === i + 1)) {
      return { choices: numeric.map((n) => n.choice), pattern: "numeric" };
    }
  }

  return null;
};

const stripFences = (text: string): string => {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
};

export const detectBacktickDocRefs = (text: string): string[] | null => {
  const body = stripFences(text);
  const refs = [...body.matchAll(/`docs\/[^`\s]+\.md`/g)].map((m) => m[0]);
  if (!refs.length) return null;
  if (/\[[^\]]+\]\(docs\//.test(body)) return null;
  return refs;
};

// The rail is active-plan detection (CA-11/CA-13): only a flow whose effective
// execution is ACTIVE and subagent-driven is found. The effective read performs
// the legacy compatibility migration (ledgerCompletion-derived, CA-16) and the
// approval-digest reconciliation and PERSISTS any drift/migration reset, so a
// drift-reset or pending/paused/completed flow is excluded after its state is
// rewritten on read; only malformed/unreadable flow.json is excluded without
// ever being rewritten (readFlowStrict rejects it before any write).
export type ActivePlanScan = {
  slugs: string[];
  /**
   * Flows whose effective read FAILED with a transient lock/IO error
   * (flow_concurrent_conflict / flow_io_error) — a held lock or a filesystem
   * hiccup, NOT "not active". `findActiveSubagentDrivenPlans` still excludes
   * them (its `string[]` contract cannot express a read failure, so the
   * plugin rail stays fail-open by design); this signal lets a caller that
   * wants fail-closed behavior treat a non-empty list as "the plan state is
   * unknown". The coordinator's authoritative product gate
   * (assertProductGates) fails closed regardless, so legitimate interception
   * is never weakened.
   */
  read_errors: { slug: string; code: string; error: string }[];
};

export const scanActiveSubagentDrivenPlans = (root: string): ActivePlanScan => {
  const docsDir = path.join(root, "docs");
  if (!existsSync(docsDir)) return { slugs: [], read_errors: [] };
  const slugs: string[] = [];
  const readErrors: { slug: string; code: string; error: string }[] = [];
  for (const slug of readdirSync(docsDir)) {
    const file = path.join(docsDir, slug, "sdd", "flow.json");
    if (!existsSync(file)) continue;
    let effective: FlowReadResult;
    try {
      effective = readEffectiveFlowState(root, slug);
    } catch {
      // an unexpected read error (e.g. a non-slug directory name) excludes the
      // entry without touching it
      continue;
    }
    if (!effective.ok) {
      if (effective.code === "flow_concurrent_conflict" || effective.code === "flow_io_error") {
        readErrors.push({ slug, code: effective.code, error: effective.error });
      }
      continue;
    }
    const exec = effective.state.execution;
    if (exec.status === "active" && exec.mode === "subagent-driven") slugs.push(slug);
  }
  return { slugs, read_errors: readErrors };
};

export const findActiveSubagentDrivenPlans = (root: string): string[] =>
  scanActiveSubagentDrivenPlans(root).slugs;
