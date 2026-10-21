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
// repo's workit.checks.json, and machine-wide patterns `workit lock heavy add`
// writes to `<state>/heavy-commands.json`. A pattern is words matched as a
// prefix of a command line (`mvn verify`), `*` inside a word matching
// anything (`test:*`).
//
// Long-running servers (`npm run dev`, `vite`, `next dev`, `docker compose
// up`) are not heavy here: a lease held for a server's lifetime would starve
// every other heavy check. They belong to the dev-server registry (#328).
//
// Hook-safe: node built-ins and the shell reader only, no spawn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandLines } from "../hooks/raw-git";
import { segmentsOf, type ShellDialect } from "../hooks/shell-words";

/** Workit's state dir for `env` (the logger's resolution, over an explicit env). */
export function stateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  if (env.WORKFLOW_TOOLKIT_STATE) return env.WORKFLOW_TOOLKIT_STATE;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "workit");
  const home = env.HOME || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "workit");
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "workit");
  return path.join(home, ".local", "state", "workit");
}

export const HEAVY_COMMANDS_FILE = "heavy-commands.json";
export const heavyCommandsFile = (env: NodeJS.ProcessEnv): string =>
  path.join(stateDir(env), HEAVY_COMMANDS_FILE);

/** Script and target names that test, lint, typecheck, build or serve. */
const HEAVY_SCRIPT =
  /^(?:test|tests|t|tst|unit|integration|e2e|coverage|cov|lint|eslint|typecheck|type-check|types|tsc|check|verify|validate|build|compile|bundle|ci|storybook|sonar|cypress|playwright|jest|vitest|mocha|bench|benchmark|all)(?:$|[:_.-])/iu;

const INFO_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "version"]);

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
  storybook: sub("build"),
  "build-storybook": "any",
  playwright: sub("test", "install"),
  cypress: sub("run"),
  wdio: "any",
  testcafe: "any",
  turbo: "any",
  nx: "any",
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
  rake: "any",
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

const WORKIT = /^(?:workit|@brainervirus\/workit-cli(?:@.*)?)$/u;
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
      if (script === undefined) return null;
      if (HEAVY_SCRIPT.test(script)) return label();
      return name === "bun" ? inner(positional(words, at + 1)) : null;
    }
    if (name === "npm") return null;
    // `pnpm <script>`, `yarn <script>`, `bun <script>`, or a package binary (`yarn jest`).
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
    return !targets.length || targets.some((target) => HEAVY_SCRIPT.test(target)) ? label() : null;
  }
  if (name === "docker" || name === "podman" || name === "nerdctl") {
    const at = positional(words, 1, new Set(["-H", "--host", "--context", "-c", "--config"]));
    const command = words[at];
    if (command === "build") return label();
    if (command === "buildx" || command === "image" || command === "builder")
      return words[positional(words, at + 1)] === "build" ? label() : null;
    if (command === "compose") {
      const action = words[positional(words, at + 1, new Set(["-f", "--file", "-p"]))];
      return action === "build" ? label() : null;
    }
    return null;
  }
  const rule = TOOLS[name];
  if (!rule) return null;
  if (rule === "any") return label();
  const command = words.slice(1).find((word) => !word.startsWith("-") || rule.has(word));
  return command !== undefined && rule.has(command) ? label() : null;
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

/** `resources.heavyCommands` of the nearest workit.checks.json, up to the repository top. */
export function repoPatterns(cwd: string): string[] {
  let dir = path.resolve(cwd);
  for (let step = 0; step < 32; step += 1) {
    const value = readJson(path.join(dir, "workit.checks.json"));
    if (value !== undefined)
      return isRecord(value) && isRecord(value.resources)
        ? stringList(value.resources.heavyCommands)
        : [];
    if (fs.existsSync(path.join(dir, ".git"))) return [];
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
  return [];
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

/**
 * Is `command` heavy? The first command line it runs that the catalog or a
 * pattern names, or null. Fails open: a command the shell reader cannot
 * analyze is not heavy.
 */
export function heavyCommand(command: string, options: HeavyOptions): HeavyMatch | null {
  let lines: string[][];
  try {
    lines = commandLines(command, options.dialect ?? "posix");
  } catch {
    return null;
  }
  if (!lines.length) return null;
  for (const line of lines) {
    const reason = builtIn(line);
    if (reason) return { line, source: "catalog", reason };
  }
  const patterns = options.patterns ?? [
    ...machinePatterns(options.env ?? process.env).map((pattern) => ({
      pattern,
      from: "machine" as const,
    })),
    ...repoPatterns(options.cwd).map((pattern) => ({ pattern, from: "repo" as const })),
  ];
  for (const { pattern, from } of patterns) {
    const matchers = parsePattern(pattern);
    if (!matchers) continue;
    const line = lines.find((words) => matches(matchers, words));
    if (line) return { line, source: { pattern, from }, reason: `${from} pattern "${pattern}"` };
  }
  return null;
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

const SIMPLE_WORD = /^[\w@%+=:,./-]+$/u;
const posixQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The command that runs `command` under the lease: `workit check --heavy --
 * <cmd>` for one plain command (no shell syntax, no env prefix), else the
 * whole line in bash (`workit check --heavy -- bash -c '<cmd>'`), the shell
 * the hosts' Bash tools run, so bash syntax keeps working. PowerShell lines
 * go through `--shell`.
 */
export function leaseRewrite(command: string, dialect: ShellDialect = "posix"): string {
  const text = command.trim();
  let plain = false;
  try {
    const segments = segmentsOf(text, dialect);
    plain =
      dialect === "posix" &&
      segments.length === 1 &&
      !segments[0].redirects.length &&
      !segments[0].subs?.length &&
      !segments[0].stdin?.length &&
      !segments[0].pipe &&
      !segments[0].group &&
      !/^[A-Za-z_]\w*=/u.test(segments[0].words[0] ?? "") &&
      text.split(/\s+/u).every((word) => SIMPLE_WORD.test(word));
  } catch {
    plain = false;
  }
  if (plain) return `workit check --heavy -- ${text.split(/\s+/u).join(" ")}`;
  if (dialect === "powershell")
    return `workit check --heavy --shell -- '${text.replaceAll("'", "''")}'`;
  return `workit check --heavy -- bash -c ${posixQuote(text)}`;
}
