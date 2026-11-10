#!/usr/bin/env bun
/**
 * Local weak-model bench: one headless `claude -p` per case, on the
 * developer's Claude Code subscription, or one `opencode run` per case on
 * OpenCode's free then go provider, with the Workit plugin loaded from this
 * checkout. Never runs in CI. See docs/agents/eval.md.
 *
 *   bun scripts/eval/run.ts --model haiku [--tier smoke|full] [--cases a,b]
 *     [--budget-runs 3] [--force] [--bin claude] [--timeout-s 300]
 *   bun scripts/eval/run.ts --host opencode --model deepseek-v4.1-flash [...]
 *   bun scripts/eval/run.ts --replay [--host opencode] [--model haiku] [--check]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadCases, selectCases, type EvalCase, type Tier } from "./cases";
import { grade, usageOf, type Grade, type Usage } from "./grade";
import {
  limitOf,
  opencodeArgs,
  opencodeEnv,
  providersFor,
  writeOpencodeConfig,
  type Provider,
} from "./opencode";
import { makeWorld, promptFor, type World } from "./scaffold";

const REPO = path.resolve(import.meta.dir, "..", "..");
type Host = "claude-code" | "opencode";
const PLUGINS: Record<Host, string> = {
  "claude-code": path.join(REPO, "packages", "workit-claude-code"),
  opencode: path.join(REPO, "packages", "workit-opencode"),
};
/** The Claude Code plugin's `workit` shim runs this checkout's CLI; the OpenCode leg puts it first on PATH too. */
const CLI_BIN = path.join(PLUGINS["claude-code"], "bin");
/** What an agent sees from Workit: core (hooks, CLI text, skills), the CLI and the host's plugin. */
const pluginFacing = (host: Host): string[] => [
  "packages/workit-core",
  "packages/workit-cli/src",
  path.relative(REPO, PLUGINS[host]),
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
  host?: Host;
  model: string;
  /** The OpenCode provider that ran the case. */
  provider?: Provider["name"];
  /** Every provider reported its rate or quota limit: not graded, never a pass. */
  skipped?: "limit";
  limits?: { provider: Provider["name"]; error: string }[];
  workitVersion: string;
  key: string;
  date: string;
  exit: number | null;
  timedOut: boolean;
  usage: Usage;
  grade: Grade;
};

const out = (repo: string, ...args: string[]): string =>
  spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  }).stdout?.trim() ?? "";

/** The last release tag plus a hash of every plugin-facing file as it is on disk now. */
const workitVersion = (host: Host, repo = REPO): string => {
  const tag = out(repo, "describe", "--tags", "--abbrev=0") || "untagged";
  const hash = createHash("sha256");
  const files = out(repo, "ls-files", "-co", "--exclude-standard", "--", ...pluginFacing(host))
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

/** `haiku` for Claude Code, `opencode-<model>` for OpenCode: the hosts' results never mix. */
const resultName = (host: Host, model: string): string =>
  host === "opencode" ? `opencode-${model}` : model;

const modelDir = (results: string, name: string): string =>
  path.join(results, name.replaceAll(/[^\w.-]/g, "_"));

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
const childEnv = (world: World, binDir: string): Record<string, string> => {
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
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  return env;
};

/** An empty list allows nothing: the flag is left out, since it needs at least one tool. */
const allowed = (tools: string[]): string[] =>
  tools.length > 0 ? ["--allowedTools", ...tools] : [];

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
  ...allowed(spec.allowedTools ?? DEFAULT_TOOLS),
  "--disallowedTools",
  "WebFetch",
  "WebSearch",
];

/** OpenCode loads the plugin's built dist/, so the default pin is rebuilt from the sources each run. */
const ensurePlugin = (host: Host, pluginDir: string): void => {
  if (host === "opencode") {
    if (pluginDir !== PLUGINS.opencode) {
      if (!existsSync(path.join(pluginDir, "dist", "plugin.js")))
        throw new Error(`${pluginDir} has no dist/plugin.js; build it first`);
      return;
    }
    const build = spawnSync("bun", [path.join(pluginDir, "scripts", "build.ts")], {
      cwd: REPO,
      stdio: "inherit",
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    if (build.status !== 0) throw new Error("building the OpenCode plugin failed");
    return;
  }
  if (existsSync(path.join(pluginDir, "skills"))) return;
  if (pluginDir !== PLUGINS["claude-code"])
    throw new Error(`${pluginDir} has no skills/; build it first`);
  const build = spawnSync("bun", [path.join(pluginDir, "scripts", "build.ts"), "--skills-only"], {
    cwd: REPO,
    stdio: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (build.status !== 0) throw new Error("building the plugin skills failed");
};

type Options = {
  host: Host;
  model: string;
  bin: string;
  pluginDir: string;
  timeoutMs: number;
  results: string;
  /** OpenCode providers not yet at their limit in this invocation, in order. */
  providers: Provider[];
  /** The limits the dropped providers reported. */
  limits: NonNullable<RunResult["limits"]>;
};

type Attempt = {
  transcript: string;
  exit: number | null;
  timedOut: boolean;
  provider?: Provider;
  limit: string | null;
};

const attempt = (
  spec: EvalCase,
  opts: Options,
  args: string[],
  env: Record<string, string>,
  world: World,
): Omit<Attempt, "limit"> & { stderr: string } => {
  const run = spawnSync(opts.bin, args, {
    cwd: world.repo,
    env,
    input: promptFor(spec, world),
    encoding: "utf8",
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    transcript: sanitize(run.stdout ?? "", world),
    stderr: run.stderr ?? "",
    exit: run.status,
    timedOut: run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
  };
};

/** Each case in a fresh world; a limited provider is dropped for the rest of the invocation. */
const runOpencode = (spec: EvalCase, opts: Options): Attempt => {
  let last: Attempt = { transcript: "", exit: null, timedOut: false, limit: null };
  while (opts.providers.length > 0) {
    const [provider] = opts.providers;
    const world = makeWorld(spec);
    try {
      const config = writeOpencodeConfig(
        world,
        spec,
        spec.allowedTools ?? DEFAULT_TOOLS,
        opts.pluginDir,
      );
      const run = attempt(
        spec,
        opts,
        opencodeArgs(provider),
        opencodeEnv(childEnv(world, CLI_BIN), config, world),
        world,
      );
      last = { ...run, provider, limit: limitOf(run.transcript, run.stderr) };
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
    if (last.limit === null) return last;
    opts.limits.push({ provider: provider.name, error: last.limit });
    opts.providers.shift();
  }
  return last;
};

const runCase = (spec: EvalCase, key: string, version: string, opts: Options): RunResult => {
  let run: Attempt;
  if (opts.host === "opencode") run = runOpencode(spec, opts);
  else {
    const world = makeWorld(spec);
    try {
      run = {
        ...attempt(
          spec,
          opts,
          claudeArgs(spec, opts.model, opts.pluginDir),
          childEnv(world, path.join(opts.pluginDir, "bin")),
          world,
        ),
        limit: null,
      };
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  }
  const dir = modelDir(opts.results, resultName(opts.host, opts.model));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${spec.id}.transcript.jsonl`), run.transcript);
  const skipped = opts.host === "opencode" && (run.provider === undefined || run.limit !== null);
  const graded = grade(run.transcript, spec);
  const result: RunResult = {
    case: spec.id,
    ...(opts.host === "opencode" ? { host: opts.host } : {}),
    model: opts.model,
    ...(skipped ? { skipped: "limit" as const } : {}),
    ...(run.provider && !skipped ? { provider: run.provider.name } : {}),
    ...(opts.limits.length > 0 ? { limits: [...opts.limits] } : {}),
    workitVersion: version,
    key,
    date: new Date().toISOString(),
    exit: run.exit,
    timedOut: run.timedOut,
    usage: usageOf(run.transcript),
    grade: skipped ? { ...graded, pass: false } : graded,
  };
  writeJson(path.join(dir, `${spec.id}.json`), result);
  return result;
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
          ...(result.skipped ? { skipped: result.skipped } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          failures: result.grade.failures.map((failure) => failure.rule),
          turns: result.usage.turns,
          costUsd: result.usage.costUsd,
          workitVersion: result.workitVersion,
          graderVersion: result.grade.graderVersion,
        },
      ];
    });
  const skipped = rows.filter((row) => row.skipped).length;
  writeJson(path.join(dir, "summary.json"), {
    passed: rows.filter((row) => row.pass).length,
    total: rows.length,
    ...(skipped > 0 ? { skipped } : {}),
    cases: rows,
  });
  // Results are committed, so they must pass the repo's format check as written.
  const oxfmt = path.join(REPO, "node_modules", ".bin", "oxfmt");
  if (existsSync(oxfmt))
    spawnSync(oxfmt, [dir], { cwd: REPO, stdio: "ignore", timeout: 60_000, killSignal: "SIGKILL" });
};

const line = (status: string, result: RunResult): string => {
  if (result.skipped)
    return `skipped (limit) ${result.case}${(result.limits ?? [])
      .map((limit) => `\n    ${limit.provider}: ${limit.error}`)
      .join("")}`;
  const cost = result.usage.costUsd === null ? "" : ` $${result.usage.costUsd.toFixed(3)}`;
  const turns = result.usage.turns === null ? "" : ` ${result.usage.turns} turns`;
  const via = result.provider ? ` (${result.provider})` : "";
  const why = result.grade.failures
    .map((failure) => `\n    ${failure.rule}: ${failure.detail}`)
    .join("");
  return `${status} ${result.case}${via}${turns}${cost}${why}`;
};

const replay = (
  cases: EvalCase[],
  results: string,
  name: string | undefined,
  check: boolean,
  print: (text: string) => void,
): number => {
  const byId = new Map(cases.map((spec) => [spec.id, spec]));
  const dirs = name
    ? [modelDir(results, name)]
    : existsSync(results)
      ? readdirSync(results).map((each) => path.join(results, each))
      : [];
  let drift = 0;
  for (const dir of dirs.filter((each) => existsSync(each))) {
    for (const file of readdirSync(dir).filter((each) => each.endsWith(".transcript.jsonl"))) {
      const id = file.slice(0, -".transcript.jsonl".length);
      const spec = byId.get(id);
      const json = path.join(dir, `${id}.json`);
      const stored = readResult(json);
      if (!spec || !stored) {
        print(`skip ${path.basename(dir)}/${id}: no case or no result`);
        continue;
      }
      // A limited run was never graded; re-grading its stub could turn it into a pass.
      if (stored.skipped) continue;
      const fresh = grade(readFileSync(path.join(dir, file), "utf8"), spec);
      if (JSON.stringify(fresh) === JSON.stringify(stored.grade)) continue;
      drift += 1;
      print(
        `drift ${path.basename(dir)}/${id}: ${stored.grade.pass ? "pass" : "fail"} -> ${fresh.pass ? "pass" : "fail"}`,
      );
      if (!check) writeJson(json, { ...stored, grade: fresh });
    }
    if (!check) writeSummary(dir);
  }
  print(`replay: ${drift} grade(s) ${check ? "drifted" : "rewritten"}`);
  return check && drift > 0 ? 1 : 0;
};

const USAGE =
  "usage: bun scripts/eval/run.ts [--host claude-code|opencode] --model <model> [--tier smoke|full] [--cases a,b] [--budget-runs n] [--force]\n" +
  "       bun scripts/eval/run.ts --replay [--host claude-code|opencode] [--model <model>] [--check]";

const BINS: Record<Host, string> = { "claude-code": "claude", opencode: "opencode" };

export const main = (argv: string[], print: (text: string) => void = console.log): number => {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", default: "claude-code" },
      model: { type: "string" },
      tier: { type: "string", default: "smoke" },
      cases: { type: "string" },
      "budget-runs": { type: "string", default: "3" },
      force: { type: "boolean", default: false },
      replay: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      bin: { type: "string" },
      "plugin-dir": { type: "string" },
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
  const host = values.host as Host;
  if (host !== "claude-code" && host !== "opencode") {
    print(USAGE);
    return 2;
  }
  const cases = loadCases(path.resolve(values["cases-dir"]));
  const results = path.resolve(values.results);
  if (values.replay)
    return replay(
      cases,
      results,
      values.model && resultName(host, values.model),
      values.check,
      print,
    );

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
    host,
    model: values.model,
    bin: values.bin ?? BINS[host],
    pluginDir: path.resolve(values["plugin-dir"] ?? PLUGINS[host]),
    timeoutMs: Number(values["timeout-s"]) * 1000,
    results,
    providers: host === "opencode" ? providersFor(values.model) : [],
    limits: [],
  };
  const selected = selectCases(cases, tier, values.cases?.split(",").filter(Boolean));
  const version = workitVersion(host);
  const label = host === "opencode" ? `opencode ${opts.model}` : opts.model;
  const dir = modelDir(results, resultName(host, opts.model));
  let runs = 0;
  let failed = 0;
  const limited: string[] = [];
  const skipped: string[] = [];
  for (const spec of selected) {
    const key = cacheKey(
      spec,
      host === "opencode" ? `opencode/${opts.model}` : opts.model,
      version,
    );
    const cached = readResult(path.join(dir, `${spec.id}.json`));
    if (!values.force && cached?.key === key && !cached.skipped) {
      if (!cached.grade.pass) failed += 1;
      print(line(cached.grade.pass ? "cached pass" : "cached FAIL", cached));
      continue;
    }
    if (runs >= budget) {
      skipped.push(spec.id);
      continue;
    }
    // With every provider at its limit the case is recorded skipped without a run.
    const callsModel = host !== "opencode" || opts.providers.length > 0;
    if (callsModel && runs === 0) ensurePlugin(host, opts.pluginDir);
    if (callsModel) runs += 1;
    const result = runCase(spec, key, version, opts);
    if (result.skipped) limited.push(spec.id);
    else if (!result.grade.pass) failed += 1;
    print(line(result.grade.pass ? "pass" : "FAIL", result));
  }
  writeSummary(dir);
  print(
    `${label} @ ${version}: ${runs} model run(s), ${failed} failed of ${selected.length - skipped.length - limited.length} graded`,
  );
  if (limited.length > 0)
    print(
      `skipped (limit): ${limited.length} case(s) not graded, every provider reported its limit: ${limited.join(", ")}`,
    );
  if (skipped.length > 0)
    print(
      `incomplete: ${skipped.length} case(s) not run, budget spent (--budget-runs ${budget}): ${skipped.join(", ")}`,
    );
  if (runs > 0)
    print(`results: ${path.relative(REPO, dir) || dir}; commit them with the change they measure`);
  return failed > 0 || limited.length > 0 ? 1 : 0;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
