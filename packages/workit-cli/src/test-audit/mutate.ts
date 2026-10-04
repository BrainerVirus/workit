// `workit test-audit --mutate`: diff-scoped mutation without Stryker. Each
// mutant flips one comparison, boolean, logical or arithmetic operator, or
// return value on a changed source line, and the related tests run against
// it. Every mutant is written into a disposable copy of the working tree, so
// the user's sources are never modified: a crash or SIGKILL leaves at most a
// stale temp directory, which the next run removes.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineOf, parseSource, walk, type Node } from "./ast";
import { CODE_FILE, git, TEST_FILE, toPosix } from "./audit";

type Mutant = {
  id: number;
  file: string; // repo-relative
  line: number;
  original: string;
  replacement: string;
  start: number;
  end: number;
};

type MutantResult = Mutant & {
  status: "killed" | "survived" | "timeout" | "no-tests" | "skipped";
  durationMs: number;
  tests: string[];
};

export type MutationReport = {
  base: string;
  command: string;
  baselineMs: number;
  mutants: MutantResult[];
  counts: Record<MutantResult["status"], number>;
  score: number | null;
  durationMs: number;
};

const NOT_SOURCE = /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures?|node_modules|dist)\//;

const FLIPS: Record<string, string[]> = {
  "===": ["!=="],
  "!==": ["==="],
  "==": ["!="],
  "!=": ["=="],
  "<": ["<=", ">="],
  "<=": ["<", ">"],
  ">": [">=", "<="],
  ">=": [">", "<"],
  "+": ["-"],
  "-": ["+"],
  "*": ["/"],
  "/": ["*"],
  "%": ["*"],
  "&&": ["||"],
  "||": ["&&"],
};

const isStringy = (node: Node): boolean =>
  node.type === "StringLiteral" || node.type === "TemplateLiteral";

/** All single-edit mutants on the given lines of one file. */
function mutantsFor(
  source: string,
  file: string,
  lines: Set<number> | "all",
): Omit<Mutant, "id">[] {
  const parsed = parseSource(source, file);
  const out: Omit<Mutant, "id">[] = [];
  const onChangedLine = (node: Node) => lines === "all" || lines.has(lineOf(node));
  walk(parsed.program, (node) => {
    if (!onChangedLine(node)) return;
    if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
      const flips = FLIPS[node.operator];
      if (!flips) return;
      if (node.operator === "+" && (isStringy(node.left) || isStringy(node.right))) return;
      // The operator sits between the operands, after any closing parens.
      const at = source.indexOf(node.operator, node.left.end);
      if (at < 0 || at >= node.right.start) return;
      for (const replacement of flips)
        out.push({
          file,
          line: lineOf(node),
          original: node.operator,
          replacement,
          start: at,
          end: at + node.operator.length,
        });
    } else if (node.type === "BooleanLiteral") {
      out.push({
        file,
        line: lineOf(node),
        original: String(node.value),
        replacement: String(!node.value),
        start: node.start,
        end: node.end,
      });
    } else if (node.type === "UnaryExpression" && node.operator === "!") {
      out.push({
        file,
        line: lineOf(node),
        original: "!",
        replacement: "",
        start: node.start,
        end: node.start + 1,
      });
    } else if (node.type === "ReturnStatement" && node.argument) {
      const argument: Node = node.argument;
      // null -> undefined is equivalent for almost every caller.
      if (argument.type === "NullLiteral") return;
      if (argument.type === "Identifier" && argument.name === "undefined") return;
      out.push({
        file,
        line: lineOf(node),
        original: source.slice(argument.start, argument.end).slice(0, 60),
        replacement: "undefined",
        start: argument.start,
        end: argument.end,
      });
    }
  });
  const seen = new Set<string>();
  return out
    .filter((mutant) => {
      const key = `${mutant.start}:${mutant.end}:${mutant.replacement}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .toSorted((a, b) => a.start - b.start);
}

/** Test files that import a module with this file's stem. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const stripExt = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");

/**
 * Test files that import `source` (repo-relative). Relative specifiers are
 * resolved exactly; aliased or package specifiers (`@/pkg/src/x`,
 * `@scope/pkg/src/x`) match when their last two path segments do.
 */
function relatedTests(source: string, testFiles: { file: string; text: string }[]): string[] {
  const target = stripExt(source);
  const tail = target.split("/").slice(-2).join("/");
  return testFiles
    .filter(({ file, text }) => {
      for (const match of text.matchAll(SPECIFIER)) {
        const spec = match[1];
        if (spec.startsWith(".")) {
          if (stripExt(path.posix.join(path.posix.dirname(file), spec)) === target) return true;
        } else if (spec.includes("/") && stripExt(spec).split("/").slice(-2).join("/") === tail)
          return true;
      }
      return false;
    })
    .map((entry) => entry.file);
}

const TEMP_PREFIX = "workit-mutate-";
const PID_FILE = ".workit-mutate.pid";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Remove temp copies left behind by runs that were killed. */
export function removeStaleCopies(tmp = os.tmpdir()): number {
  let removed = 0;
  for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      const pid = Number(readFileSync(path.join(dir, PID_FILE), "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
    } catch {
      // no pid file: a copy interrupted while being created
    }
    rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * node_modules for the copy: every entry links to the original install,
 * except workspace links, which point at the copy's own packages so a
 * mutated workspace package is what the tests import.
 */
function linkNodeModules(origin: string, target: string, repo: string, copy: string) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(origin, { withFileTypes: true })) {
    const from = path.join(origin, entry.name);
    const to = path.join(target, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      linkNodeModules(from, to, repo, copy);
      continue;
    }
    if (entry.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(from);
      } catch {
        continue; // dangling link
      }
      const relative = path.relative(repo, real);
      if (
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
      ) {
        symlinkSync(path.join(copy, relative), to, "junction");
        continue;
      }
    }
    symlinkSync(from, to, entry.isDirectory() ? "junction" : "file");
  }
}

/**
 * A disposable copy of the working tree (tracked + untracked, not ignored)
 * under `<dir>/tree`. It is its own git repository, cloned with shared
 * objects and its index reset to HEAD, so tests that run git see the same
 * branch, history and dirty state without being able to touch the original.
 */
function copyWorkingTree(repo: string): { dir: string; tree: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  writeFileSync(path.join(dir, PID_FILE), String(process.pid));
  const tree = path.join(dir, "tree");
  const head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  if (head && git(dir, ["clone", "-q", "--shared", "--no-checkout", repo, tree]).ok) {
    const branch = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
    if (branch) {
      git(tree, ["update-ref", `refs/heads/${branch}`, head]);
      git(tree, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    } else git(tree, ["update-ref", "--no-deref", "HEAD", head]);
    git(tree, ["reset", "-q"]);
  } else mkdirSync(tree, { recursive: true });
  const listed = git(repo, ["ls-files", "-co", "--exclude-standard", "-z"]).stdout.split("\0");
  const dirs = new Set<string>([""]);
  for (const relative of listed) {
    if (!relative) continue;
    const from = path.join(repo, relative);
    let stat;
    try {
      stat = lstatSync(from);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    const to = path.join(tree, relative);
    mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isFile()) copyFileSync(from, to);
    let parent = path.dirname(relative);
    while (parent !== "." && !dirs.has(parent)) {
      dirs.add(parent);
      parent = path.dirname(parent);
    }
  }
  for (const parent of dirs) {
    const modules = path.join(repo, parent, "node_modules");
    if (existsSync(modules) && !existsSync(path.join(tree, parent, "node_modules")))
      linkNodeModules(modules, path.join(tree, parent, "node_modules"), repo, tree);
  }
  return { dir, tree };
}

type RunResult = { code: number | null; timedOut: boolean; durationMs: number; tail: string };

const active = new Set<ChildProcess>();

const killTree = (child: ChildProcess) => {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // already gone
  }
};

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    active.add(child);
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ code, timedOut, durationMs: Math.round(performance.now() - started), tail });
    });
  });
}

export type MutateOptions = {
  repo: string;
  cwd: string; // where the test command runs, inside the repo
  base: string;
  changed: Map<string, Set<number> | "all">;
  /** Shell command; `{files}` expands to the related test files. */
  command: string;
  maxMutants: number;
  budgetMs: number;
  timeoutMs: number | null;
  env: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
};

export class BaselineFailed extends Error {
  constructor(
    readonly command: string,
    readonly tail: string,
  ) {
    super(`baseline test run failed before any mutation: ${command}`);
  }
}

const shellQuote = (value: string): string =>
  /^[\w./@:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

export async function runMutation(options: MutateOptions): Promise<MutationReport> {
  const started = performance.now();
  const { repo } = options;
  const tracked = git(repo, ["ls-files", "-co", "--exclude-standard", "-z"])
    .stdout.split("\0")
    .filter(Boolean);
  const testFiles = tracked
    .filter((file) => TEST_FILE.test(file))
    .map((file) => {
      try {
        return { file, text: readFileSync(path.join(repo, file), "utf8") };
      } catch {
        return { file, text: "" };
      }
    });
  const candidates: Omit<Mutant, "id">[] = [];
  for (const [absolute, lines] of [...options.changed].toSorted(([a], [b]) => a.localeCompare(b))) {
    const relative = toPosix(path.relative(repo, absolute));
    if (!CODE_FILE.test(relative) || TEST_FILE.test(relative) || relative.endsWith(".d.ts"))
      continue;
    if (NOT_SOURCE.test(relative) || !existsSync(absolute)) continue;
    try {
      candidates.push(...mutantsFor(readFileSync(absolute, "utf8"), relative, lines));
    } catch {
      // unparsable source: nothing to mutate
    }
  }
  const mutants: Mutant[] = candidates.map((mutant, index) => ({ ...mutant, id: index + 1 }));
  const related = new Map<string, string[]>();
  for (const mutant of mutants)
    if (!related.has(mutant.file)) related.set(mutant.file, relatedTests(mutant.file, testFiles));

  const cwdRelative = path.relative(repo, options.cwd);
  const asArg = (file: string) => {
    const relative = toPosix(path.relative(cwdRelative, file));
    return shellQuote(relative.startsWith(".") ? relative : `./${relative}`);
  };
  const commandFor = (tests: string[]) =>
    options.command.replace("{files}", tests.map(asArg).join(" "));

  const results: MutantResult[] = [];
  const counts: MutationReport["counts"] = {
    killed: 0,
    survived: 0,
    timeout: 0,
    "no-tests": 0,
    skipped: 0,
  };
  const record = (result: MutantResult) => {
    results.push(result);
    counts[result.status] += 1;
  };
  const allTests = [...new Set([...related.values()].flat())].toSorted();
  const testable = mutants.filter(
    (mutant) => (related.get(mutant.file) ?? []).length > 0 || !options.command.includes("{files}"),
  );
  // Round-robin across files so a --max-mutants sample covers every changed file.
  const byFile = new Map<string, Mutant[]>();
  for (const mutant of testable)
    byFile.set(mutant.file, [...(byFile.get(mutant.file) ?? []), mutant]);
  const runnable: Mutant[] = [];
  for (let round = 0; runnable.length < testable.length; round += 1)
    for (const list of byFile.values()) {
      const next = list[round];
      if (next) runnable.push(next);
    }
  for (const mutant of mutants)
    if (!runnable.includes(mutant))
      record({ ...mutant, status: "no-tests", durationMs: 0, tests: [] });
  if (runnable.length === 0) return finish(options, 0, results, counts, started);

  removeStaleCopies();
  const { dir: copyDir, tree: copy } = copyWorkingTree(repo);
  const copyCwd = path.join(copy, cwdRelative);
  const cleanup = () => {
    for (const child of active) killTree(child);
    rmSync(copyDir, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    const baselineCommand = commandFor(allTests);
    options.onProgress?.(`baseline: ${baselineCommand}`);
    const baseline = await runCommand(
      baselineCommand,
      copyCwd,
      Math.max(options.budgetMs, 1000),
      options.env,
    );
    if (baseline.code !== 0 || baseline.timedOut)
      throw new BaselineFailed(baselineCommand, baseline.tail);
    const timeoutMs = options.timeoutMs ?? Math.max(10_000, baseline.durationMs * 3);
    let budgetLeft = true;
    for (const [index, mutant] of runnable.entries()) {
      const tests = related.get(mutant.file) ?? [];
      if (
        index >= options.maxMutants ||
        !budgetLeft ||
        performance.now() - started > options.budgetMs
      ) {
        budgetLeft = false;
        record({ ...mutant, status: "skipped", durationMs: 0, tests });
        continue;
      }
      const target = path.join(copy, mutant.file);
      const original = readFileSync(target, "utf8");
      writeFileSync(
        target,
        original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end),
      );
      try {
        const run = await runCommand(commandFor(tests), copyCwd, timeoutMs, {
          ...options.env,
          WORKIT_MUTANT: String(mutant.id),
        });
        const status = run.timedOut ? "timeout" : run.code === 0 ? "survived" : "killed";
        record({ ...mutant, status, durationMs: run.durationMs, tests });
        options.onProgress?.(
          `#${mutant.id} ${mutant.file}:${mutant.line} ${mutant.original} -> ${mutant.replacement || "(removed)"}: ${status}`,
        );
      } finally {
        writeFileSync(target, original);
      }
    }
    return finish(options, baseline.durationMs, results, counts, started);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    cleanup();
  }
}

function finish(
  options: MutateOptions,
  baselineMs: number,
  results: MutantResult[],
  counts: MutationReport["counts"],
  started: number,
): MutationReport {
  const decided = counts.killed + counts.timeout + counts.survived;
  return {
    base: options.base,
    command: options.command,
    baselineMs,
    mutants: results.toSorted((a, b) => a.id - b.id),
    counts,
    score:
      decided === 0 ? null : Math.round(((counts.killed + counts.timeout) / decided) * 1000) / 10,
    durationMs: Math.round(performance.now() - started),
  };
}
