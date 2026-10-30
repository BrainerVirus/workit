/**
 * The PR description template a workspace fills (`prTemplate`) and the check
 * `workit pr create` runs on a body: every template heading present, none of
 * the template's HTML placeholder comments left.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
