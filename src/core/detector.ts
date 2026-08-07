import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Detection = { choices: string[]; pattern: "alpha" | "numeric" } | null;

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
      if (flow.menu?.chosen === "subagent-driven" && flow.plan?.status === "approved") {
        slugs.push(slug);
      }
    } catch {
      // skip unreadable or malformed flow.json
    }
  }
  return slugs;
};
