// The hook launchers' pre-check for the heavy-command gate (#325): could
// this shell command be heavy? A launcher answers light commands before the
// Workit runtime loads, so this only looks for a catalog word (core/heavy.ts
// TOOLS plus the runners it looks through) or the first word of a machine or
// repo pattern, with node built-ins. A false yes only costs a runtime load.
// packages/workit-claude-code/bin/workit-hook.mjs keeps a copy (it cannot
// import TypeScript); test/workit-core/heavy-words.test.ts keeps them equal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoHeavyCommands } from "../check-config";

export const HEAVY_WORDS: ReadonlySet<string> = new Set(
  (
    "npm npx pnpm pnpx yarn bun bunx deno corepack make gmake docker podman nerdctl " +
    "python python3 py uv poetry pdm pipenv hatch rye bundle rake nx " +
    "jest vitest mocha ava tap karma jasmine nyc c8 tsc vue-tsc svelte-check eslint stylelint " +
    "tslint webpack webpack-cli rollup parcel tsup vite next nuxt nuxi astro ng react-scripts " +
    "playwright cypress wdio testcafe turbo lerna sonar-scanner sonarless sonarless-mcp go " +
    "golangci-lint gotestsum staticcheck cargo mvn mvnw gradle gradlew ant sbt bazel bazelisk " +
    "buck2 dotnet msbuild pytest py.test tox nox mypy pyright pylint coverage maturin pip pip3 " +
    "rspec rails phpunit pest phpstan psalm composer mix swift xcodebuild flutter dart pod cmake " +
    "ninja meson ctest scons docker-compose buildah earthly"
  ).split(" "),
);

const wordsOf = (command: string): string[] =>
  command
    .split(/[\s;&|()<>`'"]+/u)
    .map((word) =>
      (word.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, ""),
    )
    .filter(Boolean);

const stateDir = (env: NodeJS.ProcessEnv): string => {
  if (env.WORKFLOW_TOOLKIT_STATE) return env.WORKFLOW_TOOLKIT_STATE;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "workit");
  const home = env.HOME || os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "workit");
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "workit");
  return path.join(home, ".local", "state", "workit");
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** First words of the machine and repo patterns; null when one could match anything. */
const patternWords = (cwd: string, env: NodeJS.ProcessEnv): Set<string> | null => {
  const patterns: unknown[] = [];
  const machine = readJson(path.join(stateDir(env), "heavy-commands.json")) as
    | { patterns?: unknown }
    | undefined;
  if (Array.isArray(machine?.patterns)) patterns.push(...machine.patterns);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      patterns.push(...repoHeavyCommands(dir));
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  const words = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const first = wordsOf(pattern)[0];
    if (!first || first.includes("*")) return null;
    words.add(first);
  }
  return words;
};

/** Could `command` be heavy? Never throws; a doubt answers yes. */
export function maybeHeavy(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const words = wordsOf(command);
    if (words.some((word) => HEAVY_WORDS.has(word) || /^python[\d.]*$/u.test(word))) return true;
    const extra = patternWords(cwd, env);
    return extra === null || words.some((word) => extra.has(word));
  } catch {
    return true;
  }
}
