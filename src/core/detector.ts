import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_GAP_MARKER } from "./config-guard";
import { parseTasksFromPlan } from "./docs-validate";

export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;

export const detectConfigGapError = (text: string): boolean =>
  text.includes(CONFIG_GAP_MARKER);

// Raw delivery: a fenced block carrying doc markers — the agent pasted the doc
// instead of rendering it. Reminders use angle-bracket blocks, never fences, so no false positives.
export const detectRawDocDelivery = (text: string): boolean =>
  text.includes("```") &&
  (text.includes("# Spec") || text.includes("# Plan") ||
    text.includes("**Spec:**") || text.includes("**Branch:**"));

// Interrogative gate: a literal question mark OR explicit interrogative phrases.
// Plain "I want to confirm..." or "the script which runs" must NOT match.
const INTERROGATIVE = /[?¿]|which\s+one|choose\s+(?:one|between|among)|do\s+you\s+(?:want|prefer)|want\s+me\s+to/i;

export const detectProseChoices = (text: string): Detection => {
  if (!INTERROGATIVE.test(text)) return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const alphaAll = [...text.matchAll(/([a-dA-D])[.)]\s+([^\n]*?)(?=\s+[a-dA-D][.)]\s|$)/g)]
    .map((m) => ({ letter: m[1].toLowerCase(), choice: m[2].trim() }));
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

  const numericAll = [...text.matchAll(/(\d+)[.)]\s+([^\n]*?)(?=\s+\d+[.)]\s|$)/g)]
    .map((m) => ({ num: Number(m[1]), choice: m[2].trim() }));
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
    if (line.startsWith("```")) { inFence = !inFence; continue; }
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

// The rail has no terminal FlowStatus — a fully completed SDD ledger is done,
// but only if its complete set covers every task id in the plan (the last
// task's append may have been skipped, leaving an all-complete partial ledger).
const isPlanComplete = (slugDir: string): boolean => {
  const ledger = path.join(slugDir, "sdd", "progress.md");
  if (!existsSync(ledger)) return false; // no ledger yet — not provably complete
  let taskLines: string[];
  try {
    taskLines = readFileSync(ledger, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^Task \s*\d+:/i.test(l));
  } catch {
    return true; // unreadable ledger → exclude the slug
  }
  if (taskLines.length === 0 || !taskLines.every((l) => /^Task \s*\d+:\s*complete\b/i.test(l))) {
    return false;
  }
  try {
    const planTasks = parseTasksFromPlan(readFileSync(path.join(slugDir, "plan.md"), "utf8"));
    if (planTasks.length === 0) return true;
    const completeIds = new Set(
      taskLines.map((l) => Number(/^Task\s*(\d+):/i.exec(l)?.[1])).filter(Number.isFinite),
    );
    return planTasks.every((t) => completeIds.has(t.id));
  } catch {
    return false; // unreadable/missing plan.md — not provably complete, rail stays on
  }
};

export const findActiveSubagentDrivenPlans = (root: string): string[] => {
  const docsDir = path.join(root, "docs");
  if (!existsSync(docsDir)) return [];
  const slugs: string[] = [];
  for (const slug of readdirSync(docsDir)) {
    const file = path.join(docsDir, slug, "sdd", "flow.json");
    try {
      const flow = JSON.parse(readFileSync(file, "utf8")) as {
        menu?: { chosen?: string };
        plan?: { status?: string };
      };
      if (
        flow.menu?.chosen === "subagent-driven" &&
        flow.plan?.status === "approved" &&
        !isPlanComplete(path.join(docsDir, slug))
      ) {
        slugs.push(slug);
      }
    } catch {
      // skip unreadable or malformed flow.json
    }
  }
  return slugs;
};
