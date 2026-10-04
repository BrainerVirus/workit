// File discovery and aggregation for `workit test-audit`: which files are
// tests, which changed on the branch, and the per-rule summary.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseSource } from "./ast";
import {
  auditParsed,
  bodyKey,
  RULES,
  type Finding,
  type Level,
  type RuleId,
  type TestCase,
} from "./rules";

export const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?)$/;
export const CODE_FILE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".workit"]);

export const toPosix = (file: string): string => file.split(path.sep).join("/");

export function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: run.status === 0, stdout: run.stdout ?? "" };
}

function walkTests(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== "." && entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkTests(full, out);
    } else if (TEST_FILE.test(toPosix(full))) out.push(full);
  }
}

/** Explicit files are audited as given; directories contribute their test files. */
export function expandPaths(cwd: string, inputs: string[]): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  for (const input of inputs.length > 0 ? inputs : ["."]) {
    const full = path.resolve(cwd, input);
    if (!existsSync(full)) missing.push(input);
    else if (statSync(full).isDirectory()) walkTests(full, files);
    else files.push(full);
  }
  return { files: [...new Set(files)].toSorted(), missing };
}

/** The base to diff against: given, else origin/main, main, origin/master, master. */
export function resolveBase(cwd: string, base: string | null): string | null {
  const candidates = base ? [base] : ["origin/main", "main", "origin/master", "master"];
  for (const candidate of candidates) {
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]).ok) continue;
    const mergeBase = git(cwd, ["merge-base", candidate, "HEAD"]);
    return mergeBase.ok ? mergeBase.stdout.trim() : null;
  }
  return null;
}

/** Changed files (tracked vs `base`, plus untracked) with changed line numbers. */
export function changedLines(cwd: string, base: string): Map<string, Set<number> | "all"> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  const changed = new Map<string, Set<number> | "all">();
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR", base]);
  let current: Set<number> | null = null;
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/^b\//, "");
      current = target === "/dev/null" ? null : new Set<number>();
      if (current) changed.set(path.join(root, target), current);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) current.add(start + offset);
    }
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untracked.stdout.split("\0").filter(Boolean))
    changed.set(path.join(root, file), "all");
  return changed;
}

export type AuditReport = {
  files: number;
  tests: number;
  parseErrors: { file: string; error: string }[];
  findings: Finding[];
  summary: {
    byRule: Partial<Record<RuleId, number>>;
    bySeverity: Record<Level, number>;
  };
  durationMs: number;
};

const SEVERITY_ORDER: Record<Level, number> = { high: 0, medium: 1, low: 2 };

/** Audit test files given as absolute paths; `display` makes paths relative. */
export function auditFiles(files: string[], display: (file: string) => string): AuditReport {
  const started = performance.now();
  const findings: Finding[] = [];
  const parseErrors: AuditReport["parseErrors"] = [];
  const bodies = new Map<string, { file: string; test: TestCase }>();
  let tests = 0;
  for (const file of files) {
    const shown = display(file);
    let parsed;
    try {
      parsed = parseSource(readFileSync(file, "utf8"), file);
    } catch (error) {
      parseErrors.push({
        file: shown,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const result = auditParsed(parsed, shown);
    tests += result.tests.length;
    findings.push(...result.findings);
    for (const test of result.tests) {
      const key = bodyKey(parsed, test);
      if (!key) continue;
      const first = bodies.get(key);
      if (!first) {
        bodies.set(key, { file: shown, test });
        continue;
      }
      findings.push({
        rule: "duplicate-body",
        severity: "low",
        confidence: "high",
        file: shown,
        line: test.line,
        test: test.name,
        why: `Body is identical to "${first.test.name}" (${first.file}:${first.test.line}): it adds no distinct failure signal.`,
        suggestion:
          "Delete the copy, or turn the cases into one table-driven test whose rows differ in input and expected output.",
        snippet: test.name,
      });
    }
  }
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  const byRule: Partial<Record<RuleId, number>> = {};
  const bySeverity: Record<Level, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    bySeverity[finding.severity] += 1;
  }
  return {
    files: files.length,
    tests,
    parseErrors,
    findings,
    summary: { byRule, bySeverity },
    durationMs: Math.round(performance.now() - started),
  };
}

export const ruleIds = Object.keys(RULES) as RuleId[];
