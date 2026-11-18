// The `draft-in-full` repo rule (#864 drafts): a skill step that shows the
// user a draft for their yes must have the agent paste the whole text in chat,
// never only point at the file it wrote. An agent once wrote a draft to a file,
// named the path and, after a revision, never showed it again. oxlint only
// sees JS/TS, so this rule reads the canonical skills' Markdown itself.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const RULE = "draft-in-full";

/** The canonical skills; every host copy is generated from them. */
const SKILLS = "packages/workit-core/skills";

const MESSAGE =
  "this step shows the user a draft by its path only: have the agent paste the whole draft in chat before asking for a yes, and again after every edit";

export type DraftHit = {
  rule: string;
  file: string;
  line: number;
  column: number;
  message: string;
};

/** A step: a paragraph, or one list item of it. */
const steps = (text: string): { line: number; text: string }[] => {
  const out: { line: number; text: string }[] = [];
  let current: { line: number; lines: string[] } | null = null;
  const close = () => {
    if (current) out.push({ line: current.line, text: current.lines.join(" ") });
    current = null;
  };
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      close();
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/u.test(line)) close();
    current ??= { line: index + 1, lines: [] };
    current.lines.push(line.trim());
  }
  close();
  return out;
};

/** Whether `step` puts a draft before the user by naming where it is, never its text. */
export const namesOnlyAPath = (step: string): boolean =>
  /\bdrafts?\b/iu.test(step) &&
  /\b(?:user|approv\w*|yes)\b/iu.test(step) &&
  /\b(?:path|file)\b|\S+\.(?:md|txt)\b/iu.test(step) &&
  !/\b(?:in full|whole|full (?:text|draft)|verbatim|paste\w*)\b/iu.test(step);

/** Each step of `text` (one Markdown file) that names only a draft's path. */
export const draftStepHits = (file: string, text: string): DraftHit[] =>
  steps(text)
    .filter((step) => namesOnlyAPath(step.text))
    .map((step) => ({ rule: RULE, file, line: step.line, column: 1, message: MESSAGE }));

const markdown = (root: string, dir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return markdown(root, rel);
    return entry.isFile() && entry.name.endsWith(".md") ? [rel] : [];
  });
};

/** Every hit under `root`'s canonical skills. */
export const scanDraftSteps = (root: string): DraftHit[] =>
  markdown(root, SKILLS).flatMap((file) =>
    draftStepHits(file, readFileSync(path.join(root, file), "utf8")),
  );
