// Heavy commands (issue #325): which shell commands must run under the
// machine-wide heavy-check lease (core/resources.ts). The shell hook asks
// `heavyCommand` about every command an agent runs; on a heavy one it
// rewrites the command through `workit check --heavy` (hosts that can
// rewrite) or denies it with that exact rewrite (hosts that cannot).
//
// The built-in catalog covers test runners, builds and bundlers, lint and
// typecheck, installs, image builds, Sonar and browser test runners across
// JS/Go/Rust/Java/.NET/Python/Ruby/PHP/Elixir/Swift/C. Wrappers are seen
// through: package runners (`npm run`, `npx`, `pnpm exec`, `uv run`,
// `bundle exec`, `python -m`), `make` targets, and everything the hooks'
// shell reader already unwraps (`bash -c`, `flock`, `nice`, `env`, `timeout`,
// `xargs`, chains and substitutions).
//
// Extensions, both adding only: patterns in `resources.heavyCommands` of the
// repo's checks config (check-config.ts), and machine-wide patterns `workit lock heavy add`
// writes to `<state>/heavy-commands.json`. A pattern is words matched as a
// prefix of a command line (`mvn verify`), `*` inside a word matching
// anything (`test:*`).
//
// Long-running servers (`npm run dev`, `vite`, `next dev`, `docker compose
// up`) are not heavy here: a lease held for a server's lifetime would starve
// every other heavy check. `serverCommand` names them instead, and the shell
// hook routes one through the process registry (`workit run --bg`, #328).
//
// Hook-safe: node built-ins and the shell reader only, no spawn.
import fs from "node:fs";
import path from "node:path";
import { stateDir as workitStateDir } from "./workit-paths.mjs";
import { commandLines, simpleCommand } from "../hooks/raw-git";
import type { ShellDialect } from "../hooks/shell-words";
import { repoHeavyCommands } from "../check-config";
import { gitTop, names as namesWord, wrapAllowed, type RuleRead } from "./heavy-rules";

/** Workit's state dir for `env` (core/workit-paths.mjs). */
export const stateDir = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) =>
  workitStateDir(env, platform);

export const HEAVY_COMMANDS_FILE = "heavy-commands.json";
export const heavyCommandsFile = (env: NodeJS.ProcessEnv): string =>
  path.join(stateDir(env), HEAVY_COMMANDS_FILE);

/** Script and target names that test, lint, typecheck, build or serve. */
const HEAVY_SCRIPT =
  /^(?:test|tests|t|tst|unit|integration|e2e|coverage|cov|lint|eslint|typecheck|type-check|types|tsc|check|verify|validate|build|compile|bundle|ci|sonar|cypress|playwright|jest|vitest|mocha|bench|benchmark|all)(?:$|[:_.-])/iu;

const INFO_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "version"]);

/** Watch modes and scripts never end: they would hold the lease for good (#328). */
const WATCH_FLAG = /^(?:--watch(?:All)?(?:=.*)?|-w|--serve)$/u;
const WATCH_SCRIPT = /(?:^|[:_.-])(?:watch|dev|serve|start|storybook)(?:$|[:_.-])/iu;

type Rule = "any" | ReadonlySet<string>;
const sub = (...names: string[]): Rule => new Set(names);

/** Tools whose run is heavy: always (`any`), or when the subcommand is listed. */
const TOOLS: Record<string, Rule> = {
  // JS test runners, typecheck, lint, bundlers, frameworks, browsers
  jest: "any",
  vitest: "any",
  mocha: "any",
  ava: "any",
  tap: "any",
  karma: "any",
  jasmine: "any",
  nyc: "any",
  c8: "any",
  tsc: "any",
  "vue-tsc": "any",
  "svelte-check": "any",
  eslint: "any",
  stylelint: "any",
  tslint: "any",
  webpack: "any",
  "webpack-cli": "any",
  rollup: "any",
  parcel: "any",
  tsup: "any",
  vite: sub("build", "optimize"),
  next: sub("build", "lint"),
  nuxt: sub("build", "generate"),
  nuxi: sub("build", "generate"),
  astro: sub("build", "check"),
  ng: sub("build", "b", "test", "t", "e2e", "lint"),
  "react-scripts": sub("build", "test"),
  playwright: sub("test", "install"),
  cypress: sub("run"),
  wdio: "any",
  testcafe: "any",
  turbo: "any",
  lerna: sub("run", "exec", "bootstrap"),
  "sonar-scanner": "any",
  sonarless: sub("scan"),
  "sonarless-mcp": sub("scan"),
  // Go
  go: sub("test", "build", "vet", "install", "generate"),
  "golangci-lint": sub("run"),
  gotestsum: "any",
  staticcheck: "any",
  // Rust
  cargo: sub(
    "build",
    "b",
    "test",
    "t",
    "check",
    "c",
    "clippy",
    "bench",
    "nextest",
    "doc",
    "install",
    "tarpaulin",
    "llvm-cov",
  ),
  // JVM
  mvn: "any",
  mvnw: "any",
  gradle: "any",
  gradlew: "any",
  ant: "any",
  sbt: "any",
  bazel: sub("build", "test", "run", "coverage"),
  bazelisk: sub("build", "test", "run", "coverage"),
  buck2: sub("build", "test", "run"),
  // .NET
  dotnet: sub("build", "test", "publish", "restore", "pack", "msbuild"),
  msbuild: "any",
  // Python
  pytest: "any",
  "py.test": "any",
  tox: "any",
  nox: "any",
  mypy: "any",
  pyright: "any",
  pylint: "any",
  coverage: sub("run"),
  maturin: sub("build", "develop"),
  pip: sub("install", "wheel"),
  pip3: sub("install", "wheel"),
  // Ruby, PHP, Elixir, Swift, Dart
  rspec: "any",

  rails: sub("test", "assets:precompile"),
  phpunit: "any",
  pest: "any",
  phpstan: "any",
  psalm: "any",
  composer: sub("install", "update", "require", "test"),
  mix: sub("test", "compile", "deps.get", "dialyzer", "credo"),
  swift: sub("build", "test"),
  xcodebuild: "any",
  flutter: sub("build", "test"),
  dart: sub("test", "compile"),
  pod: sub("install"),
  // C and C++
  cmake: sub("--build"),
  ninja: "any",
  meson: sub("compile", "test"),
  ctest: "any",
  scons: "any",
  // Containers
  "docker-compose": sub("build"),
  buildah: sub("bud", "build"),
  earthly: "any",
};

/** Options of package managers that take a value before the subcommand. */
const PM_VALUES = new Set([
  "--prefix",
  "-w",
  "--workspace",
  "-C",
  "--dir",
  "--filter",
  "-F",
  "--cwd",
  "-p",
  "--package",
  "--cache",
  "--registry",
]);

/** The index of the first positional word after `from`, skipping options and their values. */
function positional(words: string[], from: number, values: ReadonlySet<string> = PM_VALUES) {
  let index = from;
  while (index < words.length && words[index].startsWith("-")) {
    if (words[index] === "--") return index + 1;
    index += values.has(words[index]) ? 2 : 1;
  }
  return index;
}

const baseName = (word: string | undefined): string =>
  (word?.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");

const WORKIT = /^(?:workit|@workit-dev\/cli(?:@.*)?)$/u;
const PYTHONS = /^(?:python[\d.]*|py)$/u;

const NPM_INSTALL = new Set([
  "ci",
  "clean-install",
  "cit",
  "install-test",
  "it",
  "install",
  "i",
  "in",
  "add",
  "rebuild",
  "update",
  "up",
]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_TEST = new Set(["test", "t", "tst"]);
const EXEC = new Set(["exec", "x", "dlx"]);

/** Why `words` (one command line, prefixes stripped) is heavy, or null. */
function builtIn(words: string[], depth = 0): string | null {
  if (depth > 6 || !words.length) return null;
  const name = baseName(words[0]);
  const label = () => words.slice(0, 3).join(" ");
  const inner = (from: number) => builtIn(words.slice(from), depth + 1);
  if (WORKIT.test(name)) return null;
  if (INFO_FLAGS.has(words[1] ?? "") && words.length === 2) return null;
  if (
    words.some((word) => word === "--watch" || word.startsWith("--watch=") || word === "--watchAll")
  )
    return null;
  if (name === "npx" || name === "bunx" || name === "pnpx") return inner(positional(words, 1));
  if (name === "corepack") return inner(1);
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" || name === "deno") {
    const at = positional(words, 1);
    const command = words[at];
    if (command === undefined) return name === "yarn" ? "yarn (install)" : null;
    if (name === "deno") {
      if (["test", "bench", "check", "compile", "lint"].includes(command)) return label();
      if (command === "task" && HEAVY_SCRIPT.test(words[at + 1] ?? "")) return label();
      return null;
    }
    if (NPM_INSTALL.has(command) || NPM_TEST.has(command)) return label();
    if (name === "bun" && command === "build") return label();
    if (EXEC.has(command)) return inner(positional(words, at + 1));
    if (name === "yarn" && command === "workspace") return inner(at + 2);
    if (name === "yarn" && command === "workspaces")
      return words.slice(at + 1).some((word) => HEAVY_SCRIPT.test(word)) ? label() : null;
    if (NPM_RUN.has(command)) {
      const script = words[positional(words, at + 1)];
      if (script === undefined || WATCH_SCRIPT.test(script)) return null;
      if (HEAVY_SCRIPT.test(script)) return label();
      return name === "bun" ? inner(positional(words, at + 1)) : null;
    }
    if (name === "npm") return null;
    // `pnpm <script>`, `yarn <script>`, `bun <script>`, or a package binary (`yarn jest`).
    if (WATCH_SCRIPT.test(command)) return null;
    if (HEAVY_SCRIPT.test(command) && !/\.[cm]?[jt]sx?$/u.test(command)) return label();
    return inner(at);
  }
  if (PYTHONS.test(name)) {
    const at = words.indexOf("-m");
    return at > 0 && words[at + 1] ? inner(at + 1) : null;
  }
  if (["uv", "poetry", "pdm", "pipenv", "hatch", "rye"].includes(name)) {
    const at = positional(words, 1);
    const command = words[at];
    if (command === "run") return inner(positional(words, at + 1));
    if (command === "pip") return inner(at);
    return ["sync", "install", "build", "test", "add"].includes(command ?? "") ? label() : null;
  }
  if (name === "bundle") {
    const command = words[positional(words, 1)];
    if (command === "exec") return inner(positional(words, 2));
    return command === "install" || command === undefined ? label() : null;
  }
  if (name === "make" || name === "gmake") {
    const targets = words.slice(1).filter((word) => !word.startsWith("-") && !word.includes("="));
    if (targets.some((target) => WATCH_SCRIPT.test(target))) return null;
    return !targets.length || targets.some((target) => HEAVY_SCRIPT.test(target)) ? label() : null;
  }
  if (name === "rake") {
    const targets = words.slice(1).filter((word) => !word.startsWith("-") && !word.includes("="));
    return targets.some((target) => HEAVY_SCRIPT.test(target) || /^spec(?:$|:)/u.test(target))
      ? label()
      : null;
  }
  if (name === "nx") {
    const at = positional(words, 1);
    const command = words[at] ?? "";
    if (["run-many", "affected"].includes(command))
      return words.some((word) => /^(?:-t|--targets?)(?:=|$)/u.test(word)) &&
        !words.some((word) => WATCH_SCRIPT.test(word.replace(/^--?targets?=/u, "")))
        ? label()
        : null;
    if (command === "run") {
      const target = (words[at + 1] ?? "").split(":")[1] ?? "";
      return HEAVY_SCRIPT.test(target) && !WATCH_SCRIPT.test(target) ? label() : null;
    }
    return HEAVY_SCRIPT.test(command) && !WATCH_SCRIPT.test(command) ? label() : null;
  }
  if (name === "docker" || name === "podman" || name === "nerdctl") {
    const at = positional(words, 1, new Set(["-H", "--host", "--context", "-c", "--config"]));
    const command = words[at];
    if (command === "build") return label();
    if (command === "buildx" || command === "image" || command === "builder")
      return words[positional(words, at + 1)] === "build" ? label() : null;
    if (command === "compose") {
      const at2 = positional(words, at + 1, new Set(["-f", "--file", "-p"]));
      const action = words[at2];
      if (action === "build") return label();
      return action === "up" && words.slice(at2 + 1).includes("--build") ? label() : null;
    }
    return null;
  }
  const rule = TOOLS[name];
  if (!rule) return null;
  // A tool's own watch mode (`tsc -w`, `jest --watch`, `vitest watch`).
  if (words.slice(1).some((word) => WATCH_FLAG.test(word) || word === "watch" || word === "dev"))
    return null;
  if (rule === "any") return label();
  // `cargo +nightly build`: a toolchain selector is not the subcommand.
  const command = words
    .slice(1)
    .find((word) => (!word.startsWith("-") && !word.startsWith("+")) || rule.has(word));
  return command !== undefined && rule.has(command) ? label() : null;
}

/** Script and target names that start a dev server (#328); a watch-only script is not one. */
const SERVER_SCRIPT = /(?:^|[:_.-])(?:dev|serve|start|storybook)(?:$|[:_.-])/iu;
const serverScript = (script = ""): boolean =>
  SERVER_SCRIPT.test(script) && !HEAVY_SCRIPT.test(script);

/** Tools that serve until stopped, by subcommand (`vite` with no build subcommand is one too). */
const SERVER_TOOLS: Record<string, ReadonlySet<string>> = {
  ng: sub("serve", "s"),
  next: sub("dev", "start"),
  nuxt: sub("dev", "preview", "start"),
  nuxi: sub("dev", "preview", "start"),
  astro: sub("dev", "preview"),
  "react-scripts": sub("start"),
  webpack: sub("serve", "s", "server"),
  "webpack-cli": sub("serve", "s", "server"),
  storybook: sub("dev", "start"),
  rails: sub("server", "s"),
  mix: sub("phx.server"),
};

/** `up` without `-d`/`--detach`/`--wait`: the compose run stays in the foreground. */
const composeUp = (words: string[]): boolean =>
  words[0] === "up" && !words.some((word) => /^(?:-d|--detach|--wait)$/u.test(word));

/**
 * Why `words` (one command line, prefixes stripped) starts a dev server, or
 * null: the same wrappers as `builtIn`, and only names on the launchers'
 * pre-check list (core/heavy-words.ts), so a server always reaches the gate.
 */
function serverBuiltIn(words: string[], depth = 0): string | null {
  if (depth > 6 || !words.length) return null;
  const name = baseName(words[0]);
  const label = () => words.slice(0, 3).join(" ");
  const inner = (from: number) => serverBuiltIn(words.slice(from), depth + 1);
  if (WORKIT.test(name) || words.some((word) => INFO_FLAGS.has(word) && word.startsWith("-")))
    return null;
  if (name === "npx" || name === "bunx" || name === "pnpx") return inner(positional(words, 1));
  if (name === "corepack") return inner(1);
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" || name === "deno") {
    const at = positional(words, 1);
    const command = words[at];
    if (command === undefined) return null;
    if (EXEC.has(command)) return inner(positional(words, at + 1));
    if (command === "start") return label();
    if (name === "yarn" && command === "workspace")
      return serverScript(words[at + 2]) ? label() : inner(at + 2);
    if (NPM_RUN.has(command) || (name === "deno" && command === "task")) {
      const script = words[positional(words, at + 1)];
      if (serverScript(script)) return label();
      return name === "bun" && command !== "task" ? inner(positional(words, at + 1)) : null;
    }
    if (name === "npm" || name === "deno") return null;
    return serverScript(command) ? label() : inner(at);
  }
  if (PYTHONS.test(name)) {
    const at = words.indexOf("-m");
    if (at > 0 && words[at + 1] === "http.server") return label();
    return words.some(
      (word, index) => word.endsWith("manage.py") && words[index + 1] === "runserver",
    )
      ? label()
      : at > 0 && words[at + 1]
        ? inner(at + 1)
        : null;
  }
  if (["uv", "poetry", "pdm", "pipenv", "hatch", "rye"].includes(name)) {
    const at = positional(words, 1);
    return words[at] === "run" ? inner(positional(words, at + 1)) : null;
  }
  if (name === "bundle")
    return words[positional(words, 1)] === "exec" ? inner(positional(words, 2)) : null;
  if (name === "make" || name === "gmake") {
    const targets = words.slice(1).filter((word) => !word.startsWith("-") && !word.includes("="));
    return targets.some((target) => serverScript(target)) ? label() : null;
  }
  if (name === "nx") {
    const at = positional(words, 1);
    const command = words[at] ?? "";
    const target = command === "run" ? ((words[at + 1] ?? "").split(":")[1] ?? "") : command;
    return serverScript(target) ? label() : null;
  }
  if (name === "docker" || name === "podman" || name === "nerdctl") {
    const at = positional(words, 1, new Set(["-H", "--host", "--context", "-c", "--config"]));
    if (words[at] !== "compose") return null;
    return composeUp(words.slice(positional(words, at + 1, new Set(["-f", "--file", "-p"]))))
      ? label()
      : null;
  }
  if (name === "docker-compose")
    return composeUp(words.slice(positional(words, 1, new Set(["-f", "--file", "-p"]))))
      ? label()
      : null;
  const command = words.slice(1).find((word) => !word.startsWith("-"));
  if (name === "vite") return command === "build" || command === "optimize" ? null : label();
  return command !== undefined && SERVER_TOOLS[name]?.has(command) ? label() : null;
}

/**
 * Does `command` start a dev server (#328)? The first command line that does,
 * or null. Fails open: a command the shell reader cannot analyze is none.
 */
export function serverCommand(
  command: string,
  dialect: ShellDialect = "posix",
): { line: string[]; reason: string } | null {
  for (const line of linesOf(command, dialect) ?? []) {
    const reason = serverBuiltIn(line);
    if (reason) return { line, reason };
  }
  return null;
}

const globWord = (word: string): RegExp =>
  new RegExp(`^${word.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`, "u");

/** A pattern as matchers for the words of a command line (the first by its base name). */
export function parsePattern(pattern: string): RegExp[] | null {
  const words = pattern.trim().split(/\s+/u).filter(Boolean);
  return words.length ? words.map(globWord) : null;
}

const matches = (matchers: RegExp[], words: string[]): boolean =>
  matchers.length <= words.length &&
  matchers.every((matcher, index) =>
    index === 0
      ? matcher.test(words[0]) || matcher.test(baseName(words[0]))
      : matcher.test(words[index]),
  );

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The machine-wide patterns (`workit lock heavy add`). Lenient: unreadable means none. */
export function machinePatterns(env: NodeJS.ProcessEnv): string[] {
  const value = readJson(heavyCommandsFile(env));
  return isRecord(value) ? stringList(value.patterns) : [];
}

/** `resources.heavyCommands` of the repo's checks config (the checks-config loader's file). */
export function repoPatterns(cwd: string): string[] {
  return repoHeavyCommands(gitTop(cwd) ?? path.resolve(cwd));
}

export type HeavyMatch = {
  /** The command line that made it heavy. */
  line: string[];
  /** `catalog` (built in), or the pattern that matched. */
  source: "catalog" | { pattern: string; from: "machine" | "repo" };
  reason: string;
};

export type HeavyOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  dialect?: ShellDialect;
  /** Extra patterns (tests, or a caller that already read them). */
  patterns?: Array<{ pattern: string; from: "machine" | "repo" }>;
};

/** Every heavy command line of `lines`: the catalog first, then the patterns. */
function heavyLines(lines: string[][], options: HeavyOptions): HeavyMatch[] {
  const found: HeavyMatch[] = [];
  let patterns: Array<{ pattern: string; from: "machine" | "repo"; matchers: RegExp[] }> | null =
    null;
  for (const line of lines) {
    const reason = builtIn(line);
    if (reason) {
      found.push({ line, source: "catalog", reason });
      continue;
    }
    patterns ??= (
      options.patterns ?? [
        ...machinePatterns(options.env ?? process.env).map((pattern) => ({
          pattern,
          from: "machine" as const,
        })),
        ...repoPatterns(options.cwd).map((pattern) => ({ pattern, from: "repo" as const })),
      ]
    ).flatMap((entry) => {
      const matchers = parsePattern(entry.pattern);
      return matchers ? [{ ...entry, matchers }] : [];
    });
    const hit = patterns.find((entry) => matches(entry.matchers, line));
    if (hit)
      found.push({
        line,
        source: { pattern: hit.pattern, from: hit.from },
        reason: `${hit.from} pattern "${hit.pattern}"`,
      });
  }
  return found;
}

const linesOf = (command: string, dialect: ShellDialect): string[][] | null => {
  try {
    return commandLines(command, dialect);
  } catch {
    return null;
  }
};

/**
 * Is `command` heavy? The first command line it runs that the catalog or a
 * pattern names, or null. Fails open: a command the shell reader cannot
 * analyze is not heavy.
 */
export function heavyCommand(command: string, options: HeavyOptions): HeavyMatch | null {
  const lines = linesOf(command, options.dialect ?? "posix");
  return lines ? (heavyLines(lines, options)[0] ?? null) : null;
}

export type HeavyPlan =
  | { kind: "none" }
  /** One heavy command: run `command` (the lease wrapper, or `workit run --bg` for a `server`) instead. */
  | { kind: "rewrite"; command: string; reason: string; server?: true }
  /** A chain with heavy parts: run each part alone (`unblock` is the first heavy one). */
  | { kind: "split"; reason: string; unblock: string | null }
  /** A host rule names it, or wrapping would raise it: it runs as typed, saying nothing. */
  | { kind: "passthrough"; note: "" };

export type PlanOptions = HeavyOptions & {
  /** The host's permission rules; null where the host has none to read (Pi). */
  rules: RuleRead | null;
  /** The host skips its permission prompts (Claude `bypassPermissions`). */
  bypass?: boolean;
};

const quoteWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const leaseCommand = (words: readonly string[]) =>
  `workit check --heavy -- ${words.map(quoteWord).join(" ")}`;

/**
 * What the shell hook does with `command` (ruling mvid5onk), after every
 * Workit gate passed on it: rewrite one heavy command through the lease,
 * tell a chain with heavy parts to run them alone (never `bash -c`), or step
 * aside when a host rule names it or wrapping would raise its permission.
 * Outside a git checkout, and for PowerShell, nothing changes.
 */
export function heavyPlan(command: string, options: PlanOptions): HeavyPlan {
  const dialect = options.dialect ?? "posix";
  if (dialect !== "posix" || !gitTop(options.cwd)) return { kind: "none" };
  const lines = linesOf(command, dialect);
  if (!lines) return { kind: "none" };
  const heavy = heavyLines(lines, options);
  if (!heavy.length) return { kind: "none" };
  const simple = simpleCommand(command, dialect, 0, true);
  const single = simple && !WORKIT.test(baseName(simple[0])) && heavyLines([simple], options)[0];
  const judged = single
    ? [{ words: lines.flat(), text: command }]
    : heavy.map((match) => ({
        words: match.line,
        text: match.line.join(" "),
      }));
  if (options.rules !== null)
    for (const { words, text } of judged) {
      const verdict = wrapAllowed(options.rules, words, text, { bypass: options.bypass });
      if (!verdict.ok)
        return {
          kind: "passthrough",
          note: "",
        };
    }
  if (single) {
    const rewrite = leaseRewrite(command);
    return rewrite
      ? { kind: "rewrite", command: rewrite, reason: single.reason }
      : { kind: "none" };
  }
  const parts = heavy.map((match) => leaseCommand(match.line));
  return {
    kind: "split",
    reason: `heavy_command: \`${command.trim()}\` chains heavy work (${heavy.map((match) => match.reason).join("; ")}) with other commands, and a chain cannot run under the machine-wide heavy-check lease. Run the heavy part alone, now: \`${parts[0]}\`; then run the other parts as their own commands${parts.length > 1 ? ", each heavy one the same way" : ""}.`,
    unblock: parts[0] ?? null,
  };
}

/** Could an allow cover `workit run --bg …` (a bare rule, a glob first word, a prefix of it)? */
const literalPrefix = (pattern: string): string => pattern.trim().replace(/(?::\*| \*|\*)$/u, "");
const coversRunBg = (pattern: string): boolean => {
  const words = literalPrefix(pattern).split(/[:\s]/u);
  if (!words[0] || words[0].includes("*")) return true;
  return (
    baseName(words[0]) === "workit" &&
    ["run", "--bg"].slice(0, words.length - 1).every((word, at) => word.startsWith(words[at + 1]))
  );
};

/**
 * What the shell hook does with a dev server (#328), after every Workit gate
 * passed on it: rewrite one to `workit run --bg -- <cmd>`, tell a chain that
 * starts one to start it alone, or step aside when a host rule names it or
 * the rewrite would need a prompt the command did not. Outside a git
 * checkout, and for PowerShell, nothing changes.
 */
export function serverPlan(command: string, options: PlanOptions): HeavyPlan {
  const dialect = options.dialect ?? "posix";
  if (dialect !== "posix" || !gitTop(options.cwd)) return { kind: "none" };
  const found = serverCommand(command, dialect);
  if (!found) return { kind: "none" };
  const simple = simpleCommand(command, dialect, 0, true);
  const single = simple && serverBuiltIn(simple);
  const rules = options.rules;
  if (rules !== null) {
    const words = single ? (linesOf(command, dialect) ?? []).flat() : found.line;
    const text = single ? command : found.line.join(" ");
    // As for heavy commands (#429): a deny/ask rule naming it, or an allow
    // covering the wrapper but not the command (wrapping would raise it).
    if (
      rules === "unreadable" ||
      rules.deny.some((pattern) => namesWord(pattern, words)) ||
      (!options.bypass &&
        rules.allow.some(coversRunBg) &&
        !rules.allow.some((pattern) => {
          const prefix = literalPrefix(pattern);
          return !prefix || (!prefix.includes("*") && text.trim().startsWith(prefix));
        }))
    )
      return { kind: "passthrough", note: "" };
  }
  if (single) {
    const rewrite = leaseRewrite(command)?.replace("workit check --heavy --", "workit run --bg --");
    return rewrite
      ? { kind: "rewrite", command: rewrite, reason: single, server: true }
      : { kind: "none" };
  }
  const start = `workit run --bg -- ${found.line.map(quoteWord).join(" ")}`;
  return {
    kind: "split",
    reason: `dev_server: \`${command.trim()}\` chains a dev server (${found.reason}) with other commands, and a server would never let the chain finish. Start it alone, now: \`${start}\` (it returns once the server is up and prints its port and log); then run the other parts as their own commands.`,
    unblock: start,
  };
}

/** Is a `workit` CLI on PATH? The rewrite runs it, so without one the gate stays out of the way. */
export function workitOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? ["workit.exe", "workit.cmd", "workit"] : ["workit"];
  for (const dir of (env.PATH ?? "").split(path.delimiter))
    for (const name of names) {
      if (!dir) continue;
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        // Not here.
      }
    }
  return false;
}

/** Leading `VAR=value` words, kept in front of `workit` so the command still sees them. */
const ASSIGNMENTS = /^\s*((?:[A-Za-z_]\w*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"])*\s+)*)/u;

/**
 * The lease wrapper for one simple command: `[VAR=x …] workit check --heavy
 * -- <cmd>`, the command's own text kept verbatim after `--`. It may only use
 * flags the oldest supported CLI accepts: the plugin and the CLI update
 * separately (docs/guides/verification.md), so a newer flag here would make
 * an older CLI refuse every heavy command. The CLI picks the wait itself (#508).
 */
export function leaseRewrite(command: string): string | null {
  const text = command.trim();
  const prefix = ASSIGNMENTS.exec(text)?.[1] ?? "";
  const rest = text.slice(prefix.length).trim();
  if (!rest) return null;
  return `${prefix}workit check --heavy -- ${rest}`;
}
