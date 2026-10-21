#!/usr/bin/env node
// Claude Code hook launcher (hooks/hooks.json runs `node <this file>`, exec
// form, so no shell is involved on any OS). Two layouts:
//   - local pin (`claude --plugin-dir <checkout>/packages/workit-claude-code`):
//     the monorepo sources sit next to this package, so the TypeScript entry
//     runs from source with bun: edits apply without a rebuild;
//   - installed package (npm/marketplace): dist/workit-hook.js is imported.
// WORKIT_CLAUDE_RUNTIME=source|dist forces one.
// Fail-open: when the runtime cannot start (no bun for the pin, a missing or
// unloadable dist/), the launcher answers `{}` with exit 0 and one
// `[workit] Claude Code hook unavailable: …` line on stderr. Claude then
// proceeds as if no Workit hook were installed (no context, no branch
// policy): a broken hook must never brick the host.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "run.ts");
const dist = path.join(root, "dist", "workit-hook.js");
const mode = process.env.WORKIT_CLAUDE_RUNTIME;
const fromSource =
  mode === "source" ||
  (mode !== "dist" &&
    existsSync(source) &&
    existsSync(path.join(root, "..", "workit-core", "src", "hooks", "index.ts")));

const failOpen = (reason) => {
  process.stderr.write(`[workit] Claude Code hook unavailable: ${reason}\n`);
  process.stdout.write("{}\n");
};

// Every Bash/PowerShell call and every file edit reaches this hook (branch
// policy, raw git/forge steering and the before-write gate). Fast paths
// answer `{}` before the runtime loads: a shell command with no git/gh/glab,
// no redirect and no writing verb can need none of them; with no Workit task
// store for the checkout there is no task to gate a non-git edit on; and a
// PostToolUse only matters after a `git commit`. A workit delivery verb
// (`workit pr create`, `workit ci wait`) may get the workit-ship nudge. A
// command that may be heavy (a catalog word or a pattern's first word, the
// copy of core/heavy-words.ts below) goes to the heavy-command gate.
let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);
const RAW_TOOLS = /\b(?:git|gh|glab)\b/;
const WORKIT_DELIVERY =
  /(?:^|[\s;&|(])(?:\S*[\\/])?workit(?:-cli)?\s+(?:pr (?:create|merge)|ci wait|git push)\b/;
const MAYBE_GATED =
  /\b(?:git|gh|glab)\b|>|\b(?:tee|touch|mkdir|rm|rmdir|mv|cp|truncate|install|ln|patch|dd|sed|perl|set-content|add-content|out-file|new-item|ni|remove-item|del|copy-item|move-item)\b/i;
const SHELLS = new Set(["Bash", "PowerShell"]);
const HEAVY_WORDS = new Set(
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
const wordsOf = (command) =>
  command
    .split(/[\s;&|()<>`'"]+/u)
    .map((word) =>
      (word.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, ""),
    )
    .filter(Boolean);
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const stateDir = () => {
  const env = process.env;
  if (env.WORKFLOW_TOOLKIT_STATE) return env.WORKFLOW_TOOLKIT_STATE;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "workit");
  const home = env.HOME || os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "workit");
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "workit");
  return path.join(home, ".local", "state", "workit");
};
/** Could the command be heavy? A doubt answers yes (it only costs a runtime load). */
const maybeHeavy = (command, cwd) => {
  try {
    const words = wordsOf(command);
    if (words.some((word) => HEAVY_WORDS.has(word) || /^python[\d.]*$/u.test(word))) return true;
    const patterns = [];
    const machine = readJson(path.join(stateDir(), "heavy-commands.json"));
    if (Array.isArray(machine?.patterns)) patterns.push(...machine.patterns);
    for (let dir = path.resolve(cwd), step = 0; step < 32; step += 1) {
      const repo = readJson(path.join(dir, "workit.checks.json"));
      if (repo !== undefined) {
        if (Array.isArray(repo?.resources?.heavyCommands))
          patterns.push(...repo.resources.heavyCommands);
        break;
      }
      if (existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
      dir = path.dirname(dir);
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string") continue;
      const first = wordsOf(pattern)[0];
      if (!first || first.includes("*") || words.includes(first)) return true;
    }
    return false;
  } catch {
    return true;
  }
};
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** `<git-common-dir>/workit` (or `<dir>/.workit` outside git) holds tasks. */
const hasTaskStore = (cwd) => {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!target) return true;
          gitDir = path.resolve(dir, target);
          const common = path.join(gitDir, "commondir");
          if (existsSync(common))
            gitDir = path.resolve(gitDir, readFileSync(common, "utf8").trim());
        }
        const store = path.join(gitDir, "workit");
        return (
          existsSync(path.join(store, "tasks")) || existsSync(path.join(store, "task-index.json"))
        );
      }
      if (existsSync(path.join(dir, ".workit"))) return true;
      if (path.dirname(dir) === dir) return false;
    }
  } catch {
    return true;
  }
};

const fastAllow = (() => {
  try {
    const value = JSON.parse(payload);
    const command = value?.tool_input?.command;
    if (value?.hook_event_name === "PostToolUse")
      return typeof command === "string" && !/\bcommit\b/.test(command);
    if (value?.hook_event_name !== "PreToolUse") return false;
    if (SHELLS.has(value.tool_name) && typeof command === "string") {
      if (WORKIT_DELIVERY.test(command)) return false;
      if (maybeHeavy(command, String(value.cwd ?? "."))) return false;
      if (!MAYBE_GATED.test(command)) return true;
      return !RAW_TOOLS.test(command) && !hasTaskStore(String(value.cwd ?? "."));
    }
    return EDITS.has(value.tool_name) && !hasTaskStore(String(value.cwd ?? "."));
  } catch {
    return false;
  }
})();

if (fastAllow) {
  process.stdout.write("{}\n");
} else if (fromSource) {
  const run = spawnSync(process.env.WORKIT_BUN ?? "bun", [source], {
    input: payload,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  if (run.error) failOpen(`bun is required for the local pin (${run.error.message})`);
  else process.exitCode = run.status ?? 0;
} else if (existsSync(dist)) {
  let runClaudeHook;
  try {
    ({ runClaudeHook } = await import(pathToFileURL(dist).href));
  } catch (error) {
    failOpen(`cannot load ${dist} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (runClaudeHook) process.exitCode = await runClaudeHook([payload], process.stdout);
} else {
  failOpen(`${dist} is missing; run \`bun scripts/build.ts\` in ${root}`);
}
