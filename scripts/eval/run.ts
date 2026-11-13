#!/usr/bin/env bun
/**
 * Local weak-model bench: one headless `claude -p` per case, on the
 * developer's Claude Code subscription, or one `opencode run` per case on
 * OpenCode's free then go provider, with the Workit plugin loaded from this
 * checkout. Never runs in CI. See docs/agents/eval.md.
 *
 *   bun scripts/eval/run.ts --model haiku [--tier smoke|full] [--cases a,b]
 *     [--budget-runs 3] [--repeat 1] [--force] [--bin claude] [--timeout-s 300]
 *   bun scripts/eval/run.ts --host opencode --model deepseek-v4.1-flash [...]
 *   bun scripts/eval/run.ts --replay [--host opencode] [--model haiku] [--check]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { EVAL_WORLD_ENV } from "../../packages/workit-core/src/core/eval-world";
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
import {
  checkConfinement,
  confined,
  confinementLine,
  binaryOf,
  linkedEnv,
  linkedReads,
  linkedRoots,
  readableDirs,
  toolchainDir,
  writableDirs,
  type Confinement,
} from "./confine";
import {
  carryBack,
  loginFiles,
  isolateHome,
  linkLogin,
  permitsShellWrappers,
  probe,
  selfCheck,
  type Host,
} from "./isolation";
import {
  accountIds,
  accountOf,
  committedLeaks,
  envCredentials,
  hostCredentials,
  privateHits,
  privateStrings,
  PrivateSetUnreadable,
  refusalKinds,
  rootSpellings,
  safeRoots,
  scrubAccount,
  scrubOutsideReads,
  scrubRoots,
  shownHit,
  unscrubRoots,
  workitVocabulary,
  type Account,
  type Origins,
  type PrivateSet,
  type Root,
  type Scrub,
} from "./privacy";
import { makeWorld, promptFor, sweepWorlds, type World } from "./scaffold";
import {
  accountHome,
  acquire,
  armSnapshot,
  adopt,
  checkSnapshot,
  dropJournal,
  ensureBase,
  guardFor,
  findingLines,
  inspectJournal,
  release,
  runnerIdentity,
  TripwireRefused,
  tripDetail,
  tripwireBase,
  watchedFindings,
  writeJournal,
  type Finding,
  type Guard,
  type Snapshot,
  type Trip,
} from "./tripwire";

const REPO = path.resolve(import.meta.dir, "..", "..");
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
  // Real hosts allow `cd <dir> && git status`; each chained part still needs its own rule (#793).
  "Bash(cd *)",
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
  /** Which of a case's `--repeat` runs this is, from 2 (run 1 leaves it out). */
  run?: number;
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
  /** The world failed the isolation self-check: the case never started, and the run failed. */
  refused?: "isolation" | "private_content";
  /** The run changed a real watched file (tripwire.ts): reported, nothing put back, and the run failed. */
  outsideWrite?: Trip;
  /**
   * Guarded paths another process changed while this run was under way
   * (write confinement was on, so not this bench): reported, the run went
   * on. Each path under `~`, with what happened to it.
   */
  outsideChanges?: OutsideChange[];
};

type OutsideChange = { path: string; change: "created" | "changed" | "removed" };

/** A trip as the result file records it: each path and what happened to it, no content. */
const changesOf = (trip: Trip): OutsideChange[] => [
  ...trip.findings.map((finding): OutsideChange => ({
    path: finding.path,
    change: finding.was === "absent" ? "created" : finding.now === "absent" ? "removed" : "changed",
  })),
  ...trip.reported.added.map((file): OutsideChange => ({ path: file, change: "created" })),
  ...trip.reported.changed.map((file): OutsideChange => ({ path: file, change: "changed" })),
  ...trip.reported.missing.map((file): OutsideChange => ({ path: file, change: "removed" })),
];

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

/** Run 1 keeps the plain `<case>` file names; run k > 1 is `<case>.run<k>`. */
const runBase = (id: string, run: number): string => (run === 1 ? id : `${id}.run${run}`);
const RUN_SUFFIX = /\.run\d+$/u;

/** A case passes when at least two thirds of its runs do: 1 of 1, 2 of 3, 4 of 5. */
export const passesNeeded = (runs: number): number => Math.ceil((2 * runs) / 3);

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

/**
 * Path- and user-free transcripts: the world (also as Claude's project slug),
 * the checkout, the roots the bench links to or runs a toolchain from, the
 * account's home, user and host become placeholders, and a tool result that
 * may hold what a call read outside the world keeps only its path class, its
 * length and the grader's answers about it (privacy.ts).
 */
const sanitize = (
  text: string,
  world: World,
  account: Account,
  roots: Root[],
  scrub: Scrub,
): { transcript: string; unrooted: string } => {
  // The roots become placeholders last: the refusal looks at the text before
  // they do (`unrooted`), so a placeholder never hides a private value that
  // starts with a root or contains one (privacy.ts `refusalKinds`).
  // The checkout goes first (the outside-read scrub reads `<workit>` as inside),
  // as a whole path only: a sibling dir keeps its own name.
  const unrooted = scrubOutsideReads(
    scrubAccount(
      scrubRoots(
        text
          .replaceAll(world.dir, "<world>")
          .replaceAll(world.dir.replaceAll(/[^\w]/g, "-"), "<world>"),
        [CHECKOUT],
      ),
      account,
    ),
    scrub,
  );
  return { transcript: scrubRoots(unrooted, roots), unrooted };
};

/** The checkout as a root: `<workit>` wherever a transcript names it as a whole path. */
const CHECKOUT: Root = { dir: REPO, as: "<workit>" };

/**
 * What the refusal looks at and lets through: `text` with `<workit>` put
 * back as the checkout's path (under `~` when the home holds it), and the
 * roots that count as the bench's own, the checkout among them. A private
 * value under the checkout, or beside any root, is then still seen.
 */
const refusalView = (text: string, opts: Options): { text: string; roots: Root[] } => {
  const shown = { dir: scrubAccount(REPO, opts.account), as: CHECKOUT.as };
  return {
    text: unscrubRoots(text, [shown]),
    roots: [...opts.roots, shown, ...rootSpellings([CHECKOUT], opts.account.homes)],
  };
};

/**
 * Why `files` (name to text) may not be written: each file with the kinds of
 * private string it holds. The transcript's text is the one before its roots
 * became placeholders: only a root named as a whole path is let through.
 */
const privateContent = (
  files: Record<string, string>,
  set: PrivateSet,
  roots: Root[],
): string | null => {
  const found = Object.entries(files).flatMap(([name, text]) => {
    const kinds = [...refusalKinds(text, set, roots), ...committedLeaks(text)];
    return kinds.length > 0 ? [`${name} holds ${[...new Set(kinds)].join(", ")}`] : [];
  });
  return found.length > 0 ? `${found.join("; ")}; nothing was written` : null;
};

/** The subscription login only: no API key, no parent session, Workit isolated to the world. */
export const childEnv = (world: World, binDir: string): Record<string, string> => {
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
  isolateHome(env, world.home);
  env.WORKIT_STATE_DIR = world.state;
  env.WORKIT_CONFIG_DIR = world.config;
  env[EVAL_WORLD_ENV] = world.dir;
  // The fake ytrack leads PATH; a real one further down would still find no
  // login (its config dir is the world's) and no reachable host.
  for (const key of Object.keys(env)) if (key.startsWith("YTRACK_")) delete env[key];
  env.YTRACK_CONFIG_DIR = path.join(world.dir, "ytrack-config");
  env.YTRACK_HOST = "https://youtrack.invalid";
  env.PATH = [world.bin, binDir, env.PATH ?? ""].join(path.delimiter);
  // In a linked worktree a package resolves as in a plain checkout (confine.ts `linkedEnv`).
  Object.assign(env, linkedEnv(path.join(REPO, "node_modules"), env));
  return env;
};

/**
 * Commands a segment after the `cd` may run, each with every option it may
 * take: anything else (an abbreviated long option, `--output`, `--ext-diff`,
 * `--no-index`, `grep -f`) is not read-only for sure. `-<n>` counts pass.
 */
const READ_ONLY_FLAGS: Record<string, string[]> = {
  "git status": ["-s", "--short", "-b", "--branch", "--porcelain"],
  "git log": [
    "--oneline",
    "-n",
    "--graph",
    "--decorate",
    "--stat",
    "--all",
    "--format=",
    "--pretty=",
  ],
  "git diff": ["--stat", "--cached", "--staged", "--name-only", "--name-status", "--shortstat"],
  "git show": ["--stat", "--name-only", "--oneline", "--format=", "--pretty="],
  "git rev-parse": ["--abbrev-ref", "--show-toplevel", "--git-dir"],
  ls: ["-l", "-a", "-la", "-al", "-1", "-lh"],
  cat: ["-n"],
  head: ["-n"],
  tail: ["-n"],
  grep: ["-n", "-i", "-v", "-c", "-l", "-E", "-F", "-w"],
  wc: ["-l", "-w", "-c"],
  diff: ["-u"],
  echo: [],
  pwd: [],
};

const readOnlySegment = (segment: string): boolean => {
  if (segment === "git branch --show-current") return true;
  const words = segment.split(/\s+/u);
  const git = words[0] === "git";
  const flags = READ_ONLY_FLAGS[git ? `git ${words[1]}` : (words[0] ?? "")];
  return (
    flags !== undefined &&
    words
      .slice(git ? 2 : 1)
      .every(
        (word) =>
          !word.startsWith("-") ||
          /^-\d+$/u.test(word) ||
          flags.some((flag) => (flag.endsWith("=") ? word.startsWith(flag) : word === flag)),
      )
  );
};

/**
 * `cd <dir> && <read-only>…`: Claude Code asks before any `cd` chain with git,
 * and dontAsk turns that ask into a denial a real host would not show (#793).
 * No other shell syntax, so a write cannot ride along.
 */
export const readOnlyCdChain = (command: string): boolean => {
  if (/[;|<>`$()&\n]/u.test(command.replaceAll("&&", " "))) return false;
  const [first = "", ...rest] = command.split("&&").map((part) => part.trim());
  return /^cd\s+\S+$/u.test(first) && rest.length > 0 && rest.every(readOnlySegment);
};

/** The bench's PreToolUse hook: allow a read-only `cd` chain, stay silent on anything else. */
const readOnlyCdHook = (input: string): string => {
  let command: unknown;
  try {
    command = (JSON.parse(input) as { tool_input?: { command?: unknown } }).tool_input?.command;
  } catch {
    return "";
  }
  if (typeof command !== "string" || !readOnlyCdChain(command)) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "a read-only cd chain, as a real host allows",
    },
  });
};

const HOOK_FLAG = "--read-only-cd-hook";
const PROBE_FLAG = "--isolation-probe";

/**
 * Link the host's login into the world HOME; a case that permits a shell
 * wrapper starts only after the world passes the isolation self-check.
 */
const prepare = (
  spec: EvalCase,
  opts: Options,
  world: World,
  env: Record<string, string>,
): string | null => {
  linkLogin(world.home, opts.host, opts.realHome);
  if (!permitsShellWrappers(spec, spec.allowedTools ?? DEFAULT_TOOLS)) return null;
  if (!opts.confinement.on && !opts.unconfined)
    return `the case permits a shell wrapper and write confinement is off (${opts.confinement.reason}); pass --unconfined to run it with detection only`;
  const check = selfCheck(
    world.dir,
    world.repo,
    env,
    withConfinement(opts, world, [process.execPath, import.meta.path, PROBE_FLAG]),
  );
  return check.ok
    ? null
    : `the case permits a shell wrapper and the world failed the isolation self-check: ${check.outside.join("; ")}`;
};

const REFUSED = { transcript: "", unrooted: "", exit: null, timedOut: false, limit: null };

/** What a host (or the probe) may write: its world, /dev, the temp dirs and its own credential file. */
const writeRules = (opts: Options, world: World | null): { dirs: string[]; files: string[] } => ({
  dirs: writableDirs(world?.dir ?? null, [
    opts.realHome,
    ...opts.guard.watched,
    ...opts.guard.reported,
    opts.tripwire,
  ]),
  files: loginFiles(opts.host, opts.realHome),
});

/** The host config dirs a bench host never reads (its credential file is a write rule, readable). */
const HOST_CONFIG = [".claude", ".claude.json", ".codex", ".cursor", ".config/opencode", ".pi"];

/** The account's own paths: no dir that is one, holds one or lies above one is readable or a placeholder. */
const guardedPaths = (opts: Options): string[] => [
  opts.realHome,
  ...opts.account.homes,
  ...opts.guard.watched,
  ...opts.guard.reported,
  opts.tripwire,
  ...HOST_CONFIG.map((rel) => path.join(opts.realHome, rel)),
  path.join(opts.realHome, ".local", "share", "opencode"),
];

/**
 * What a host (or the probe) may read besides what it may write: the system
 * dirs, this Workit checkout, the packages its `node_modules` link to with
 * the store they sit in (a linked worktree's main checkout `node_modules`,
 * never that checkout's source) and the toolchains it runs (bun, node, git,
 * the host binary), never the real home, its Workit dirs or host config dirs.
 */
const readRules = (opts: Options): string[] => {
  const pathEnv = process.env.PATH ?? "";
  return readableDirs(
    [
      REPO,
      ...linkedReads(path.join(REPO, "node_modules")),
      ...[process.execPath, "node", "git", opts.bin]
        .map((binary) => toolchainDir(binary, pathEnv))
        .filter((dir): dir is string => dir !== null),
      // The host binary itself, when its dir holds a protected path and is left out.
      ...[binaryOf(opts.bin, pathEnv)].filter((file): file is string => file !== null),
    ],
    guardedPaths(opts),
  );
};

/**
 * The dirs the bench itself puts a host in besides its world and this
 * checkout, each with the placeholder a transcript shows (privacy.ts `Root`):
 * the checkouts or stores this checkout's `node_modules` link into (a linked
 * worktree's main checkout, `<linked>`), and each toolchain's install dir the
 * read rules allow under the real home (`<toolchain:bun>`), each in every
 * spelling (`rootSpellings`). A path under one is the bench's own doing (an
 * error raised inside a linked package names it, and the model repeats it),
 * and it can spell a host project path or a workspace's name without holding
 * either.
 */
const benchRoots = (opts: Options): Root[] => {
  const roots = new Map<string, string>();
  const outside = (dir: string): boolean => dir !== REPO && !dir.startsWith(`${REPO}${path.sep}`);
  for (const dir of linkedRoots(path.join(REPO, "node_modules")).filter(outside))
    roots.set(dir, roots.size === 0 ? "<linked>" : `<linked-${roots.size + 1}>`);
  const pathEnv = process.env.PATH ?? "";
  const readable = new Set(readRules(opts));
  const toolchains: [string, string][] = [
    ["bun", process.execPath],
    ["node", "node"],
    ["git", "git"],
    [path.basename(opts.bin), opts.bin],
  ];
  for (const [name, binary] of toolchains) {
    const dir = toolchainDir(binary, pathEnv);
    if (
      dir &&
      readable.has(dir) &&
      dir.startsWith(`${opts.realHome}${path.sep}`) &&
      !roots.has(dir)
    )
      roots.set(dir, `<toolchain:${name}>`);
  }
  // Never the home, a dir above it or one that holds a guarded path (`safeRoots`).
  return rootSpellings(
    safeRoots(
      [...roots].map(([dir, as]) => ({ dir, as })),
      guardedPaths(opts),
    ),
    opts.account.homes,
  );
};

/**
 * Whether a change to a guarded path was made by another process: Landlock
 * write confinement was applied to the run, the change is one its rights
 * govern (content, kind, presence: `governed`, never a mode or link count),
 * and the path is not one the run's ruleset let this bench write. Then the
 * kernel refused this bench that write, so it did not make it.
 */
const notOurs = (
  opts: Options,
  confinedRun: boolean,
  change: Pick<Finding, "path" | "governed">,
): boolean => {
  if (!confinedRun || !change.governed) return false;
  const { dirs, files } = writeRules(opts, null);
  const inside = (dir: string): boolean => {
    const rel = path.relative(dir, change.path);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return !files.includes(change.path) && !dirs.some(inside);
};

/** A trip split in two: what another process changed (`notOurs`), and what stops the bench as before. */
const splitTrip = (
  opts: Options,
  confinedRun: boolean,
  trip: Trip,
): { other: Trip | null; own: Trip | null } => {
  const mine = (file: string): boolean =>
    !notOurs(opts, confinedRun, { path: file, governed: true });
  const part = (keep: (ours: boolean) => boolean): Trip | null => {
    const kept = {
      findings: trip.findings.filter((finding) => keep(!notOurs(opts, confinedRun, finding))),
      reported: {
        added: trip.reported.added.filter((file) => keep(mine(file))),
        changed: trip.reported.changed.filter((file) => keep(mine(file))),
        missing: trip.reported.missing.filter((file) => keep(mine(file))),
      },
    };
    const count =
      kept.findings.length +
      kept.reported.added.length +
      kept.reported.changed.length +
      kept.reported.missing.length;
    return count === 0 ? null : kept;
  };
  return { other: part((ours) => !ours), own: part((ours) => ours) };
};

/** How many paths a trip names. */
const tripCount = (trip: Trip): number =>
  trip.findings.length +
  trip.reported.added.length +
  trip.reported.changed.length +
  trip.reported.missing.length;

/** `cmd` behind the Landlock launcher when confinement is on; as is when it is off. */
const withConfinement = (opts: Options, world: World, cmd: string[]): string[] => {
  if (!opts.confinement.on) return cmd;
  const { dirs, files } = writeRules(opts, world);
  return confined(dirs, files, cmd, opts.confinement.reads.on ? readRules(opts) : []);
};
const benchSettings = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)} ${HOOK_FLAG}`,
          },
        ],
      },
    ],
  },
});

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
  "--settings",
  benchSettings,
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
  /** The real config and state files the tripwire guards. */
  guard: Guard;
  /** The tripwire's dir: its holders and journal (tripwire.ts). */
  tripwire: string;
  /** The in-memory snapshot armed once at bench start: the only thing restored automatically. */
  snapshot: Snapshot | null;
  /** How often a running host's restored set is re-checked (test seam: --watch-ms). */
  watchMs: number;
  /** Landlock write confinement for the host and the probe, checked once per bench start. */
  confinement: Confinement;
  /** `off` forces confinement off (test seam: --confine off). */
  confineMode: "auto" | "off";
  /** --unconfined: run shell-wrapper cases with detection only when confinement is off. */
  unconfined: boolean;
  /** The signal that asked the bench to stop, once one has. */
  stop: string | null;
  /** A run changed real Workit files: the journal stays as the user's recovery copy. */
  keepJournal: boolean;
  /** Changes to guarded paths another process made during this bench (`notOurs`): reported, never a stop. */
  otherChanges: number;
  /** The host running now, in its own process group. */
  child: RunningHost | null;
  /** Real host credential files a run's host refreshed by rename, written back (isolation.ts carryBack). */
  carried: string[];
  /** The account home the host's login is linked from. */
  realHome: string;
  /** The account's home, user and host spellings the transcripts lose. */
  account: Account;
  /** The real account's private strings, in memory only: a result holding one is not written. */
  privateSet: PrivateSet;
  /**
   * Every credential the bench host could reach and every id of the account
   * it signs in as, as read so far: the login files at start, before and
   * after each run and in each world before it goes, and the secret-named
   * variables of each host's environment. In memory only: a result holding
   * one is not written.
   */
  reachable: PrivateSet;
  /** Where each private string came from (a file and key path, never a value): a refusal's diagnosis names it. */
  origins: Origins;
  /** The salt of this bench start's hit ids: an id says "the same value", never which. */
  salt: string;
  /** The login files the current run could not read (file and reason): its result is not written. */
  unreadLogins: string[];
  /** The roots a transcript shows as placeholders besides the world and the checkout (`benchRoots`). */
  roots: Root[];
};

/** Add the credentials and account ids the host's login under `home` holds now; an unreadable login file is remembered. */
const noteCredentials = (opts: Options, home: string): void => {
  const origins = { to: opts.origins, home: home === opts.realHome ? "~" : "<world>/home" };
  try {
    for (const value of hostCredentials(home, opts.host, origins))
      opts.reachable.set(value, "host credential");
    for (const value of accountIds(home, opts.host, origins))
      if (!opts.reachable.has(value)) opts.reachable.set(value, "account id");
  } catch (error) {
    if (!(error instanceof PrivateSetUnreadable)) throw error;
    opts.unreadLogins.push(error.message);
  }
};

type Attempt = {
  /** The world failed the isolation self-check, so the case never started. */
  refused?: string;
  transcript: string;
  /** The transcript before its roots became placeholders: what the refusal looks at, in memory only. */
  unrooted: string;
  exit: number | null;
  timedOut: boolean;
  provider?: Provider;
  limit: string | null;
};

/** What the runner keeps of a running host: its pid leads its own process group. */
type RunningHost = { pid?: number };

/** SIGKILL a host's whole process group (its shells and their children too). */
const killGroup = (child: RunningHost | null): void => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is gone.
  }
};

const MAX_OUTPUT = 256 * 1024 * 1024;

/**
 * Run the host in its own process group, so a signal handler can stop it at
 * once (the runner stays responsive: no spawnSync), and a watch can kill it
 * when the restored set changes mid-run.
 */
const attempt = async (
  spec: EvalCase,
  opts: Options,
  args: string[],
  env: Record<string, string>,
  world: World,
): Promise<Omit<Attempt, "limit"> & { stderr: string }> => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const [bin = opts.bin, ...rest] = withConfinement(opts, world, [opts.bin, ...args]);
  const child = spawn(bin, rest, {
    cwd: world.repo,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  opts.child = child;
  child.stdin?.on("error", () => {});
  child.stdin?.end(promptFor(spec, world));
  child.stdout?.on("data", (chunk) => {
    if (stdout.length < MAX_OUTPUT) stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < MAX_OUTPUT) stderr += String(chunk);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child);
  }, opts.timeoutMs);
  const snapshot = opts.snapshot;
  // A change this bench could not have made (see `notOurs`) does not end the run.
  const ours = (finding: Finding): boolean => !notOurs(opts, opts.confinement.on, finding);
  const watch = setInterval(() => {
    if (snapshot && watchedFindings(snapshot).some(ours)) killGroup(child);
  }, opts.watchMs);
  const exit = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      stderr += String(error);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  clearInterval(watch);
  killGroup(child);
  opts.child = null;
  // Only Landlock read confinement says what the host could read.
  const bounded = opts.confinement.on && opts.confinement.reads.on;
  return {
    ...sanitize(stdout, world, opts.account, opts.roots, { bounded, spec }),
    stderr,
    exit,
    timedOut,
  };
};

/** Each case in a fresh world; a limited provider is dropped for the rest of the invocation. */
const runOpencode = async (spec: EvalCase, opts: Options): Promise<Attempt> => {
  let last: Attempt = { ...REFUSED };
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
      const env = opencodeEnv(childEnv(world, CLI_BIN), config, world);
      for (const value of envCredentials(env, opts.origins))
        opts.reachable.set(value, "host credential");
      const refused = prepare(spec, opts, world, env);
      if (refused) return { ...REFUSED, refused };
      const run = await attempt(spec, opts, opencodeArgs(provider), env, world);
      last = { ...run, provider, limit: limitOf(run.transcript, run.stderr) };
    } finally {
      // What the host wrote into its world's login never reaches the real home.
      noteCredentials(opts, world.home);
      opts.carried.push(...carryBack(world.home, opts.host, opts.realHome));
      rmSync(world.dir, { recursive: true, force: true });
    }
    if (last.limit === null || opts.stop) return last;
    opts.limits.push({ provider: provider.name, error: last.limit });
    opts.providers.shift();
  }
  return last;
};

const runClaude = async (spec: EvalCase, opts: Options): Promise<Attempt> => {
  const world = makeWorld(spec);
  try {
    const env = childEnv(world, path.join(opts.pluginDir, "bin"));
    for (const value of envCredentials(env, opts.origins))
      opts.reachable.set(value, "host credential");
    const refused = prepare(spec, opts, world, env);
    if (refused) return { ...REFUSED, refused };
    return {
      ...(await attempt(spec, opts, claudeArgs(spec, opts.model, opts.pluginDir), env, world)),
      limit: null,
    };
  } finally {
    // A token the host rotated by rename sits in the world until it is carried back.
    noteCredentials(opts, world.home);
    opts.carried.push(...carryBack(world.home, opts.host, opts.realHome));
    rmSync(world.dir, { recursive: true, force: true });
  }
};

/** A run that threw: what the tripwire found by then; `bench` reports it and throws `cause` on. */
class RunThrew extends Error {
  constructor(
    cause: unknown,
    readonly trip: Trip | null,
    readonly other: Trip | null,
  ) {
    super("a bench run threw", { cause });
  }
}

/**
 * One run: its result, or null when a signal stopped it (no result is
 * written), what the tripwire found, and for a `private_content` refusal
 * where each hit is (for the terminal only: it is in no stored file).
 */
const runCase = async (
  spec: EvalCase,
  key: string,
  version: string,
  opts: Options,
  index = 1,
): Promise<{ result: RunResult | null; trip: Trip | null; hits?: string[]; other?: Trip }> => {
  const snapshot = opts.snapshot;
  if (!snapshot) throw new Error("the tripwire is not armed");
  // The value a refresh during the run rotates away.
  opts.unreadLogins.length = 0;
  noteCredentials(opts, opts.realHome);
  let run: Attempt;
  try {
    run = await (opts.host === "opencode" ? runOpencode(spec, opts) : runClaude(spec, opts));
  } catch (error) {
    // As after a run that ends: only a change this bench could have made keeps
    // the journal; another process's is taken as the new state and counted.
    // `bench` reports both before the error goes on.
    const during = checkSnapshot(snapshot);
    const { other, own } = during
      ? splitTrip(opts, opts.confinement.on, during)
      : { other: null, own: null };
    if (other) {
      adopt(snapshot, other);
      opts.otherChanges += tripCount(other);
    }
    if (own) opts.keepJournal = true;
    throw new RunThrew(error, own, other);
  }
  const found = checkSnapshot(snapshot);
  // The ruleset the run really had: the launcher exits 126 without the host when it cannot apply it.
  const confinedRun = opts.confinement.on && !run.refused && run.exit !== 126;
  const { other, own: trip } = found
    ? splitTrip(opts, confinedRun, found)
    : { other: null, own: null };
  // Another process's change is reported and taken as the new state; it stops nothing.
  if (other) {
    adopt(snapshot, other);
    opts.otherChanges += tripCount(other);
  }
  // Nothing is put back: the journal stays as the user's recovery copy.
  if (trip) opts.keepJournal = true;
  if (opts.stop) return { result: null, trip, ...(other ? { other } : {}) };
  const dir = modelDir(opts.results, resultName(opts.host, opts.model));
  mkdirSync(dir, { recursive: true });
  const base = runBase(spec.id, index);
  const transcript = path.join(dir, `${base}.transcript.jsonl`);
  const skipped =
    trip === null &&
    !run.refused &&
    opts.host === "opencode" &&
    (run.provider === undefined || run.limit !== null);
  const graded = grade(run.transcript, spec);
  if (run.refused) graded.failures.unshift({ rule: "isolation", detail: run.refused });
  if (trip)
    graded.failures.unshift({
      rule: "outside_write",
      detail: `the run changed real Workit files outside its world: ${tripDetail(trip, path.relative(REPO, transcript) || transcript)}`,
    });
  const result: RunResult = {
    case: spec.id,
    ...(index > 1 ? { run: index } : {}),
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
    grade: skipped || trip || run.refused ? { ...graded, pass: false } : graded,
    ...(run.refused ? { refused: "isolation" as const } : {}),
    ...(trip ? { outsideWrite: trip } : {}),
    ...(other ? { outsideChanges: changesOf(other) } : {}),
  };
  const json = path.join(dir, `${base}.json`);
  // A trip names the real files it found changed: under `~`, as in the transcript.
  // Like the transcript, the result is looked at before its roots become placeholders.
  const unrooted = scrubAccount(JSON.stringify(result), opts.account);
  const stored = JSON.parse(scrubRoots(unrooted, opts.roots)) as RunResult;
  // The value a refresh during the run left: read again at write time.
  noteCredentials(opts, opts.realHome);
  const [unread] = opts.unreadLogins;
  // What the refusal looks at: both files before their roots became placeholders,
  // with the checkout's placeholder put back (`refusalView`).
  const view = refusalView("", opts);
  const files = {
    [path.relative(REPO, transcript) || transcript]: refusalView(run.unrooted, opts).text,
    [path.relative(REPO, json) || json]: refusalView(
      `${JSON.stringify(JSON.parse(unrooted), null, 2)}\n`,
      opts,
    ).text,
  };
  const privates = new Map([...opts.privateSet, ...opts.reachable]);
  const leaked = unread
    ? `cannot read ${unread}, so the host's credential is unknown; nothing was written`
    : privateContent(files, privates, view.roots);
  if (leaked) {
    result.grade = {
      ...result.grade,
      pass: false,
      failures: [{ rule: "private_content", detail: leaked }, ...result.grade.failures],
    };
    result.refused = "private_content";
    const hits = unread
      ? []
      : privateHits(files, privates, opts.origins, opts.salt, view.roots).map(shownHit);
    return { result, trip, hits, ...(other ? { other } : {}) };
  }
  writeFileSync(transcript, run.transcript);
  writeJson(json, stored);
  return { result, trip, ...(other ? { other } : {}) };
};

type Row = {
  case: string;
  pass: boolean;
  skipped?: "limit";
  provider?: Provider["name"];
  failures: string[];
  turns: number | null;
  costUsd: number | null;
  workitVersion: string;
  graderVersion: Grade["graderVersion"];
  /** Guarded paths another process changed during the run(s): reported, never a failure. */
  outsideChanges?: number;
};

const rowOf = (result: RunResult): Row => ({
  case: result.case,
  pass: result.grade.pass,
  ...(result.skipped ? { skipped: result.skipped } : {}),
  ...(result.provider ? { provider: result.provider } : {}),
  failures: result.grade.failures.map((failure) => failure.rule),
  turns: result.usage.turns,
  costUsd: result.usage.costUsd,
  workitVersion: result.workitVersion,
  graderVersion: result.grade.graderVersion,
  ...(result.outsideChanges ? { outsideChanges: result.outsideChanges.length } : {}),
});

/** One case's row: a single run as is; repeated runs pass on two thirds, each run listed. */
const caseRow = (runs: RunResult[]): Row & { passes?: number; runs?: Row[] } => {
  const [first] = runs as [RunResult, ...RunResult[]];
  if (runs.length === 1) return rowOf(first);
  const rows = runs.map(rowOf);
  const passes = rows.filter((row) => row.pass && !row.skipped).length;
  const sum = (key: "turns" | "costUsd") =>
    rows.some((row) => row[key] === null)
      ? null
      : rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  return {
    case: first.case,
    pass: passes >= passesNeeded(rows.length),
    ...(rows.every((row) => row.skipped) ? { skipped: "limit" as const } : {}),
    passes,
    failures: [...new Set(rows.flatMap((row) => row.failures))],
    turns: sum("turns"),
    costUsd: sum("costUsd"),
    workitVersion: first.workitVersion,
    graderVersion: first.grade.graderVersion,
    ...(rows.some((row) => row.outsideChanges)
      ? { outsideChanges: rows.reduce((total, row) => total + (row.outsideChanges ?? 0), 0) }
      : {}),
    runs: rows,
  };
};

const writeSummary = (dir: string): void => {
  if (!existsSync(dir)) return;
  const byCase = new Map<string, RunResult[]>();
  for (const name of readdirSync(dir)
    .filter((each) => each.endsWith(".json") && each !== "summary.json")
    .toSorted()) {
    const result = readResult(path.join(dir, name));
    if (!result) continue;
    byCase.set(result.case, [...(byCase.get(result.case) ?? []), result]);
  }
  const rows = [...byCase.values()].map((runs) =>
    caseRow(runs.toSorted((a, b) => (a.run ?? 1) - (b.run ?? 1))),
  );
  const skipped = rows.filter((row) => row.skipped).length;
  writeJson(path.join(dir, "summary.json"), {
    passed: rows.filter((row) => row.pass).length,
    total: rows.length,
    ...(skipped > 0 ? { skipped } : {}),
    ...(rows.some((row) => row.outsideChanges)
      ? { outsideChanges: rows.reduce((total, row) => total + (row.outsideChanges ?? 0), 0) }
      : {}),
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
      const base = file.slice(0, -".transcript.jsonl".length);
      const id = base.replace(RUN_SUFFIX, "");
      const spec = byId.get(id);
      const json = path.join(dir, `${base}.json`);
      const stored = readResult(json);
      if (!spec || !stored) {
        print(`skip ${path.basename(dir)}/${base}: no case or no result`);
        continue;
      }
      // A limited run was never graded; re-grading its stub could turn it into a pass.
      // An outside write fails the run whatever its transcript says.
      if (stored.skipped || stored.outsideWrite || stored.refused) continue;
      const fresh = grade(readFileSync(path.join(dir, file), "utf8"), spec);
      if (JSON.stringify(fresh) === JSON.stringify(stored.grade)) continue;
      drift += 1;
      print(
        `drift ${path.basename(dir)}/${base}: ${stored.grade.pass ? "pass" : "fail"} -> ${fresh.pass ? "pass" : "fail"}`,
      );
      if (!check) writeJson(json, { ...stored, grade: fresh });
    }
    if (!check) writeSummary(dir);
  }
  print(`replay: ${drift} grade(s) ${check ? "drifted" : "rewritten"}`);
  return check && drift > 0 ? 1 : 0;
};

const USAGE =
  "usage: bun scripts/eval/run.ts [--host claude-code|opencode] --model <model> [--tier smoke|full] [--cases a,b] [--budget-runs n] [--repeat n] [--force]\n" +
  "       bun scripts/eval/run.ts --replay [--host claude-code|opencode] [--model <model>] [--check]\n" +
  "       bun scripts/eval/run.ts --tripwire-discard\n" +
  "       --unconfined: run shell-wrapper cases with detection only when write confinement (Landlock) is off";

const BINS: Record<Host, string> = { "claude-code": "claude", opencode: "opencode" };

export const main = async (
  argv: string[],
  print: (text: string) => void = console.log,
): Promise<number> => {
  if (argv[0] === PROBE_FLAG) {
    print(JSON.stringify(probe()));
    return 0;
  }
  if (argv[0] === HOOK_FLAG) {
    const decision = readOnlyCdHook(readFileSync(0, "utf8"));
    if (decision) print(decision);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        host: { type: "string", default: "claude-code" },
        model: { type: "string" },
        tier: { type: "string", default: "smoke" },
        cases: { type: "string" },
        "budget-runs": { type: "string", default: "3" },
        repeat: { type: "string", default: "1" },
        force: { type: "boolean", default: false },
        replay: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        bin: { type: "string" },
        "plugin-dir": { type: "string" },
        "timeout-s": { type: "string", default: "300" },
        // Test seam: the account home whose Workit files are guarded and whose host login is linked.
        "real-home": { type: "string" },
        "tripwire-discard": { type: "boolean", default: false },
        // Test seam: how often a running host's restored set is re-checked.
        "watch-ms": { type: "string", default: "2000" },
        // Test seam: "off" skips write confinement as if Landlock were missing.
        confine: { type: "string", default: "auto" },
        unconfined: { type: "boolean", default: false },
        results: { type: "string", default: path.join(REPO, "evals", "results") },
        "cases-dir": { type: "string", default: path.join(REPO, "evals", "cases") },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch (error) {
    print(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values } = parsed;
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
  const repeat = Number(values.repeat);
  const tier = values.tier as Tier;
  const settling = values["tripwire-discard"];
  if (
    (!values.model && !settling) ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    (tier !== "smoke" && tier !== "full") ||
    !Number.isInteger(budget) ||
    budget < 0
  ) {
    print(USAGE);
    return 2;
  }
  // A real account file that exists but cannot be read would leave the set short: nothing runs.
  let privateSet: PrivateSet = new Map();
  const reachable: PrivateSet = new Map();
  const origins: Origins = new Map();
  if (!settling)
    try {
      privateSet = privateStrings(
        path.resolve(values["real-home"] ?? accountHome()),
        workitVocabulary(REPO),
        values["real-home"] ? undefined : process.env,
        origins,
      );
      const home = path.resolve(values["real-home"] ?? accountHome());
      const from = { to: origins, home: "~" };
      for (const value of accountIds(home, host, from)) reachable.set(value, "account id");
      for (const value of hostCredentials(home, host, from))
        reachable.set(value, "host credential");
    } catch (error) {
      if (!(error instanceof PrivateSetUnreadable)) throw error;
      print(`private set: cannot read ${error.message}; fix or remove it, nothing runs`);
      return 4;
    }
  const opts: Options = {
    host,
    model: values.model ?? "",
    bin: values.bin ?? BINS[host],
    pluginDir: path.resolve(values["plugin-dir"] ?? PLUGINS[host]),
    timeoutMs: Number(values["timeout-s"]) * 1000,
    results,
    providers: host === "opencode" && values.model ? providersFor(values.model) : [],
    limits: [],
    guard: values["real-home"]
      ? guardFor(path.resolve(values["real-home"]))
      : guardFor(accountHome(), process.env),
    realHome: path.resolve(values["real-home"] ?? accountHome()),
    account: accountOf(path.resolve(values["real-home"] ?? accountHome())),
    privateSet,
    reachable,
    origins,
    salt: randomBytes(16).toString("hex"),
    unreadLogins: [],
    roots: [],
    tripwire: tripwireBase(path.resolve(values["real-home"] ?? accountHome())),
    snapshot: null,
    watchMs: Number(values["watch-ms"]),
    confinement: { on: false, reason: "not checked yet" },
    confineMode: values.confine === "off" ? "off" : "auto",
    unconfined: values.unconfined,
    stop: null,
    keepJournal: false,
    otherChanges: 0,
    child: null,
    carried: [],
  };
  opts.roots = benchRoots(opts);
  return tripwired(
    opts,
    print,
    async () =>
      bench(opts, print, {
        selected: selectCases(cases, tier, values.cases?.split(",").filter(Boolean)),
        repeat,
        budget,
        force: values.force,
      }),
    { discard: values["tripwire-discard"] },
  );
};

/**
 * Hold the tripwire around `run`: take the lock, settle or report a leftover
 * journal, arm the in-memory snapshot (printing its digest on the user's
 * terminal) and write the crash journal; drop it at the end.
 */
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** `holdTripwire`, with a path the tripwire refuses (not a real dir it owns) turned into exit 4. */
const tripwired = async (
  opts: Options,
  print: (text: string) => void,
  run: () => Promise<number>,
  settleFlags: { discard: boolean },
): Promise<number> => {
  try {
    return await holdTripwire(opts, print, run, settleFlags);
  } catch (error) {
    if (!(error instanceof TripwireRefused)) throw error;
    print(`tripwire: ${error.message}; nothing was created or removed there, and nothing runs`);
    return 4;
  }
};

const holdTripwire = async (
  opts: Options,
  print: (text: string) => void,
  run: () => Promise<number>,
  settleFlags: { discard: boolean },
): Promise<number> => {
  const bad = ensureBase(opts.tripwire);
  if (bad) {
    print(`tripwire: ${bad}; nothing runs`);
    return 4;
  }
  const strange: string[] = [];
  const holder = acquire(opts.tripwire, strange);
  for (const entry of strange)
    print(`tripwire: left alone in holders/, not a runner's lock file: ${entry}`);
  if (holder !== null) {
    print(
      `another bench run (pid ${holder}) holds the tripwire at ${opts.tripwire}: two runs would report each other's changes. Wait for it, or stop it.`,
    );
    return 4;
  }
  try {
    // A dead runner's worlds (its login copies included) go first.
    const swept = sweepWorlds();
    for (const dir of swept.removed) print(`tripwire: removed a dead bench run's world ${dir}`);
    for (const why of swept.failed)
      print(`tripwire: could not remove a dead bench run's world: ${why}`);
    if (settleFlags.discard) {
      dropJournal(opts.tripwire);
      print("tripwire: the leftover journal is dropped; nothing else was touched");
      return 0;
    }
    const left = inspectJournal(opts.tripwire, opts.guard);
    if (left && left.problems.length === 0 && left.findings.length === 0) {
      print(
        `tripwire: a leftover journal (digest ${left.digest}): nothing differs from the real files; dropped`,
      );
      dropJournal(opts.tripwire);
    } else if (left) {
      print(
        [
          "LEFTOVER: real Workit files differ from the journal a bench run left (it changed them, or ended without its check). Nothing was written and no run starts.",
          ...left.problems.map((problem) => `  ${problem}`),
          ...findingLines(left.findings),
          `  journal digest ${left.digest ?? "none"}: proves nothing unless it equals the \`tripwire armed\` line the stopped run printed`,
          "  once the real files are as you want them, the next start drops it; or drop it now with --tripwire-discard",
        ].join("\n"),
      );
      return 3;
    }
    opts.snapshot = armSnapshot(opts.guard);
    print(`tripwire armed: ${opts.snapshot.files} files, digest ${opts.snapshot.digest}`);
    writeJournal(opts.tripwire, opts.snapshot);
    // The handler only flags the stop and kills the host's group; the normal
    // unwind checks against memory, removes the world and drops the journal.
    // A second signal exits at once and leaves the journal for the next start.
    const onSignal = (signal: NodeJS.Signals): void => {
      if (opts.stop) process.exit(SIGNAL_EXIT[signal] ?? 1);
      opts.stop = signal;
      killGroup(opts.child);
    };
    for (const signal of SIGNALS) process.on(signal, onSignal);
    try {
      let code = 1;
      let thrown: { error: unknown } | null = null;
      try {
        code = await run();
      } catch (error) {
        thrown = { error };
      }
      // One more look before the journal goes: a change after the last run's
      // check (a run that threw had its own, in `runCase`) is otherwise never seen. No host is
      // alive, so the policy is the bench's: confined or not.
      const late = opts.keepJournal ? null : checkSnapshot(opts.snapshot);
      if (late) {
        const { other, own } = splitTrip(opts, opts.confinement.on, late);
        if (other) {
          opts.otherChanges += tripCount(other);
          print(otherChange(other, "late"));
        }
        if (own) {
          opts.keepJournal = true;
          code = 3;
          print(
            [
              `STOPPED: real Workit files changed after the last run's check. Nothing was put back. ${tripDetail(own, "none (no run was under way)")}`,
              ...findingLines(own.findings),
            ].join("\n"),
          );
        }
      }
      if (opts.keepJournal)
        print(
          `tripwire: real Workit files changed, so the journal stays at ${opts.tripwire}/journal as your recovery copy`,
        );
      else dropJournal(opts.tripwire);
      if (thrown) throw thrown.error;
      return opts.stop ? (SIGNAL_EXIT[opts.stop] ?? 1) : code;
    } finally {
      for (const signal of SIGNALS) process.off(signal, onSignal);
    }
  } finally {
    release(opts.tripwire);
  }
};

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Every selected case, `repeat` runs each, under the tripwire `main` holds. */
const bench = async (
  opts: Options,
  print: (text: string) => void,
  {
    selected,
    repeat,
    budget,
    force,
  }: {
    selected: EvalCase[];
    repeat: number;
    budget: number;
    force: boolean;
  },
): Promise<number> => {
  const { host } = opts;
  if (opts.confineMode === "off") opts.confinement = { on: false, reason: "--confine off" };
  else {
    const { dirs, files } = writeRules(opts, null);
    opts.confinement = checkConfinement(opts.tripwire, runnerIdentity(), dirs, files, {
      dirs: readRules(opts),
      secret: opts.realHome,
    });
  }
  print(confinementLine(opts.confinement));
  const version = workitVersion(host);
  const label = host === "opencode" ? `opencode ${opts.model}` : opts.model;
  const dir = modelDir(opts.results, resultName(host, opts.model));
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
    // Runs past this --repeat belong to an older invocation: they would skew the two-thirds rule.
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const match = /^(.+)\.run(\d+)\.(json|transcript\.jsonl)$/u.exec(name);
      if (match?.[1] === spec.id && Number(match[2]) > repeat) rmSync(path.join(dir, name));
    }
    const outcomes: RunResult[] = [];
    for (let run = 1; run <= repeat; run += 1) {
      const cached = readResult(path.join(dir, `${runBase(spec.id, run)}.json`));
      if (!force && cached?.key === key && !cached.skipped) {
        outcomes.push(cached);
        print(line(cached.grade.pass ? "cached pass" : "cached FAIL", cached));
        continue;
      }
      if (runs >= budget) break;
      // With every provider at its limit the case is recorded skipped without a run.
      const callsModel = host !== "opencode" || opts.providers.length > 0;
      if (callsModel && runs === 0) ensurePlugin(host, opts.pluginDir);
      if (callsModel) runs += 1;
      // A signal is handled when the runner reaches its event loop: give it the chance.
      await new Promise((resolve) => setImmediate(resolve));
      if (opts.stop) return stopped(opts, null, print);
      let ran: Awaited<ReturnType<typeof runCase>>;
      try {
        ran = await runCase(spec, key, version, opts, run);
      } catch (error) {
        if (!(error instanceof RunThrew)) throw error;
        if (error.other) print(otherChange(error.other, "threw"));
        if (error.trip)
          print(
            [
              `STOPPED: ${spec.id} changed real Workit files outside its world, then the runner failed (its error follows). Nothing was put back; no further run starts. ${tripDetail(error.trip, "none (the failed run writes no result)")}`,
              ...findingLines(error.trip.findings),
            ].join("\n"),
          );
        throw error.cause;
      }
      const { result, trip, hits, other } = ran;
      if (other) print(otherChange(other));
      if (!result) return stopped(opts, trip, print);
      outcomes.push(result);
      print(line(result.grade.pass ? "pass" : "FAIL", result));
      if (hits && hits.length > 0)
        print(
          [
            "    where (shown here only, in no file; no value is shown; an id is salted per bench start: equal ids are one value):",
            ...hits.map((hit) => `      ${hit}`),
          ].join("\n"),
        );
      if (opts.carried.length > 0)
        print(
          `    the host refreshed its login by rename; written back to ${opts.carried.splice(0).join(", ")}`,
        );
      if (result.outsideWrite) {
        writeSummary(dir);
        print(
          [
            `STOPPED: ${spec.id} changed real Workit files outside its world. Nothing was put back; no further run starts.`,
            ...findingLines(trip?.findings ?? []),
          ].join("\n"),
        );
        return 3;
      }
    }
    if (outcomes.length < repeat) {
      skipped.push(spec.id);
      continue;
    }
    const graded = outcomes.filter((result) => !result.skipped);
    if (graded.length === 0) {
      limited.push(spec.id);
      continue;
    }
    const passes = graded.filter((result) => result.grade.pass).length;
    const pass = passes >= passesNeeded(repeat);
    if (!pass) failed += 1;
    if (repeat > 1)
      print(
        `${pass ? "pass" : "FAIL"} ${spec.id}: ${passes} of ${repeat} run(s) passed (needs ${passesNeeded(repeat)})`,
      );
  }
  writeSummary(dir);
  print(
    `${label} @ ${version}: ${runs} model run(s), ${failed} failed of ${selected.length - skipped.length - limited.length} graded${opts.confinement.on ? "" : `; write confinement off (${opts.confinement.reason}): detection only`}${opts.otherChanges > 0 ? `; ${opts.otherChanges} outside change(s) by another process, reported above` : ""}`,
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

const OTHER_WHEN = {
  run: "the run goes on, its result is written and the next bench starts",
  late: "it came after the last run's check, so no result records it, and the next bench starts",
  threw: "the run threw, so no result records it; this change stops nothing",
} as const;

/**
 * The report of a change another process made (`notOurs`): what changed and
 * where the copy taken at arm is, for the terminal: during a run (which goes
 * on), at the last check after the last run, or when a run threw.
 */
const otherChange = (trip: Trip, when: "run" | "late" | "threw" = "run"): string =>
  [
    `outside change, not this bench's: write confinement was on, so this change was made by another process; ${OTHER_WHEN[when]}. ${[
      trip.reported.added.length > 0 ? `added ${trip.reported.added.join(", ")}` : "",
      trip.reported.changed.length > 0 ? `changed ${trip.reported.changed.join(", ")}` : "",
      trip.reported.missing.length > 0 ? `missing ${trip.reported.missing.join(", ")}` : "",
      trip.findings.length > 0
        ? "nothing was put back; a file's copy from the bench start stays in the journal until this bench ends:"
        : "",
    ]
      .filter(Boolean)
      .join("; ")}`,
    ...findingLines(trip.findings.map((finding) => ({ ...finding, commands: [] }))),
  ].join("\n");

/** A signal stopped the bench: say what the tripwire found; `tripwired` exits with the signal's code. */
const stopped = (opts: Options, trip: Trip | null, print: (text: string) => void): number => {
  print(
    [
      `STOPPED by ${opts.stop}: ${trip ? tripDetail(trip, "none (the interrupted run writes no result)") : "no real Workit file changed"}`,
      ...findingLines(trip?.findings ?? []),
    ].join("\n"),
  );
  return SIGNAL_EXIT[opts.stop ?? ""] ?? 1;
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
