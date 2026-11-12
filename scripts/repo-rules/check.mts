#!/usr/bin/env bun
// Runs the repo rules (plugin.mts) under a ratchet: baseline.json holds the hits
// each file had when its rule landed, and that count may only drop.
//
//   bun scripts/repo-rules/check.mts                      fail on any hit over the baseline
//   bun scripts/repo-rules/check.mts --write              shrink the baseline to what is left
//   bun scripts/repo-rules/check.mts --grandfather <rule> seed a newly added rule's hits
//   --root <dir>, --baseline <file>                      lint another tree (tests)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RULES } from "./plugin.mts";
import { RULE as PRIVATE_NAMES, scanPrivateNames } from "./private-names.mts";

/** The oxlint rules plus the text scan oxlint cannot run on Markdown or JSON. */
const known = (rule: string): boolean => RULES[rule] !== undefined || rule === PRIVATE_NAMES;

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../..");
const CONFIG = path.join(HERE, "oxlintrc.json");
const OXLINT = path.join(REPO, "node_modules/oxlint/bin/oxlint");
const BASELINE = "scripts/repo-rules/baseline.json";
const WRITE = "bun run lint:rules --write";

export type Hit = { rule: string; file: string; line: number; column: number; message: string };
/** rule -> repo-relative file -> hits allowed. */
export type Baseline = Record<string, Record<string, number>>;
type Io = { out: (line: string) => void; err: (line: string) => void };

type Diagnostic = {
  code?: string;
  filename?: string;
  message?: string;
  labels?: { span?: { line?: number; column?: number } }[];
};

function lint(root: string): Hit[] {
  const result = spawnSync("node", [OXLINT, "-c", CONFIG, "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let parsed: { diagnostics?: Diagnostic[] } | null = null;
  try {
    parsed = JSON.parse(result.stdout ?? "") as { diagnostics?: Diagnostic[] };
  } catch {
    parsed = null;
  }
  if (parsed === null || (result.status !== 0 && result.status !== 1)) {
    const reason =
      result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`);
    throw new Error(`oxlint did not run the repo rules: ${reason.trim()}`);
  }
  const hits = (parsed.diagnostics ?? []).flatMap((diagnostic) => {
    const rule = /^workit\((.+)\)$/u.exec(diagnostic.code ?? "")?.[1];
    if (rule === undefined || diagnostic.filename === undefined) return [];
    const span = diagnostic.labels?.[0]?.span;
    return [
      {
        rule,
        file: diagnostic.filename.split(path.sep).join("/"),
        line: span?.line ?? 0,
        column: span?.column ?? 0,
        message: diagnostic.message ?? "",
      },
    ];
  });
  return [...hits, ...scanPrivateNames(root)].toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

const count = (hits: readonly Hit[]): Baseline => {
  const counts: Baseline = {};
  for (const hit of hits) {
    const files = (counts[hit.rule] ??= {});
    files[hit.file] = (files[hit.file] ?? 0) + 1;
  }
  return counts;
};

const sorted = (baseline: Baseline): Baseline =>
  Object.fromEntries(
    Object.keys(baseline)
      .toSorted()
      .map((rule) => [
        rule,
        Object.fromEntries(
          Object.entries(baseline[rule] ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
  );

type Over = { rule: string; file: string; allowed: number; hits: Hit[] };
type Stale = { rule: string; file: string; allowed: number; found: number };

export function compare(
  hits: readonly Hit[],
  baseline: Baseline,
): { over: Over[]; stale: Stale[] } {
  const found = count(hits);
  const over: Over[] = [];
  for (const [rule, files] of Object.entries(found)) {
    for (const [file, n] of Object.entries(files)) {
      const allowed = baseline[rule]?.[file] ?? 0;
      if (n > allowed)
        over.push({
          rule,
          file,
          allowed,
          hits: hits.filter((hit) => hit.rule === rule && hit.file === file),
        });
    }
  }
  const stale: Stale[] = [];
  for (const [rule, files] of Object.entries(baseline)) {
    for (const [file, allowed] of Object.entries(files)) {
      const n = !known(rule) ? 0 : (found[rule]?.[file] ?? 0);
      if (n < allowed) stale.push({ rule, file, allowed, found: n });
    }
  }
  return { over, stale };
}

/** The baseline with every entry lowered to what the code still has; it never grows. */
export function shrink(hits: readonly Hit[], baseline: Baseline): Baseline {
  const found = count(hits);
  const next: Baseline = {};
  for (const [rule, files] of Object.entries(baseline)) {
    if (!known(rule)) continue;
    for (const [file, allowed] of Object.entries(files)) {
      const n = Math.min(allowed, found[rule]?.[file] ?? 0);
      if (n > 0) (next[rule] ??= {})[file] = n;
    }
  }
  return sorted(next);
}

const total = (baseline: Baseline): number =>
  Object.values(baseline).reduce(
    (sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0),
    0,
  );

const readBaseline = (file: string): Baseline =>
  existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Baseline) : {};

const writeBaseline = (file: string, baseline: Baseline): void =>
  writeFileSync(file, `${JSON.stringify(sorted(baseline), null, 2)}\n`);

const option = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

export function main(args: readonly string[], io: Io): number {
  const root = path.resolve(option(args, "--root") ?? REPO);
  const baselineFile = path.resolve(root, option(args, "--baseline") ?? BASELINE);
  const seed = option(args, "--grandfather");
  if (seed !== undefined && !known(seed)) {
    io.err(
      `repo rules: unknown rule ${seed}; rules: ${[...Object.keys(RULES), PRIVATE_NAMES].join(", ")}`,
    );
    return 2;
  }
  let hits: Hit[];
  try {
    hits = lint(root);
  } catch (error) {
    io.err(`repo rules: ${(error as Error).message}`);
    return 2;
  }
  let baseline = readBaseline(baselineFile);
  if (seed !== undefined) {
    baseline = { ...baseline, [seed]: count(hits.filter((hit) => hit.rule === seed))[seed] ?? {} };
    writeBaseline(baselineFile, baseline);
    io.out(
      `repo rules: grandfathered workit/${seed} hits into ${path.relative(root, baselineFile)}`,
    );
  }
  if (args.includes("--write")) {
    const before = total(baseline);
    baseline = shrink(hits, baseline);
    writeBaseline(baselineFile, baseline);
    io.out(`repo rules: baseline ${before} -> ${total(baseline)} hits`);
  }
  const { over, stale } = compare(hits, baseline);
  for (const entry of over) {
    for (const hit of entry.hits)
      io.err(`${hit.file}:${hit.line}:${hit.column} workit/${hit.rule}: ${hit.message}`);
    if (entry.allowed > 0)
      io.err(
        `  ${entry.file} has ${entry.hits.length} workit/${entry.rule} hits; the baseline allows ${entry.allowed}: fix the new one`,
      );
  }
  if (stale.length > 0) {
    io.out("repo rules: fewer hits than the baseline allows; shrink it so they cannot come back:");
    for (const entry of stale)
      io.out(`  workit/${entry.rule} ${entry.file}: ${entry.allowed} -> ${entry.found}`);
    io.out(`  run: ${WRITE}`);
  }
  if (over.length > 0) {
    const n = over.reduce((sum, entry) => sum + entry.hits.length - entry.allowed, 0);
    io.err(
      `repo rules: ${n} new hit${n === 1 ? "" : "s"}. Fix each as its message says; the baseline (${path.relative(root, baselineFile)}) only shrinks.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main)
  process.exitCode = main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
