// `workit knowledge lint`: deterministic checks over the repository's agent
// knowledge files, so the guards against markdown rot are a check that can
// fail rather than a sentence an agent may ignore. Four rules:
//
// - agents-budget: AGENTS.md (and a CLAUDE.md that is not the same file) stays
//   at or under 8 KB; everything an agent pays for on every session.
// - broken-link: a markdown link, or a backticked path whose first segment
//   exists at the repository top, points at a local file that is missing.
// - scaffold-file: a need-based file (CODING_STANDARDS.md, GLOSSARY.md) holds
//   only headings, comments or placeholders. These files are created in the
//   same edit as their first real entry, never as an empty scaffold.
// - duplicate-rule: the same sentence (normalized: case, markup, wrapping)
//   appears in a steering file and in CODING_STANDARDS.md. A rule lives once.
//
// Read-only; plain TS over node built-ins (git only to list tracked paths).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AGENTS_BYTE_BUDGET = 8 * 1024;

/** Root files every session reads (navigation and rules). */
const STEERING_FILES = ["AGENTS.md", "CLAUDE.md"];
/** Root files that exist only once they hold a real entry. */
const NEED_BASED_FILES = ["CODING_STANDARDS.md", "GLOSSARY.md"];
const STANDARDS_FILE = "CODING_STANDARDS.md";
/** A sentence shorter than this is a heading-like fragment, not a rule. */
const MIN_RULE_WORDS = 6;

type KnowledgeRule = "agents-budget" | "broken-link" | "scaffold-file" | "duplicate-rule";

type KnowledgeFinding = {
  rule: KnowledgeRule;
  /** Repository-relative, forward slashes. */
  file: string;
  line: number | null;
  message: string;
};

export type KnowledgeReport = {
  root: string;
  budget: number;
  files: Array<{ file: string; bytes: number }>;
  findings: KnowledgeFinding[];
  /** Knowledge files that exist but could not be read (permissions, broken links). */
  unreadable: string[];
};

type Doc = { file: string; text: string; lines: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const PLACEHOLDER =
  /^(?:(?:tbd|todo|tba|fixme)(?:\s*[:–—-].*)?|n\/a|none|none yet|coming soon|placeholder|\.\.\.|…|-)?[.:]?$/i;

const INDENTED_CODE = /^(?: {4}|\t)/;
const blank = (line: string | undefined) => (line ?? "").trim() === "";

/**
 * Line indexes outside code (fenced blocks, closed only by a fence of the same
 * character and at least the same length; 4-space indented blocks that do not
 * continue a list), with HTML comments blanked.
 */
const proseLines = (lines: string[]): Array<{ index: number; text: string }> => {
  const out: Array<{ index: number; text: string }> = [];
  let fence: string | null = null;
  let comment = false;
  let indentedCode = false;
  let inList = false;
  lines.forEach((raw, index) => {
    if (fence) {
      const close = FENCE.exec(raw);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2].trim())
        fence = null;
      return;
    }
    if (!comment) {
      const open = FENCE.exec(raw);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = open[1];
        indentedCode = false;
        return;
      }
      if (INDENTED_CODE.test(raw) && !blank(raw)) {
        if (indentedCode || (!inList && blank(lines[index - 1]))) {
          indentedCode = true;
          return;
        }
      } else if (!blank(raw)) {
        indentedCode = false;
        inList = LIST_ITEM.test(raw) || (inList && /^\s/.test(raw));
      }
    }
    let text = raw;
    if (comment) {
      const end = text.indexOf("-->");
      if (end === -1) return;
      comment = false;
      text = text.slice(end + 3);
    }
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    const open = text.indexOf("<!--");
    if (open !== -1) {
      comment = true;
      text = text.slice(0, open);
    }
    out.push({ index, text });
  });
  return out;
};

const withoutFrontMatter = (lines: string[]): string[] => {
  if (lines[0]?.trim() !== "---") return lines;
  const end = lines.indexOf("---", 1);
  return end === -1 ? lines : [...lines.slice(0, end + 1).map(() => ""), ...lines.slice(end + 1)];
};

/** The file as a Doc; null when absent; "unreadable" when present but it cannot be read. */
const read = (root: string, file: string): (Doc & { real: string }) | null | "unreadable" => {
  const full = path.join(root, file);
  try {
    fs.lstatSync(full);
  } catch {
    return null;
  }
  try {
    if (!fs.statSync(full).isFile()) return null;
    const text = fs.readFileSync(full, "utf8");
    return { file, text, lines: text.split(/\r?\n/), real: fs.realpathSync(full) };
  } catch {
    return "unreadable";
  }
};

/**
 * Top-level entries git tracks, so a pointer is judged the same locally and in
 * CI; null outside a git repository (then the file system decides).
 */
const trackedTopLevel = (root: string): Set<string> | null => {
  const run = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  if (run.status !== 0) return null;
  return new Set(
    run.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => file.split("/")[0]),
  );
};

const exists = (target: string): boolean => {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
};

// --- broken-link -----------------------------------------------------------

// Targets: `<anything>` or a run without spaces that may hold balanced parentheses.
const LINK = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|((?:[^()\s<>]|\([^()\s]*\))+))(?:\s+["'(][^)]*)?\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;
const CODE_SPAN = /`([^`\n]+)`/g;
const PATH_LIKE = /^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?$/;

const isExternal = (target: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//");

const localTarget = (target: string): string => {
  const bare = target.replace(/[#?].*$/, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
};

const brokenLinks = (root: string, doc: Doc, tracked: Set<string> | null): KnowledgeFinding[] => {
  const findings: KnowledgeFinding[] = [];
  const base = path.dirname(path.join(root, doc.file));
  const missing = (target: string, line: number, how: string) =>
    findings.push({
      rule: "broken-link",
      file: doc.file,
      line,
      message: `${how} \`${target}\` points at a missing file`,
    });
  for (const { index, text } of proseLines(doc.lines)) {
    // Links inside inline code are examples, not links.
    const prose = text.replace(CODE_SPAN, (span) => " ".repeat(span.length));
    const targets = [...prose.matchAll(LINK)].map((match) => match[1] ?? match[2]);
    const definition = REFERENCE_DEFINITION.exec(prose)?.[1];
    if (definition) targets.push(definition);
    for (const target of targets) {
      if (isExternal(target)) continue;
      const local = localTarget(target);
      if (!local) continue;
      const resolved = local.startsWith("/") ? path.join(root, local) : path.resolve(base, local);
      if (!exists(resolved)) missing(target, index + 1, "link");
    }
    // A backticked path counts as a pointer only when it is explicitly
    // relative (./ or ../) or its first segment is a tracked top-level entry
    // (dot-directories included), so commands, globs, placeholders, package
    // names and local-only directories are never mistaken for one.
    for (const [, span] of text.matchAll(CODE_SPAN)) {
      const candidate = span.replace(/:\d+(?::\d+)?$/, "");
      if (!PATH_LIKE.test(candidate)) continue;
      const relative = /^\.\.?\//.test(candidate);
      const first = candidate.split("/")[0];
      if (!relative && !(tracked ? tracked.has(first) : exists(path.join(root, first)))) continue;
      const resolved = relative ? path.resolve(base, candidate) : path.join(root, candidate);
      if (!exists(resolved)) missing(span, index + 1, "pointer");
    }
  }
  return findings;
};

// --- scaffold-file ---------------------------------------------------------

const isPlaceholder = (text: string) =>
  PLACEHOLDER.test(
    text
      .replace(LIST_ITEM, "")
      .replace(/[*_`]/g, "")
      .replace(/^\[\s?\]\s*/, "")
      .trim(),
  );

/** True when the file has no line that is an entry: only headings, rules, comments, table headers or placeholders. */
const scaffoldOnly = (doc: Doc): boolean => {
  const lines = proseLines(withoutFrontMatter(doc.lines));
  return lines.every(({ text }, position) => {
    const trimmed = text.trim();
    if (trimmed === "" || HEADING.test(text) || /^([-*_])(\s*\1){2,}$/.test(trimmed)) return true;
    if (TABLE_SEPARATOR.test(text)) return true;
    const next = lines[position + 1]?.text ?? "";
    if (trimmed.startsWith("|") && TABLE_SEPARATOR.test(next)) return true;
    if (trimmed.startsWith("|"))
      return trimmed
        .split("|")
        .map((cell) => cell.trim())
        .every((cell) => cell === "" || isPlaceholder(cell));
    return isPlaceholder(trimmed);
  });
};

// --- duplicate-rule --------------------------------------------------------

/** Unwrapped list items and paragraphs, each with the line it starts on. */
const ruleUnits = (doc: Doc): Array<{ line: number; text: string }> => {
  const units: Array<{ line: number; text: string }> = [];
  let current: { line: number; text: string } | null = null;
  const flush = () => {
    if (current) units.push(current);
    current = null;
  };
  for (const { index, text } of proseLines(doc.lines)) {
    const trimmed = text.trim();
    if (trimmed === "" || HEADING.test(text) || trimmed.startsWith("|")) {
      flush();
      continue;
    }
    if (LIST_ITEM.test(text) || !current) {
      flush();
      current = { line: index + 1, text: trimmed.replace(LIST_ITEM, "") };
    } else current.text += ` ${trimmed}`;
  }
  flush();
  return units;
};

const normalize = (sentence: string): string =>
  sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();

const sentences = (doc: Doc): Map<string, number> => {
  const out = new Map<string, number>();
  for (const unit of ruleUnits(doc))
    for (const sentence of unit.text.split(/(?<=[.!?])\s+/)) {
      const key = normalize(sentence);
      if (key.split(" ").length >= MIN_RULE_WORDS && !out.has(key)) out.set(key, unit.line);
    }
  return out;
};

const duplicateRules = (steering: Doc[], standards: Doc): KnowledgeFinding[] => {
  const findings: KnowledgeFinding[] = [];
  const rules = sentences(standards);
  for (const doc of steering)
    for (const [key, line] of sentences(doc)) {
      const standardsLine = rules.get(key);
      if (standardsLine === undefined) continue;
      findings.push({
        rule: "duplicate-rule",
        file: doc.file,
        line,
        message: `repeats ${standards.file}:${standardsLine} ("${key.slice(0, 60)}${key.length > 60 ? "…" : ""}"); keep the rule in one file`,
      });
    }
  return findings;
};

// --- entry -----------------------------------------------------------------

/** Lint the knowledge files at `root` (the repository top). */
export function lintKnowledge(root: string): KnowledgeReport {
  const seen = new Set<string>();
  const unreadable: string[] = [];
  const load = (file: string): Doc | null => {
    const doc = read(root, file);
    if (doc === "unreadable") unreadable.push(file);
    if (doc === null || doc === "unreadable" || seen.has(doc.real)) return null;
    seen.add(doc.real);
    return doc;
  };
  const steering = STEERING_FILES.map(load).filter((doc): doc is Doc => doc !== null);
  const needBased = NEED_BASED_FILES.map(load).filter((doc): doc is Doc => doc !== null);
  const findings: KnowledgeFinding[] = [];

  for (const doc of steering) {
    const bytes = Buffer.byteLength(doc.text);
    if (bytes > AGENTS_BYTE_BUDGET)
      findings.push({
        rule: "agents-budget",
        file: doc.file,
        line: null,
        message: `${bytes} bytes, over the ${AGENTS_BYTE_BUDGET}-byte budget; move detail behind a pointer or into a check, and name what each addition removes`,
      });
  }
  for (const doc of needBased)
    if (scaffoldOnly(doc))
      findings.push({
        rule: "scaffold-file",
        file: doc.file,
        line: null,
        message:
          "holds no entry (headings, comments or placeholders only); delete it, or create it in the same edit as its first real entry",
      });
  const tracked = trackedTopLevel(root);
  for (const doc of [...steering, ...needBased]) findings.push(...brokenLinks(root, doc, tracked));
  const standards = needBased.find((doc) => doc.file === STANDARDS_FILE);
  if (standards) findings.push(...duplicateRules(steering, standards));

  return {
    root,
    budget: AGENTS_BYTE_BUDGET,
    files: [...steering, ...needBased].map((doc) => ({
      file: doc.file,
      bytes: Buffer.byteLength(doc.text),
    })),
    findings,
    unreadable,
  };
}
