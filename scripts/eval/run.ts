#!/usr/bin/env bun
/**
 * Local weak-model bench: one headless `claude -p` per case, on the
 * developer's Claude Code subscription, with the Workit plugin loaded from
 * this checkout. Never runs in CI. See docs/agents/eval.md.
 *
 *   bun scripts/eval/run.ts --model haiku [--tier smoke|full] [--cases a,b]
 *     [--budget-runs 3] [--force] [--bin claude] [--timeout-s 300]
 *   bun scripts/eval/run.ts --replay [--model haiku] [--check]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadCases, selectCases, type EvalCase, type Tier } from "./cases";
import { grade, usageOf, type Grade, type Usage } from "./grade";
import { makeWorld, promptFor, type World } from "./scaffold";

const REPO = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_PLUGIN = path.join(REPO, "packages", "workit-claude-code");
/** What an agent sees from Workit: core (hooks, CLI text, skills), the CLI and the plugin. */
const PLUGIN_FACING = [
  "packages/workit-core",
  "packages/workit-cli/src",
  "packages/workit-claude-code",
];
const DEFAULT_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Skill",
  "Agent",
  "Bash(workit *)",
  "Bash(git *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(grep *)",
  "Bash(wc *)",
  "Bash(diff *)",
  "Bash(echo *)",
  "Bash(pwd)",
];

type RunResult = {
  case: string;
  model: string;
  workitVersion: string;
  key: string;
  date: string;
  exit: number | null;
  timedOut: boolean;
  usage: Usage;
  grade: Grade;
};

const out = (repo: string, ...args: string[]): string =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout?.trim() ?? "";

/** The last release tag plus a hash of every plugin-facing file as it is on disk now. */
const workitVersion = (repo = REPO): string => {
  const tag = out(repo, "describe", "--tags", "--abbrev=0") || "untagged";
  const hash = createHash("sha256");
  const files = out(repo, "ls-files", "-co", "--exclude-standard", "--", ...PLUGIN_FACING)
    .split("\n")
    .filter(Boolean)
    .toSorted();
  for (const file of files) {
    const full = path.join(repo, file);
    if (!existsSync(full)) continue;
    hash.update(`${file}\0`);
    hash.update(readFileSync(full));
  }
  return `${tag}+${hash.digest("hex").slice(0, 10)}`;
};

const cacheKey = (spec: EvalCase, model: string, version: string): string =>
  createHash("sha256").update(JSON.stringify({ spec, model, version })).digest("hex").slice(0, 16);

const modelDir = (results: string, model: string): string =>
  path.join(results, model.replaceAll(/[^\w.-]/g, "_"));

const readResult = (file: string): RunResult | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunResult;
  } catch {
    return null;
  }
};

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Path- and user-free transcripts: the world (also as Claude's project slug), the checkout, HOME and the login name become placeholders. */
const sanitize = (text: string, world: World): string =>
  text
    .replaceAll(world.dir, "<world>")
    .replaceAll(world.dir.replaceAll(/[^\w]/g, "-"), "<world>")
    .replaceAll(REPO, "<workit>")
    .replaceAll(os.homedir(), "~")
    .replaceAll(os.userInfo().username, "<user>");

/** The subscription login only: no API key, no parent session, Workit isolated to the world. */
const childEnv = (world: World, pluginDir: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("WORKIT_")) continue;
    if (
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_PROJECT_DIR",
      ].includes(key)
    )
      continue;
    env[key] = value;
  }
  env.WORKIT_STATE_DIR = world.state;
  env.WORKIT_CONFIG_DIR = world.config;
  env.PATH = `${path.join(pluginDir, "bin")}${path.delimiter}${env.PATH ?? ""}`;
  return env;
};

const claudeArgs = (spec: EvalCase, model: string, pluginDir: string): string[] => [
  "-p",
  "--model",
  model,
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  String(spec.maxTurns ?? 10),
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--plugin-dir",
  pluginDir,
  "--permission-mode",
  spec.permissionMode ?? "dontAsk",
  "--allowedTools",
  ...(spec.allowedTools ?? DEFAULT_TOOLS),
  "--disallowedTools",
  "WebFetch",
  "WebSearch",
];

const ensureSkills = (pluginDir: string): void => {
  if (existsSync(path.join(pluginDir, "skills"))) return;
  if (pluginDir !== DEFAULT_PLUGIN) throw new Error(`${pluginDir} has no skills/; build it first`);
  const build = spawnSync("bun", [path.join(pluginDir, "scripts", "build.ts"), "--skills-only"], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("building the plugin skills failed");
};

type Options = {
  model: string;
  bin: string;
  pluginDir: string;
  timeoutMs: number;
  results: string;
};

const runCase = (spec: EvalCase, key: string, version: string, opts: Options): RunResult => {
  const world = makeWorld(spec);
  try {
    const run = spawnSync(opts.bin, claudeArgs(spec, opts.model, opts.pluginDir), {
      cwd: world.repo,
      env: childEnv(world, opts.pluginDir),
      input: promptFor(spec, world),
      encoding: "utf8",
      timeout: opts.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
    const transcript = sanitize(run.stdout ?? "", world);
    const dir = modelDir(opts.results, opts.model);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${spec.id}.transcript.jsonl`), transcript);
    const result: RunResult = {
      case: spec.id,
      model: opts.model,
      workitVersion: version,
      key,
      date: new Date().toISOString(),
      exit: run.status,
      timedOut:
        run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
      usage: usageOf(transcript),
      grade: grade(transcript, spec),
    };
    writeJson(path.join(dir, `${spec.id}.json`), result);
    return result;
  } finally {
    rmSync(world.dir, { recursive: true, force: true });
  }
};

const writeSummary = (dir: string): void => {
  if (!existsSync(dir)) return;
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "summary.json")
    .toSorted()
    .flatMap((name) => {
      const result = readResult(path.join(dir, name));
      if (!result) return [];
      return [
        {
          case: result.case,
          pass: result.grade.pass,
          failures: result.grade.failures.map((failure) => failure.rule),
          turns: result.usage.turns,
          costUsd: result.usage.costUsd,
          workitVersion: result.workitVersion,
          graderVersion: result.grade.graderVersion,
        },
      ];
    });
  writeJson(path.join(dir, "summary.json"), {
    passed: rows.filter((row) => row.pass).length,
    total: rows.length,
    cases: rows,
  });
};

const line = (status: string, result: RunResult): string => {
  const cost = result.usage.costUsd === null ? "" : ` $${result.usage.costUsd.toFixed(3)}`;
  const turns = result.usage.turns === null ? "" : ` ${result.usage.turns} turns`;
  const why = result.grade.failures
    .map((failure) => `\n    ${failure.rule}: ${failure.detail}`)
    .join("");
  return `${status} ${result.case}${turns}${cost}${why}`;
};

const replay = (
  cases: EvalCase[],
  results: string,
  model: string | undefined,
  check: boolean,
  print: (text: string) => void,
): number => {
  const byId = new Map(cases.map((spec) => [spec.id, spec]));
  const dirs = model
    ? [modelDir(results, model)]
    : existsSync(results)
      ? readdirSync(results).map((name) => path.join(results, name))
      : [];
  let drift = 0;
  for (const dir of dirs.filter((each) => existsSync(each))) {
    for (const name of readdirSync(dir).filter((each) => each.endsWith(".transcript.jsonl"))) {
      const id = name.slice(0, -".transcript.jsonl".length);
      const spec = byId.get(id);
      const file = path.join(dir, `${id}.json`);
      const stored = readResult(file);
      if (!spec || !stored) {
        print(`skip ${path.basename(dir)}/${id}: no case or no result`);
        continue;
      }
      const fresh = grade(readFileSync(path.join(dir, name), "utf8"), spec);
      if (JSON.stringify(fresh) === JSON.stringify(stored.grade)) continue;
      drift += 1;
      print(
        `drift ${path.basename(dir)}/${id}: ${stored.grade.pass ? "pass" : "fail"} -> ${fresh.pass ? "pass" : "fail"}`,
      );
      if (!check) writeJson(file, { ...stored, grade: fresh });
    }
    if (!check) writeSummary(dir);
  }
  print(`replay: ${drift} grade(s) ${check ? "drifted" : "rewritten"}`);
  return check && drift > 0 ? 1 : 0;
};

const USAGE =
  "usage: bun scripts/eval/run.ts --model <model> [--tier smoke|full] [--cases a,b] [--budget-runs n] [--force]\n" +
  "       bun scripts/eval/run.ts --replay [--model <model>] [--check]";

export const main = (argv: string[], print: (text: string) => void = console.log): number => {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      tier: { type: "string", default: "smoke" },
      cases: { type: "string" },
      "budget-runs": { type: "string", default: "3" },
      force: { type: "boolean", default: false },
      replay: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      bin: { type: "string", default: "claude" },
      "plugin-dir": { type: "string", default: DEFAULT_PLUGIN },
      "timeout-s": { type: "string", default: "300" },
      results: { type: "string", default: path.join(REPO, "evals", "results") },
      "cases-dir": { type: "string", default: path.join(REPO, "evals", "cases") },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    print(USAGE);
    return 0;
  }
  const cases = loadCases(path.resolve(values["cases-dir"]));
  const results = path.resolve(values.results);
  if (values.replay) return replay(cases, results, values.model, values.check, print);

  const budget = Number(values["budget-runs"]);
  const tier = values.tier as Tier;
  if (
    !values.model ||
    (tier !== "smoke" && tier !== "full") ||
    !Number.isInteger(budget) ||
    budget < 0
  ) {
    print(USAGE);
    return 2;
  }
  const opts: Options = {
    model: values.model,
    bin: values.bin,
    pluginDir: path.resolve(values["plugin-dir"]),
    timeoutMs: Number(values["timeout-s"]) * 1000,
    results,
  };
  const selected = selectCases(cases, tier, values.cases?.split(",").filter(Boolean));
  const version = workitVersion();
  const dir = modelDir(results, opts.model);
  let runs = 0;
  let failed = 0;
  const skipped: string[] = [];
  for (const spec of selected) {
    const key = cacheKey(spec, opts.model, version);
    const cached = readResult(path.join(dir, `${spec.id}.json`));
    if (!values.force && cached?.key === key) {
      if (!cached.grade.pass) failed += 1;
      print(line(cached.grade.pass ? "cached pass" : "cached FAIL", cached));
      continue;
    }
    if (runs >= budget) {
      skipped.push(spec.id);
      continue;
    }
    if (runs === 0) ensureSkills(opts.pluginDir);
    runs += 1;
    const result = runCase(spec, key, version, opts);
    if (!result.grade.pass) failed += 1;
    print(line(result.grade.pass ? "pass" : "FAIL", result));
  }
  writeSummary(dir);
  print(
    `${opts.model} @ ${version}: ${runs} model run(s), ${failed} failed of ${selected.length - skipped.length} graded`,
  );
  if (skipped.length > 0)
    print(
      `incomplete: ${skipped.length} case(s) not run, budget spent (--budget-runs ${budget}): ${skipped.join(", ")}`,
    );
  if (runs > 0)
    print(`results: ${path.relative(REPO, dir) || dir}; commit them with the change they measure`);
  return failed > 0 ? 1 : 0;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
