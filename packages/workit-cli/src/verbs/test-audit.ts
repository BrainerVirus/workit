// `workit test-audit`: find tautological and low-value tests (static rules),
// and optionally check the branch's tests with diff-scoped mutation.
//
//   workit test-audit [paths…] [--json] [--rule a,b] [--min-severity <level>] [--fail-on <level>]
//   workit test-audit --diff [base]                 # test files changed vs base
//   workit test-audit --mutate [--diff base] [--test-cmd "<cmd {files}>"]
//                     [--max-mutants 40] [--budget 600] [--timeout <s>]
//
// Findings are advice; nothing is edited or deleted. `--fail-on <level>` and
// `--mutate` (a surviving mutant) exit 1, so either can be an opt-in gate.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  auditFiles,
  changedLines,
  expandPaths,
  git,
  resolveBase,
  ruleIds,
  TEST_FILE,
  toPosix,
  type AuditReport,
} from "../test-audit/audit";
import { BaselineFailed, runMutation, type MutationReport } from "../test-audit/mutate";
import type { Level, RuleId } from "../test-audit/rules";
import { emit, fail, ok, type Io } from "../output";

const USAGE =
  "workit test-audit [paths…] [--diff [base]] [--rule <ids>] [--min-severity <level>] [--fail-on <level>] [--mutate [--test-cmd <cmd>] [--max-mutants <n>] [--budget <s>] [--timeout <s>]] [--json]";

type Options = {
  paths: string[];
  diff: boolean;
  base: string | null;
  rules: Set<RuleId> | null;
  minSeverity: Level;
  failOn: Level | null;
  mutate: boolean;
  testCmd: string | null;
  maxMutants: number;
  budgetS: number;
  timeoutS: number | null;
};

const LEVELS: Level[] = ["high", "medium", "low"];
const VALUE_FLAGS = new Set([
  "--rule",
  "--min-severity",
  "--fail-on",
  "--test-cmd",
  "--max-mutants",
  "--budget",
  "--timeout",
]);

function parse(argv: string[]): Options | string {
  const options: Options = {
    paths: [],
    diff: false,
    base: null,
    rules: null,
    minSeverity: "low",
    failOn: null,
    mutate: false,
    testCmd: null,
    maxMutants: 40,
    budgetS: 600,
    timeoutS: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inline] =
      raw.startsWith("--") && raw.includes("=")
        ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
        : [raw, undefined];
    if (flag === "--json") continue;
    if (flag === "--mutate") options.mutate = true;
    else if (flag === "--diff") {
      options.diff = true;
      const next =
        inline ?? (argv[index + 1] && !argv[index + 1].startsWith("-") ? argv[++index] : undefined);
      if (next) options.base = next;
    } else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === "") return `${flag} requires a value`;
      if (flag === "--rule") {
        const ids = value.split(",").map((id) => id.trim());
        const unknown = ids.filter((id) => !ruleIds.includes(id as RuleId));
        if (unknown.length > 0)
          return `unknown rule ${unknown.join(", ")} (rules: ${ruleIds.join(", ")})`;
        options.rules = new Set(ids as RuleId[]);
      } else if (flag === "--min-severity" || flag === "--fail-on") {
        if (!LEVELS.includes(value as Level)) return `${flag} must be high, medium or low`;
        if (flag === "--fail-on") options.failOn = value as Level;
        else options.minSeverity = value as Level;
      } else if (flag === "--test-cmd") options.testCmd = value;
      else {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) return `${flag} requires a positive number`;
        if (flag === "--max-mutants") options.maxMutants = Math.floor(number);
        else if (flag === "--budget") options.budgetS = number;
        else options.timeoutS = number;
      }
    } else if (raw.startsWith("-")) return `unknown option ${raw}`;
    else options.paths.push(raw);
  }
  if (options.diff && options.paths.length > 0)
    return "--diff selects files itself; drop the paths or the --diff";
  return options;
}

/** `--test-cmd`, then `.workit/checks.json` `checks.test`, then the repo's runner. */
function testCommand(repo: string, given: string | null): string | null {
  if (given) return given;
  const checks = path.join(repo, ".workit", "checks.json");
  if (existsSync(checks)) {
    try {
      const configured = JSON.parse(readFileSync(checks, "utf8"))?.checks?.test;
      if (typeof configured === "string" && configured.trim()) return configured;
    } catch {
      // unreadable config: fall through to detection
    }
  }
  if (existsSync(path.join(repo, "bun.lock")) || existsSync(path.join(repo, "bun.lockb")))
    return "bun test {files}";
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return "npx vitest run {files}";
    if (deps.jest) return "npx jest {files}";
  } catch {
    // no package.json
  }
  return null;
}

type Data = AuditReport & { root: string; base: string | null; mutation: MutationReport | null };

function human(data: Data): string[] {
  const lines: string[] = [];
  for (const finding of data.findings) {
    lines.push(
      `${finding.file}:${finding.line}  ${finding.rule} [${finding.severity}, confidence ${finding.confidence}]${finding.test ? `  "${finding.test}"` : ""}`,
      `    ${finding.why}`,
      `    fix: ${finding.suggestion}`,
    );
  }
  for (const error of data.parseErrors) lines.push(`${error.file}: parse error: ${error.error}`);
  const rules = Object.entries(data.summary.byRule)
    .toSorted(([, a], [, b]) => b - a)
    .map(([rule, count]) => `${rule} ${count}`)
    .join(", ");
  const { high, medium, low } = data.summary.bySeverity;
  lines.push(
    `test-audit: ${data.findings.length} finding(s) in ${data.files} file(s), ${data.tests} test(s), ${data.durationMs} ms` +
      (data.findings.length ? ` — high ${high}, medium ${medium}, low ${low}; ${rules}` : ""),
  );
  const mutation = data.mutation;
  if (mutation) {
    for (const mutant of mutation.mutants.filter((entry) => entry.status === "survived"))
      lines.push(
        `SURVIVED #${mutant.id} ${mutant.file}:${mutant.line}  ${mutant.original} -> ${mutant.replacement || "(removed)"}  (tests: ${mutant.tests.join(", ") || "whole command"})`,
      );
    const { killed, survived, timeout, skipped } = mutation.counts;
    lines.push(
      `mutation: ${mutation.mutants.length} mutant(s) vs ${mutation.base.slice(0, 12)} — killed ${killed}, timeout ${timeout}, survived ${survived}, no tests ${mutation.counts["no-tests"]}, skipped ${skipped}; score ${mutation.score ?? "n/a"}%; ${mutation.durationMs} ms`,
    );
  }
  return lines;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const options = parse(argv);
  if (typeof options === "string")
    return emit(io, fail("invalid_input", `${options}\nusage: ${USAGE}`));
  const top = git(io.cwd, ["rev-parse", "--show-toplevel"]);
  const repo = top.ok ? path.resolve(top.stdout.trim()) : null;
  const display = (file: string) => toPosix(path.relative(io.cwd, file) || file);

  let base: string | null = null;
  let changed: Map<string, Set<number> | "all"> | null = null;
  if (options.diff || options.mutate) {
    if (!repo)
      return emit(
        io,
        fail("unavailable", "--diff and --mutate need a git repository", {
          unblock: "run inside a git work tree",
        }),
      );
    base = resolveBase(io.cwd, options.base);
    if (!base)
      return emit(
        io,
        fail(
          "invalid_input",
          `cannot resolve a base to diff against${options.base ? `: ${options.base}` : ""}`,
          {
            unblock: "workit test-audit --diff <base-branch-or-sha>",
          },
        ),
      );
    changed = changedLines(io.cwd, base);
  }

  let files: string[];
  if (options.diff && changed)
    files = [...changed.keys()]
      .filter((file) => TEST_FILE.test(toPosix(file)) && existsSync(file))
      .toSorted();
  else {
    const expanded = expandPaths(io.cwd, options.paths);
    if (expanded.missing.length > 0)
      return emit(io, fail("not_found", `no such path: ${expanded.missing.join(", ")}`));
    files = expanded.files;
  }

  const report = auditFiles(files, display);
  const floor = LEVELS.indexOf(options.minSeverity);
  report.findings = report.findings.filter(
    (finding) =>
      LEVELS.indexOf(finding.severity) <= floor &&
      (!options.rules || options.rules.has(finding.rule)),
  );
  report.summary.byRule = {};
  report.summary.bySeverity = { high: 0, medium: 0, low: 0 };
  for (const finding of report.findings) {
    report.summary.byRule[finding.rule] = (report.summary.byRule[finding.rule] ?? 0) + 1;
    report.summary.bySeverity[finding.severity] += 1;
  }

  let mutation: MutationReport | null = null;
  if (options.mutate && repo && base && changed) {
    const command = testCommand(repo, options.testCmd);
    if (!command)
      return emit(
        io,
        fail("unavailable", "no test command for --mutate", {
          unblock:
            'workit test-audit --mutate --test-cmd "<runner> {files}" (or set checks.test in .workit/checks.json)',
        }),
      );
    try {
      mutation = await runMutation({
        repo,
        cwd: io.cwd,
        base,
        changed,
        command,
        maxMutants: options.maxMutants,
        budgetMs: options.budgetS * 1000,
        timeoutMs: options.timeoutS === null ? null : options.timeoutS * 1000,
        env: io.env,
        onProgress: io.json ? undefined : (line) => io.stderr(`  ${line}\n`),
      });
    } catch (error) {
      if (error instanceof BaselineFailed)
        return emit(
          io,
          fail("failed", error.message, {
            data: { command: error.command, tail: error.tail },
            unblock: "make the related tests pass before mutating",
          }),
        );
      throw error;
    }
  }

  const data: Data = { root: io.cwd, base, ...report, mutation };
  const gate = options.failOn ? LEVELS.indexOf(options.failOn) : -1;
  const blocking = report.findings.filter((finding) => LEVELS.indexOf(finding.severity) <= gate);
  const problems = [
    ...(blocking.length > 0
      ? [`${blocking.length} finding(s) at or above --fail-on ${options.failOn}`]
      : []),
    ...(mutation && mutation.counts.survived > 0
      ? [
          `${mutation.counts.survived} mutant(s) survived: the related tests do not notice these changes`,
        ]
      : []),
  ];
  if (problems.length > 0) {
    if (!io.json) for (const line of human(data)) io.stdout(`${line}\n`);
    return emit(io, fail("failed", problems.join("; "), { data }));
  }
  return emit(io, ok(data), human);
}
