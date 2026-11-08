/**
 * The PR description template a workspace fills (`prTemplate`) and the check
 * `workit pr create` runs on a body: every template heading present, none of
 * the template's HTML placeholder comments left.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadCheckConfig, type NamedCheck } from "../check-config";
import { headSha } from "../git/rev";
import { readLedger } from "../ledger";
import { localCheckRows } from "./policy/check-evidence";
import { PR_TEMPLATE_DIRS, PR_TEMPLATE_FILES, findPrTemplate, repoRoot } from "./repo-context";

/** Workit's own template: the sections `references/pr-body.md` in the ship skill explains. */
export const WORKIT_PR_TEMPLATE = `## Summary

<!-- The smallest visual that makes the change clear (pseudocode, a call tree, a file tree, a Mermaid diagram or one diff hunk), with a sentence or two in the domain's words. -->

## Evidence

<!-- Before and after, observed: the checks recorded on the head SHA and the verdict, or a command with its output (red before, green after). -->

## Merge danger

<!-- One line: one-way or two-way door, plus the blast radius (who or what breaks if it is wrong). -->
`;

/** Where `auto` and `repo` look, for a refusal that names them. */
export const PR_TEMPLATE_LOOKED_IN: readonly string[] = [
  ...PR_TEMPLATE_FILES,
  ...PR_TEMPLATE_DIRS.map((dir) => `${dir}/*.md (one file)`),
];

export type PrTemplate = {
  /** The workspace setting that chose it: auto, repo, workit or a path. */
  setting: string;
  source: "repo" | "workit";
  /**
   * Whether `workit pr create` checks a body against it: a repo template, or
   * Workit's when the workspace sets `prTemplate: workit`. Under `auto` in a
   * repo with no template, Workit's is only a suggestion.
   */
  enforced: boolean;
  /** Repo-relative path of the repo template; null for Workit's. */
  path: string | null;
  content: string;
  headings: string[];
};

export type PrTemplateResult =
  | { ok: true; template: PrTemplate }
  | {
      ok: false;
      reason: "pr_template_missing";
      setting: string;
      /** The paths searched (repo) or the one configured (a path). */
      lookedIn: string[];
    };

const fromRepo = (setting: string, root: string, rel: string): PrTemplate => {
  const content = readFileSync(path.join(root, ...rel.split("/")), "utf8");
  return {
    setting,
    source: "repo",
    path: rel,
    content,
    headings: markdownHeadings(content),
    enforced: true,
  };
};

const isFile = (file: string): boolean => {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The template `setting` picks for the repo at cwd. */
export function resolvePrTemplate(cwd: string, setting: string): PrTemplateResult {
  const root = path.resolve(repoRoot(cwd));
  const workit: PrTemplate = {
    setting,
    source: "workit",
    path: null,
    content: WORKIT_PR_TEMPLATE,
    headings: markdownHeadings(WORKIT_PR_TEMPLATE),
    enforced: setting === "workit",
  };
  if (setting === "workit") return { ok: true, template: workit };
  if (setting === "auto" || setting === "repo") {
    const found = findPrTemplate(root);
    if (found) return { ok: true, template: fromRepo(setting, root, found) };
    return setting === "auto"
      ? { ok: true, template: workit }
      : {
          ok: false,
          reason: "pr_template_missing",
          setting,
          lookedIn: [...PR_TEMPLATE_LOOKED_IN],
        };
  }
  return isFile(path.join(root, ...setting.split("/")))
    ? { ok: true, template: fromRepo(setting, root, setting) }
    : {
        ok: false,
        reason: "pr_template_missing",
        setting,
        lookedIn: [setting],
      };
}

/** Markdown with fenced code blocks blanked, so neither headings nor comments inside them count. */
const withoutFences = (text: string): string[] => {
  let fence: string | null = null;
  return text.split(/\r?\n/u).map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      return "";
    }
    return fence === null ? line : "";
  });
};

const stripComments = (text: string): string => text.replaceAll(/<!--[\s\S]*?-->/gu, "");

const normalize = (text: string): string => text.replaceAll(/\s+/gu, " ").trim().toLowerCase();

/** ATX headings (`#` to `######`) outside code fences and HTML comments, in order. */
export function markdownHeadings(text: string): string[] {
  return stripComments(withoutFences(text).join("\n"))
    .split("\n")
    .map((line) => /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

/** The HTML comments of `text` outside code fences. */
const htmlComments = (text: string): string[] =>
  withoutFences(text)
    .join("\n")
    .match(/<!--[\s\S]*?-->/gu) ?? [];

export type PrBodyCheck = {
  /** Template headings the body has no heading for (text compared case-insensitively). */
  missingHeadings: string[];
  /** Template placeholder comments still in the body. */
  leftComments: string[];
};

/** What a body leaves unfilled of `template`; both lists empty when it is filled. */
export function checkPrBody(body: string, template: PrTemplate): PrBodyCheck {
  const have = new Set(markdownHeadings(body).map(normalize));
  const bodyComments = new Set(htmlComments(body).map(normalize));
  return {
    missingHeadings: template.headings.filter((heading) => !have.has(normalize(heading))),
    leftComments: [...new Set(htmlComments(template.content))].filter((comment) =>
      bodyComments.has(normalize(comment)),
    ),
  };
}

/** `the repo template <path>` or `Workit's template`, for messages. */
export const templateLabel = (template: PrTemplate): string =>
  template.path ? `the repo template ${template.path}` : "Workit's template";

/** A heading whose checkboxes claim that something was run. */
const VERIFICATION_HEADING = /verif|validat|evidence|\btest/iu;
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u;

/** The checkbox texts under the template's verification headings. */
function verificationItems(template: PrTemplate): string[] {
  let inSection = false;
  const items: string[] = [];
  for (const line of stripComments(withoutFences(template.content).join("\n")).split("\n")) {
    const heading = HEADING.exec(line)?.[1];
    if (heading !== undefined) inSection = VERIFICATION_HEADING.test(heading);
    const text = inSection ? CHECKBOX.exec(line)?.[4] : undefined;
    if (text?.trim()) items.push(text.trim());
  }
  return items;
}

/** The commands an item names: its backtick spans, leaving out a parenthesised (conditional) aside. */
const namedCommands = (item: string): string[] =>
  [...item.replaceAll(/\([^)]*\)/gu, "").matchAll(/`([^`]+)`/gu)].map((match) =>
    normalize(match[1]),
  );

/** The configured check a command runs: `workit check <name>`, or one of the argv the check accepts. */
const checkFor = (checks: readonly NamedCheck[], command: string): string | null =>
  checks.find(
    (check) =>
      command === `workit check ${check.name.toLowerCase()}` ||
      check.accepts.some((argv) => normalize(argv.join(" ")) === command),
  )?.name ?? null;

export type CheckboxEvidence = {
  checks: readonly NamedCheck[];
  /** Checks whose newest clean `workit check` run on the head passed. */
  fresh: ReadonlySet<string>;
};

/**
 * The body with each ticked verification checkbox the head's checks do not
 * back turned back to `- [ ]`. An item of the template's verification section
 * that names commands keeps its tick only when every command it names (outside
 * a parenthesised aside) is a configured check with a fresh pass on the head.
 * Items naming no command, and every other section, keep what the body says.
 */
export function uncheckUnbacked(
  body: string,
  template: PrTemplate,
  evidence: CheckboxEvidence,
): { body: string; unchecked: string[] } {
  const gated = verificationItems(template)
    .map((item) => ({ key: normalize(item), commands: namedCommands(item) }))
    .filter((item) => item.commands.length > 0);
  if (!gated.length) return { body, unchecked: [] };
  const unchecked: string[] = [];
  const fenced = withoutFences(body);
  const lines = body.split(/\r?\n/u).map((line, index) => {
    const box = fenced[index] === "" ? null : CHECKBOX.exec(line);
    if (!box || box[2] === " ") return line;
    const item = gated.find((candidate) => normalize(box[4]).startsWith(candidate.key));
    if (!item) return line;
    const backed = item.commands.every((command) => {
      const name = checkFor(evidence.checks, command);
      return name !== null && evidence.fresh.has(name);
    });
    if (backed) return line;
    unchecked.push(box[4].trim());
    return `${box[1]} ${box[3]}${box[4]}`;
  });
  return unchecked.length ? { body: lines.join("\n"), unchecked } : { body, unchecked };
}

/** The checks with a fresh pass on HEAD, read from the ledger and the checks config of `cwd`. */
function headCheckEvidence(cwd: string): CheckboxEvidence {
  const config = loadCheckConfig(cwd);
  const head = headSha(cwd);
  const ledger = readLedger(cwd);
  const rows = ledger.ok ? localCheckRows(ledger.value.rows) : [];
  const fresh = new Set<string>();
  for (const check of config.error ? [] : config.checks) {
    const last = rows.findLast((row) => row.name === check.name && row.head === head && !row.dirty);
    if (head && last?.passed) fresh.add(check.name);
  }
  return { checks: config.error ? [] : config.checks, fresh };
}

/**
 * What `workit pr create` sends for `body` under `template`: ticked
 * verification checkboxes without a fresh `workit check` on HEAD unticked.
 */
export const honestPrBody = (
  cwd: string,
  body: string,
  template: PrTemplate | null | undefined,
): { body: string; unchecked: string[] } =>
  template ? uncheckUnbacked(body, template, headCheckEvidence(cwd)) : { body, unchecked: [] };
