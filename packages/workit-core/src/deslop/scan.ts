import type { ReviewLane } from "../core/policy/lane";
import { lexComments, type LexedComment } from "./lex";

export const DESLOP_CLASSES = ["narration", "marker", "suppression", "debug", "allowed"] as const;
export type DeslopClass = (typeof DESLOP_CLASSES)[number];

export type DeslopFinding = {
  file: string;
  line: number;
  class: DeslopClass;
  /** Why it got this class: the keep-list entry for `allowed`, the directive for a suppression. */
  reason: string;
  text: string;
  /** A marker or lint/type suppression: the change needs at least a focused review. */
  raisesLane: boolean;
};

const SUPPRESSION =
  /(?:^|\s)(eslint-disable(?:-next-line|-line)?|oxlint-disable(?:-next-line|-line)?|biome-ignore(?:-all|-start|-end)?|deno-lint-ignore(?:-file)?|@ts-(?:ignore|expect-error|nocheck)|noqa|type:\s*ignore|pylint:\s*disable(?:-next)?|rubocop:\s*disable|NOLINT(?:NEXTLINE)?|NOSONAR|(?:istanbul|c8|v8)\s+ignore|workit-test-audit-ignore(?:-file)?)\b/;
const FORMATTER =
  /(?:^|\s)(prettier-ignore|oxfmt-ignore|dprint-ignore|biome-ignore\s+format|fmt:\s*(?:off|on|skip)|clang-format\s+(?:off|on)|rustfmt::skip)\b/;
const TOOL_DIRECTIVE =
  /^\s*(?:<reference\s|@ts-check|@jsx|@flow|@vite-ignore|webpack[A-Z]|go:(?:build|generate|embed)|#?(?:end)?region\b|-\*-\s*coding|frozen_string_literal|@refresh|shellcheck\s+(?:source|shell)=)/;
const MARKER = /\b(TODO|FIXME|XXX|HACK|TBD)\b/;
const LICENCE =
  /SPDX-License-Identifier|copyright\s|\(c\)\s*\d{4}|licen[cs]ed under|all rights reserved/i;
const LINK =
  /https?:\/\/\S+|(?:^|[\s(])#\d+\b|\bRFC\s?\d{3,}|\bGH-\d+\b|\b(?!(?:UTF|SHA|ISO|ES|ECMA|AES|RSA|CRC|TLS|SSL|HTTP|IPV)-)[A-Z][A-Z0-9]{1,9}-\d+\b|\bCVE-\d{4}-\d+/;
const QUIRK =
  /\b(?:works? around|workaround|quirk|bug|broken|regression|does not|doesn't|never|only (?:accepts?|supports?|reads?)|rejects?|ignores?|drops?|requires?|refuses?)\b/i;
const EXTERNAL =
  /\b(?:upstream|vendor|third-party|library|spec|posix|windows|macos|darwin|linux|wsl|safari|chrome|chromium|firefox|webkit|node(?:\.js)?|bun|deno|npm|pnpm|yarn|git|github|gitlab|bash|zsh|powershell|cmd\.exe|glibc|musl|electron|react|babel|typescript|tsc|eslint|oxlint|prettier|jest|vitest|ink|sqlite|postgres|docker|systemd|kernel|v?\d+\.\d+(?:\.\d+)?)\b/i;
const DEBUG_CODE =
  /\bconsole\.(?:log|debug|trace|dir)\s*\(|\bdebugger\b|\bdbg!\s*\(|\bbreakpoint\s*\(\s*\)|\bpdb\.set_trace\s*\(|\bbinding\.pry\b|\bvar_dump\s*\(/;
const DEBUG_TAG = /\[DEBUG-\w+\]/;
const PUBLIC_DECLARATION =
  /^\s*(?:export\b|pub(?:\(crate\))?\s|public\s|module\.exports|exports\.|def\s+[a-z]|class\s+[A-Z])/;

const words = (text: string): number => text.split(/\s+/).filter((word) => /\w/.test(word)).length;

function suppressionReason(text: string, directive: string): string {
  const after = text.slice(text.indexOf(directive) + directive.length);
  const separated = /(?:\s--\s*|:\s+(?=\D))(.*)$/.exec(after);
  if (separated && words(separated[1]) >= 1 && !/^[\w/@-]+(?:,\s*[\w/@-]+)*$/.test(separated[1]))
    return separated[1].trim();
  const rest = after
    .replace(/^\s*[:=]?\s*(?:\[[^\]]*\])?/, "")
    .replace(/^(?:\s*[\w/@.-]*[/\d_-][\w/@.-]*,?)+/, "")
    .trim();
  return words(rest) >= 2 ? rest : "";
}

function classifyDirective(
  text: string,
): Pick<DeslopFinding, "class" | "reason" | "raisesLane"> | null {
  const formatter = FORMATTER.exec(text);
  if (formatter)
    return { class: "allowed", reason: `formatter directive ${formatter[1]}`, raisesLane: false };
  const suppression = SUPPRESSION.exec(text);
  if (suppression) {
    const directive = suppression[1];
    const reason = suppressionReason(text, directive);
    return reason
      ? {
          class: "allowed",
          reason: `justified suppression ${directive}: ${reason}`,
          raisesLane: true,
        }
      : { class: "suppression", reason: `${directive} without a reason`, raisesLane: true };
  }
  if (TOOL_DIRECTIVE.test(text))
    return { class: "allowed", reason: "tool directive", raisesLane: false };
  return null;
}

function classifyProse(
  text: string,
  publicDoc: boolean,
): Pick<DeslopFinding, "class" | "reason" | "raisesLane"> {
  const marker = MARKER.exec(text);
  if (marker) return { class: "marker", reason: marker[1], raisesLane: true };
  if (LICENCE.test(text)) return { class: "allowed", reason: "licence", raisesLane: false };
  if (LINK.test(text)) return { class: "allowed", reason: "issue or RFC link", raisesLane: false };
  if (publicDoc) return { class: "allowed", reason: "public API docs", raisesLane: false };
  if (QUIRK.test(text) && EXTERNAL.test(text))
    return { class: "allowed", reason: "external quirk", raisesLane: false };
  return { class: "narration", reason: "restates or narrates the code", raisesLane: false };
}

const indent = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;

function documentsPublicApi(code: string[], comment: LexedComment): boolean {
  if (!comment.doc) return false;
  let next = comment.endLine + 1;
  while (next < code.length && code[next].trim() === "") next += 1;
  const declaration = code[next] ?? "";
  if (PUBLIC_DECLARATION.test(declaration)) return true;
  const depth = indent(declaration);
  if (depth === 0) return false;
  for (let line = comment.line - 1; line >= 1; line -= 1) {
    const text = code[line];
    if (text.trim() === "" || indent(text) >= depth) continue;
    return PUBLIC_DECLARATION.test(text);
  }
  return false;
}

type Group = { comments: LexedComment[]; doc: boolean };

function groupComments(comments: LexedComment[]): Group[] {
  const groups: Group[] = [];
  for (const comment of comments) {
    const last = groups.at(-1)?.comments.at(-1);
    const joins =
      last &&
      !comment.block &&
      !last.block &&
      !comment.trailing &&
      !last.trailing &&
      comment.line === last.endLine + 1 &&
      comment.doc === last.doc;
    if (joins) groups.at(-1)!.comments.push(comment);
    else groups.push({ comments: [comment], doc: comment.doc });
  }
  return groups;
}

const touched = (changed: Set<number> | "all", from: number, to: number): number | null => {
  for (let line = from; line <= to; line += 1)
    if (changed === "all" || changed.has(line)) return line;
  return null;
};

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
};

/**
 * Classify the comments and debug leftovers that `changed` lines of `file`
 * add. Files in a language without a known comment syntax yield nothing.
 */
export function scanSource(
  file: string,
  source: string,
  changed: Set<number> | "all",
): DeslopFinding[] {
  const lexed = lexComments(file, source);
  if (!lexed) return [];
  const findings: DeslopFinding[] = [];
  for (const group of groupComments(lexed.comments)) {
    const prose: LexedComment[] = [];
    for (const comment of group.comments) {
      const directive = classifyDirective(comment.text);
      const line = directive ? touched(changed, comment.line, comment.endLine) : null;
      if (directive && line !== null)
        findings.push({ file, line, ...directive, text: excerpt(comment.text) });
      else if (!directive) prose.push(comment);
    }
    if (prose.length === 0) continue;
    const line = touched(changed, prose[0].line, prose.at(-1)!.endLine);
    const text = prose.map((comment) => comment.text).join("\n");
    if (line === null || text.trim() === "") continue;
    const publicDoc = documentsPublicApi(lexed.code, prose.at(-1)!);
    findings.push({ file, line, ...classifyProse(text, publicDoc), text: excerpt(text) });
  }
  const rawLines = source.split("\n");
  for (let line = 1; line < lexed.code.length; line += 1) {
    if (touched(changed, line, line) === null) continue;
    const debug =
      DEBUG_CODE.exec(lexed.code[line] ?? "") ?? DEBUG_TAG.exec(rawLines[line - 1] ?? "");
    if (debug)
      findings.push({
        file,
        line,
        class: "debug",
        reason: `debug leftover ${debug[0].replace(/\s*\($/, "")}`,
        text: excerpt(rawLines[line - 1] ?? ""),
        raisesLane: false,
      });
  }
  return findings.toSorted((a, b) => a.line - b.line);
}

const ORDER: readonly ReviewLane[] = ["none", "self", "focused", "full"];

export type LaneRaise = { from: ReviewLane; lane: ReviewLane; reasons: string[] };

/** A marker or lint/type suppression lifts a none or self lane to focused. */
export function raiseLane(lane: ReviewLane, findings: readonly DeslopFinding[]): LaneRaise {
  const raising = findings.filter((finding) => finding.raisesLane);
  if (raising.length === 0 || ORDER.indexOf(lane) >= ORDER.indexOf("focused"))
    return { from: lane, lane, reasons: [] };
  const first = raising[0];
  return {
    from: lane,
    lane: "focused",
    reasons: [
      `${raising.length} new marker(s) or suppression(s), first ${first.file}:${first.line} (${first.reason})`,
    ],
  };
}

export const DESLOP_PASSES = {
  prose: "prose: cut filler from the PR body, docs and commit messages",
  scan: "scan: workit deslop scan --diff, then delete every narration, marker and debug finding",
  mechanical: "mechanical: delete dead code the repo's dead-code and lint tools report",
  "no-comments":
    "no-comments: a fresh-eyes reviewer re-reads every added comment against the keep list",
  "test-quality": "test-quality: workit test-audit --diff, then triage every finding",
  mutate: "mutate: workit test-audit --mutate --diff",
  architect: "architect: one sketch of the simpler shape, reported, not applied",
} as const;
export type DeslopPass = keyof typeof DESLOP_PASSES;

/** The passes deslop runs in each lane; each lane adds to the one below it. */
export function lanePasses(lane: ReviewLane): DeslopPass[] {
  if (lane === "none") return ["prose"];
  const self: DeslopPass[] = ["prose", "scan", "mechanical"];
  if (lane === "self") return self;
  const focused: DeslopPass[] = [...self, "no-comments", "test-quality"];
  return lane === "focused" ? focused : [...focused, "mutate", "architect"];
}

/** The one result line a finished deslop records for its PR. */
export const deslopResultLine = (result: {
  lane: ReviewLane;
  removed: number;
  reshapes: number;
  open: number;
}): string =>
  `deslop: lane ${result.lane}, -${result.removed} lines, ${result.reshapes} reshapes, ${result.open} open`;
