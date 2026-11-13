#!/usr/bin/env node
// Claude Code hook launcher (hooks/hooks.json runs `node <this file>`, exec
// form, so no shell is involved on any OS). Two layouts:
//   - local pin (`claude --plugin-dir <checkout>/packages/workit-claude-code`):
//     the monorepo sources sit next to this package, so the TypeScript entry
//     runs from source with bun: edits apply without a rebuild;
//   - installed package (npm/marketplace): dist/workit-hook.js is imported.
// WORKIT_CLAUDE_RUNTIME=source|dist forces one.
// Fail-open, never silent: when the runtime cannot start (a Node below the
// floor, no bun for the pin, a missing or unloadable dist/, a crash), the
// launcher exits 0 with one `[workit] Claude Code hook unavailable: …` line on
// stderr and records a failure row (`<state>/hook-runs/claude_code__<event>__failed.json`,
// the format of workit-core hooks/hook-runs.ts) that `workit doctor` reads.
// SessionStart, UserPromptSubmit and SubagentStart answer with a systemMessage
// (shown to the user) and additionalContext (read by the agent) naming the
// cause and the fix; every other event answers `{}`, so Claude proceeds as if
// no Workit hook were installed: a broken hook must never brick the host.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { floorMessage, floorOfRange, handleBelowFloor } from "./node-resolve.mjs";
import {
  configDir as workitConfigDir,
  migrateLegacyDirs,
  stateDir as workitStateDir,
} from "./workit-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "run.ts");
const dist = path.join(root, "dist", "workit-hook.js");
const mode = process.env.WORKIT_CLAUDE_RUNTIME;
const fromSource =
  mode === "source" ||
  (mode !== "dist" &&
    existsSync(source) &&
    existsSync(path.join(root, "..", "workit-core", "src", "hooks", "index.ts")));

const stateDir = () => workitStateDir(process.env);

/** A hook-runs failure row, as workit-core hooks/hook-runs.ts recordHookFailure writes it. */
const recordFailure = (event, cause) => {
  try {
    const name = typeof event === "string" && event ? event : "unknown";
    const safe = (part) => part.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
    const file = path.join(stateDir(), "hook-runs", `claude_code__${safe(name)}__failed.json`);
    let count = 0;
    try {
      const previous = JSON.parse(readFileSync(file, "utf8")).count;
      if (typeof previous === "number" && Number.isFinite(previous)) count = previous;
    } catch {
      // First failure, or a torn file.
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        host: "claude_code",
        event: name,
        at: new Date().toISOString(),
        count: count + 1,
        failure: String(cause).slice(0, 500),
      }),
    );
  } catch {
    // The answer still goes out; only the doctor row is lost.
  }
};

const LOUD_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);
const SUBAGENT_NOTE =
  " This subagent got no Workit session: a verifier or reviewer cannot record a verdict (it fails with no_session) until the hook runs; fix the hook, run `workit doctor`, then spawn a fresh one.";

/** The answer a hook that could not run gives `event`: loud where Claude shows it, else `{}`. */
const failedAnswer = (event, text) => {
  if (!LOUD_EVENTS.has(event)) return {};
  const message = event === "SubagentStart" ? `${text}${SUBAGENT_NOTE}` : text;
  return {
    systemMessage: message,
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  };
};

const failOpen = (reason) => {
  process.stderr.write(`[workit] Claude Code hook unavailable: ${reason}\n`);
  const event = parsed?.hook_event_name;
  recordFailure(event, reason);
  process.stdout.write(
    `${JSON.stringify(
      failedAnswer(
        event,
        `Workit hooks are off: the Claude Code hook could not run (${reason}). Branch policy, task context and verifier sessions are off until it does. Run \`workit upgrade\` to reinstall the plugin, then \`workit doctor\` (check hook_node runs each installed hook).`,
      ),
    )}\n`,
  );
};

// One-time move of a pre-XDG state or config dir (macOS ~/Library/Application
// Support/workit), before anything reads or writes the new one.
migrateLegacyDirs();

// A Node below this package's own engines minimum cannot load dist. The launcher
// then looks for a Node that can (bin/node-resolve.mjs: $WORKIT_NODE, the node
// `workit setup` recorded, a version-manager scan) and re-runs itself on it with
// stdin, stdout, stderr and the exit code passed through; WORKIT_HOOK_REEXEC
// stops a second hop. With none found it fails open with one clear line, and a
// SessionStart tells the agent once that the hooks are off.
// WORKIT_HOOK_NODE_VERSION stands in for process.versions.node (tests). An
// unreadable minimum never blocks.
const nodeFloor = () => {
  try {
    const range = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).engines?.node;
    const floor = floorOfRange(range);
    return floor ? { range, floor } : null;
  } catch {
    return null;
  }
};
const hookNode = nodeFloor();
const foundNode = process.env.WORKIT_HOOK_NODE_VERSION || process.versions.node;
const tooOld = hookNode ? floorMessage(foundNode, hookNode.floor, hookNode.range) : null;
// isStart runs only when no Node >= the floor was found: it records the failure row.
let floorEvent;
if (tooOld && hookNode)
  process.exit(
    await handleBelowFloor({
      host: "Claude Code",
      range: hookNode.range,
      floor: hookNode.floor,
      found: foundNode,
      script: fileURLToPath(import.meta.url),
      argv: process.argv.slice(2),
      env: process.env,
      isStart: (event) => {
        floorEvent = event;
        recordFailure(event, tooOld);
        return LOUD_EVENTS.has(event);
      },
      notice: (text) => failedAnswer(floorEvent, text),
    }),
  );

// Every Bash/PowerShell call and every file edit reaches this hook (branch
// policy, raw git/forge steering and the before-write gate). Fast paths
// answer `{}` before the runtime loads: a shell command with no git/gh/glab,
// no file redirect and no writing verb can need none of them; with no Workit
// task store for the checkout there is no task to gate a write on, so only a
// write that may reach a guarded path (mayReachWith, a copy of workit-core
// hooks/write-reach.ts) goes to the registry guard; and a PostToolUse only
// matters after a `git commit`. A workit delivery verb
// (`workit pr create`, `workit ci wait`) may get the workit-ship nudge. A
// command that may be heavy (a catalog word or a pattern's first word, the
// copy of core/heavy-words.ts below) goes to the heavy-command gate.
let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);
const RAW_TOOLS = /\b(?:git|gh|glab)\b/;
const WORKIT_DELIVERY =
  /(?:^|[\s;&|(])(?:\S*[\\/])?workit(?:-cli)?\s+(?:pr (?:create|merge)|ci wait|git push)\b/;
// The runtime moves the verb first (`cd <dir> && workit …`, `workit --cwd
// <dir> <verb>`) so Workit's enumerated allow rules match (hooks/cwd-normalize.ts).
const WORKIT_REORDER = /^\s*(?:cd\s[^;|&]*&&\s*workit\s|workit\s+(?:--json\s+)*--cwd[\s=])/;
// `workit approve` (the host-approval channel, workit-core approvals/call.ts)
// goes to the runtime on both events: PreToolUse asks with the rendered
// request or denies a wrapped call, PostToolUse records the grant. Anchored at
// the verb, after any global option: `release notes approve` is not it.
const WORKIT_APPROVE =
  /(?:^|[\s;&|(`])(?:\S*[\\/])?workit(?:-cli)?(?:\s+(?:--json|--(?:cwd|session|token)[\s=]\S+))*\s+approve\b/;
// A Workit call that may carry a bypass flag, however quoted, goes to the
// runtime, which asks the user (hooks/delivery-verbs.ts workitBypassFlag).
const mayBypass = (command) =>
  /\bworkit\b/.test(command) &&
  (/\$['"]/.test(command) ||
    /--unverified|--overwrite-unintegrated/.test(command.replace(/['"\\`]/g, "")));
const MAYBE_GATED =
  /\b(?:git|gh|glab)\b|>|\b(?:tee|touch|mkdir|rm|rmdir|mv|cp|truncate|install|ln|patch|dd|sed|perl|set-content|add-content|out-file|new-item|ni|remove-item|del|copy-item|move-item)\b/i;
// Redirects that write no file, as the write gate reads them (write-gate.ts
// shellWrites): an fd duplication (`2>&1`, `>&2`, `>&-`) or a device.
const NO_FILE_REDIRECT =
  /\d*>&(?:\d+|-)(?![^\s;&|()<>])|[\d&]*>>?\s*\/dev\/(?:null|stdout|stderr|tty)(?![^\s;&|()<>])/g;
const maybeGated = (command) => MAYBE_GATED.test(command.replace(NO_FILE_REDIRECT, " "));
// A user-only Workit call (`workit setup`, `workit grant set`, …) goes to the
// runtime, which asks: a copy of workit-core hooks/delivery-verbs.ts
// mayRunUserOnly, the gate's own first test (a test holds them equal).
const USER_ONLY_WORD = /\b(?:release|grant|ledger|approve|setup|uninstall|install|workspace)\b/;
const mayRunUserOnly = (text) => {
  const joined = text.replace(/\\\r?\n/g, "");
  const bare = joined.replace(/['"\\]/g, "");
  return [bare, bare.replace(/`/g, "")].some(
    (all) => /\bworkit\b/.test(all) && (USER_ONLY_WORD.test(all) || /\$['"]/.test(joined)),
  );
};
// What an agent's confinement also judges (hooks/worktree-confine.ts):
// writers the edit analysis cannot see, `-c` scripts, `$(…)`, Workit's verbs
// and, for a judge, scripts fed on stdin or by eval.
const IMPLEMENTER_GATED =
  /\b(?:unlink|chmod|chown|chgrp|shred|chattr|setfacl|rsync|find|xargs|g?awk|python[\d.]*|node|bun|deno|ruby|php|sh|bash|zsh|dash|ksh|workit|mkfifo|wget|tar|unzip|eval|source)\b|\$\(|`|<\(|\/dev\/(?:stdin|fd)/i;
// Text that may run ytrack (a raw write asks the user first): `ytrack` where a command
// name can end, in any position. The same test opens workit-core hooks/ytrack-guard.ts
// (hooks/ytrack-word.ts) and the Codex launcher: never a list of positions or wrappers.
const YTRACK_WORD = /ytrack(?![\w/-]|\.(?!exe|cmd))/i;
const namesYtrack = (text) => {
  const bare = text.replace(/['"\\]/g, "");
  return YTRACK_WORD.test(bare) || YTRACK_WORD.test(bare.replace(/`/g, ""));
};
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
/** Does the user's workspaces.json name role models? A doubt answers yes (core/workit-paths.mjs configDir). */
const roleModelsConfigured = () => {
  const env = process.env;
  const dir = workitConfigDir(env);
  let text;
  try {
    text = readFileSync(path.join(dir, "workspaces.json"), "utf8");
  } catch (error) {
    return error?.code !== "ENOENT";
  }
  return /"(?:roles|tierModels)"\s*:/u.test(text);
};
const REPO_CHECKS = ".workit/checks.json";
const LEGACY_REPO_CHECKS = "workit.checks.json";
/** Could the command be heavy? A doubt answers yes (it only costs a runtime load). */
const maybeHeavy = (command, cwd) => {
  try {
    const words = wordsOf(command);
    if (words.some((word) => HEAVY_WORDS.has(word) || /^python[\d.]*$/u.test(word))) return true;
    const patterns = [];
    const machine = readJson(path.join(stateDir(), "heavy-commands.json"));
    if (Array.isArray(machine?.patterns)) patterns.push(...machine.patterns);
    // The repo's checks config at the git top: keep REPO_CHECKS and
    // LEGACY_REPO_CHECKS equal to workit-core/src/check-config.ts (a test holds them).
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, ".git"))) {
        const repo =
          readJson(path.join(dir, REPO_CHECKS)) ?? readJson(path.join(dir, LEGACY_REPO_CHECKS));
        if (Array.isArray(repo?.resources?.heavyCommands))
          patterns.push(...repo.resources.heavyCommands);
        break;
      }
      if (path.dirname(dir) === dir) break;
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
const READS = new Set(["Read", "Grep", "Glob"]);

// A copy of workit-core hooks/write-reach.ts between its markers, types removed
// (test/workit-core/hooks/write-reach.test.ts holds them equal).
// write-reach:begin
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

/** The guarded dirs' tests: `at` a guarded path or below it, `above` one (an ancestor). */
const reachTests = (dirs) => {
  const fold = (value) => (dirs.fold ? value.toLowerCase() : value);
  // write-gate.ts canonical: the nearest existing ancestor's real path, then the rest.
  const canon = (file) => {
    let rest = "";
    for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
      try {
        return fold(path.join(realpathSync.native(dir), rest));
      } catch {
        if (path.dirname(dir) === dir) return fold(path.resolve(file));
        rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
      }
    }
  };
  const within = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const state = canon(dirs.state);
  const configs = dirs.configs.map(canon);
  const at = (file) =>
    configs.some((dir) => within(dir, file)) ||
    (within(state, file) &&
      /^(?:issued[^\\/]*|approvals)(?:[\\/]|$)/.test(path.relative(state, file)));
  const above = (file) => within(file, state) || configs.some((dir) => within(file, dir));
  const linked = (file) => {
    try {
      const stat = statSync(file, { throwIfNoEntry: false });
      return Boolean(stat?.isFile() && stat.nlink > 1);
    } catch {
      return false;
    }
  };
  return { canon, at, above, linked };
};

/** Whether an edit of `file` may reach a guarded path: through a symlink, a hard link, or by name. */
const fileReaches = (file, cwd, dirs) => {
  const { canon, at, linked } = reachTests(dirs);
  const target = canon(path.resolve(cwd, file));
  return at(target) || linked(target);
};

/** Whether shell `text` run in `cwd` may write at or above a guarded path. */
const mayReachWith = (text, cwd, dirs) => {
  const { canon, at, above, linked } = reachTests(dirs);
  // a. The command runs at or above a guarded path.
  const here = canon(cwd);
  if (at(here) || above(here)) return true;
  // b. A guarded path the word split below cannot spell.
  const BREAKS = /[\s;&|()<>=:,]/;
  if ([dirs.state, ...dirs.configs].some((dir) => BREAKS.test(dir)) && /[/~]/.test(text))
    return true;
  // c. Spellings this test does not resolve.
  const joined = text.replace(/\\\r?\n/g, "");
  const bare = joined.replace(/['"\\]/g, "");
  if (
    /\$['"]/.test(joined) ||
    /~[\w+-]|\$\{(?:!|\w+[^\w}])|\bpopd\b/.test(bare) ||
    /(?:^|[\s;&|(])(?:cd|pushd|chdir)(?:\s+-\S*)*\s*(?:$|[;&|)\n$`])/.test(bare) ||
    (dirs.env.CDPATH !== undefined && /\b(?:cd|pushd)\b/.test(bare))
  )
    return true;
  // d. Every word as a path, from every directory a `cd` may reach.
  const bound = (name) =>
    new RegExp(`(?:^|[^\\w$])${name}=|\\bfor\\s+${name}\\b|\\bread\\b[^;&|\\n]*\\b${name}\\b`).test(
      bare,
    );
  const expanded = bare.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, braced, plain) => {
    const name = braced ?? plain ?? "";
    return /^(?:OLD)?PWD$/.test(name) || bound(name) ? all : (dirs.env[name] ?? "");
  });
  const words = expanded.split(/[\s;&|()<>=:,]+/).filter(Boolean);
  if (words.length > 64) return true;
  const home = dirs.env.HOME || dirs.home;
  const literal = (word) => {
    const cut = word.split(/[$`*?[{]/)[0] ?? "";
    return cut === "~" || cut.startsWith("~/") ? home + cut.slice(1) : cut;
  };
  const bases = [path.resolve(cwd)];
  for (let index = 0; index < words.length; index++) {
    if (!/^(?:cd|pushd|chdir)$/.test(words[index] ?? "")) continue;
    let next = index + 1;
    while (words[next]?.startsWith("-")) next++;
    const target = literal(words[next] ?? "");
    bases.push(...bases.map((base) => path.resolve(base, target)));
    if (bases.length > 8) return true;
  }
  const globby = /[$`*?[{]/.test(expanded);
  const seen = new Set();
  for (const word of words) {
    const forms = [word];
    if (word.startsWith("-"))
      for (let from = 1; from < word.length; from++) forms.push(word.slice(from));
    for (const form of forms)
      for (const base of bases) {
        const file = canon(path.resolve(base, literal(form)));
        if (seen.has(file)) continue;
        seen.add(file);
        if (at(file) || linked(file)) return true;
        if (globby && (above(file) || above(path.dirname(file)))) return true;
      }
  }
  return false;
};
// write-reach:end
/** The guarded dirs as this hook process sees them (write-reach.ts reachDirs). */
const reachDirs = () => {
  let account = null;
  try {
    account = os.userInfo().homedir;
  } catch {
    // No account record: the env's dirs only.
  }
  return {
    state: stateDir(),
    configs: [
      workitConfigDir(process.env),
      workitConfigDir({}),
      ...(account ? [workitConfigDir({ HOME: account, USERPROFILE: account })] : []),
    ],
    home: os.homedir(),
    env: process.env,
    fold: process.platform === "darwin" || process.platform === "win32",
  };
};

/**
 * Text that may name a state registry or the config dir's workspaces.json
 * (the guards in write-gate.ts judge it): the state and config dirs by their
 * last two parts, so `~/.local/state/workit`, `~/.config/workit` and
 * `$HOME/...` match too.
 */
const mentionsGuarded = (text) => {
  const flat = (value) => value.replaceAll("\\", "/").toLowerCase();
  const tail = (dir) => flat(dir).split("/").slice(-2).join("/");
  // As written, and with quotes and backslashes gone (`work""spaces.json`, `work\spaces.json`).
  return [flat(text), text.replace(/['"\\]/g, "").toLowerCase()].some(
    (all) =>
      /issued|approvals|workspaces\.json/.test(all) ||
      [tail(stateDir()), tail(workitConfigDir(process.env)), tail(workitConfigDir({}))].some(
        (part) => all.includes(part),
      ),
  );
};

// A write whose path may name a guarded file only once the runtime expands
// it: a `~`, `/`, `$` or `..` word holding a glob, or a variable that can
// hold the state or config dir (write-gate.ts globbed, the registry env).
const GUARD_SPELLING =
  /(?:^|[\s=<>|;&("'])(?:~|\/|\$|\.\.)[^\s'"]*[*?[]|\$\{?(?:WORKIT_|XDG_|APPDATA|HOME)/;

// A script run the registry guard reads at hook time (write-gate.ts): a shell,
// an interpreter or `.`/`source` given a file, or a command spelled as a path.
const SCRIPT_RUNNERS = new Set(
  "node tsx ts-node bash sh zsh dash ksh ruby perl php source".split(" "),
);
// After a wrapper or keyword too (`time ./x.sh`, `sudo ./x.sh`, `if ./x.sh`).
const RUNS_PATH =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:time|exec|sudo|nice|nohup|env|command|builtin|timeout|stdbuf|if|then|do|while|until|!)\s+(?:-\S+\s+|\d\S*\s+)*)*(?:\.\s+\S|\.{0,2}\/)/u;

/**
 * Does a word name a guarded file by a second name: a regular file with more
 * than one link, or a path whose real path (through a symlink, or a symlinked
 * dir for a file not made yet) names a guarded dir?
 */
const hardLinkNamed = (words, cwd) =>
  words.slice(0, 64).some((word) => {
    if (typeof word !== "string" || !word) return false;
    const file = path.resolve(cwd, word);
    try {
      const stat = statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.nlink > 1) return true;
      const real = stat
        ? realpathSync(file)
        : path.join(realpathSync(path.dirname(file)), path.basename(file));
      return real !== file && mentionsGuarded(real);
    } catch {
      return false;
    }
  });

// A standing order the lead added or cleared since this agent last looked
// (`<store>/standing/rev` against its `standing/seen/<key>.json`) rides the
// next tool call, so that call loads the runtime. A copy of
// workit-core/src/hooks/standing-signal.ts (a test holds them equal).
const gitStoreDir = (cwd) => {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const target = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!target) return null;
          gitDir = path.resolve(dir, target);
          const common = path.join(gitDir, "commondir");
          if (existsSync(common))
            gitDir = path.resolve(gitDir, readFileSync(common, "utf8").trim());
        }
        return path.join(gitDir, "workit");
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
};
const standingPending = (cwd, session, agentId) => {
  const store = gitStoreDir(cwd);
  if (!store || typeof session !== "string" || !session) return false;
  let rev;
  try {
    rev = readFileSync(path.join(store, "standing", "rev"), "utf8").trim();
  } catch {
    return false;
  }
  if (!rev) return false;
  const key = createHash("sha256")
    .update(`${session}\0${typeof agentId === "string" ? agentId : ""}`)
    .digest("hex")
    .slice(0, 32);
  return readJson(path.join(store, "standing", "seen", `${key}.json`))?.rev !== rev;
};

// The worker tool-call budget: a copy of spawnBudget, noteSpawnBudget and
// tickBudget in workit-core/src/hooks/budget-signal.ts (a test holds them
// equal). A spawn whose brief names `N tool calls` queues N for the next
// subagent of its type; each pre-tool call of a budgeted agent appends one
// byte to its counter, and only the call that reaches the next multiple of N
// loads the runtime, which tells the agent once.
const budgetHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const spawnBudget = (prompt) => {
  const found = /^TIMEBOX:[^\n]*?\b(\d+)\s+tool calls\b/mu.exec(prompt);
  const n = found ? Number(found[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};
const noteSpawnBudget = (cwd, session, type, prompt) => {
  try {
    const store = session ? gitStoreDir(cwd) : null;
    if (!store) return;
    mkdirSync(path.join(store, "budget"), { recursive: true });
    appendFileSync(
      path.join(store, "budget", `spawns-${budgetHash(session)}.jsonl`),
      `${JSON.stringify({ type: type ?? "", n: spawnBudget(prompt) })}\n`,
    );
  } catch {
    // Without the note the worker runs unbudgeted.
  }
};
const tickBudget = (cwd, session, agentId) => {
  try {
    const store = session ? gitStoreDir(cwd) : null;
    if (!store) return false;
    const base = path.join(store, "budget", budgetHash(`${session}\0${agentId ?? ""}`));
    const budget = readJson(`${base}.json`);
    if (typeof budget?.limit !== "number" || budget.limit <= 0) return false;
    const told = typeof budget.told === "number" ? budget.told : 0;
    appendFileSync(`${base}.calls`, ".");
    return statSync(`${base}.calls`).size >= budget.limit * (told + 1);
  } catch {
    return false;
  }
};
const parsed = (() => {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
})();
// Counted before any fast path, so a call the fast path answers counts too.
const budgetDue = (() => {
  try {
    const value = parsed;
    if (value?.hook_event_name !== "PreToolUse" || typeof value.session_id !== "string")
      return false;
    return typeof value.agent_id === "string" && value.agent_id !== ""
      ? tickBudget(String(value.cwd ?? "."), value.session_id, value.agent_id)
      : false;
  } catch {
    return false;
  }
})();

// The plugin dir this hook runs from (`<config>/plugins/cache/<mkt>/workit/<version>`)
// against the newest version the registry lists beside it: while the line has not
// been given this session, the runtime runs (src/stale-plugin.ts holds the same test).
const parts = (version) => /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
const staleUnannounced = (session) => {
  try {
    const versions = path.dirname(root);
    if (path.basename(path.dirname(path.dirname(versions))) !== "cache") return false;
    const running = parts(path.basename(root));
    if (!running || typeof session !== "string") return false;
    const registry = readJson(
      path.join(path.dirname(path.dirname(path.dirname(versions))), "installed_plugins.json"),
    );
    for (const entries of Object.values(registry?.plugins ?? {}))
      for (const entry of Array.isArray(entries) ? entries : []) {
        const at = typeof entry?.version === "string" ? parts(entry.version) : undefined;
        if (
          at &&
          path.dirname(String(entry.installPath)) === versions &&
          (at[0] - running[0] || at[1] - running[1] || at[2] - running[2]) > 0
        )
          return !existsSync(markerFor(session, entry.version));
      }
  } catch {
    // an unreadable registry is not a reason to load the runtime
  }
  return false;
};
const markerFor = (session, installed) =>
  path.join(
    stateDir(),
    "stale-plugin",
    createHash("sha256").update(`${session}\0${installed}`).digest("hex").slice(0, 32),
  );

const fastAllow = (() => {
  try {
    if (parsed === undefined) return false;
    const value = parsed;
    const command = value?.tool_input?.command;
    if (
      value?.hook_event_name === "PreToolUse" &&
      !value.agent_id &&
      staleUnannounced(value.session_id)
    )
      return false;
    if (value?.hook_event_name === "PostToolUse")
      return (
        typeof command === "string" && !/\bcommit\b/.test(command) && !WORKIT_APPROVE.test(command)
      );
    if (value?.hook_event_name !== "PreToolUse") return false;
    if (budgetDue) return false;
    if (mentionsGuarded(JSON.stringify(value.tool_input ?? {}))) return false;
    if (standingPending(String(value.cwd ?? "."), value.session_id, value.agent_id)) return false;
    // An implementer's writes are confined to its Workit worktree, a verifier's
    // or reviewer's to its scratch dir (hooks/worktree-confine.ts).
    const confined = /^workit:(?:implementer|verifier|reviewer)$/.test(value.agent_type ?? "");
    if (SHELLS.has(value.tool_name) && typeof command === "string") {
      if (
        WORKIT_DELIVERY.test(command) ||
        WORKIT_REORDER.test(command) ||
        WORKIT_APPROVE.test(command) ||
        mayBypass(command) ||
        namesYtrack(command) ||
        mayRunUserOnly(command)
      )
        return false;
      if (maybeHeavy(command, String(value.cwd ?? "."))) return false;
      if (RUNS_PATH.test(command) || wordsOf(command).some((word) => SCRIPT_RUNNERS.has(word)))
        return false;
      const cwd = String(value.cwd ?? ".");
      if (RAW_TOOLS.test(command)) return false;
      if (confined && (MAYBE_GATED.test(command) || IMPLEMENTER_GATED.test(command))) return false;
      if (
        (MAYBE_GATED.test(command) || IMPLEMENTER_GATED.test(command)) &&
        (GUARD_SPELLING.test(command) || hardLinkNamed(command.split(/[\s;&|()<>`'"]+/u), cwd))
      )
        return false;
      // A write: to the before-write gate with a task store (and always on
      // Windows or PowerShell, whose paths this test does not spell).
      if (
        maybeGated(command) &&
        (process.platform === "win32" || value.tool_name === "PowerShell" || hasTaskStore(cwd))
      )
        return false;
      return !mayReachWith(command, cwd, reachDirs());
    }
    // A spawn with isolation (any type) or an implementer without a brief meets the
    // spawn gate (hooks/spawn-gate.ts, the same WORKTREE test). One that names its
    // model has no default to fill (hooks/agent-model.ts) unless the user's
    // workspaces.json configures role models, which win over a named model.
    if (value.tool_name === "Agent" || value.tool_name === "Task") {
      const spawn = value.tool_input ?? {};
      if (spawn.isolation !== undefined) return false;
      if (
        spawn.subagent_type === "workit:implementer" &&
        (typeof spawn.prompt !== "string" ||
          !/^WORKTREE:[ \t]*(?!not made yet)\S(?![^\n]*not made yet)/mu.test(spawn.prompt))
      )
        return false;
      return (
        typeof spawn.model === "string" && spawn.model.trim() !== "" && !roleModelsConfigured()
      );
    }
    // Read, Grep and Glob reach this hook only to be counted against a budget.
    if (READS.has(value.tool_name)) return true;
    // An edit goes to the runtime with a task store, for a confined agent, on
    // Windows, or when its file may reach a guarded path (a name the check
    // above missed, a symlink, a hard link).
    if (!EDITS.has(value.tool_name)) return false;
    const cwd = String(value.cwd ?? ".");
    const input = value.tool_input ?? {};
    const files = [input.file_path, input.notebook_path].filter(
      (file) => typeof file === "string" && file,
    );
    return (
      !confined &&
      process.platform !== "win32" &&
      !hardLinkNamed(files, cwd) &&
      !hasTaskStore(cwd) &&
      !files.some(
        (file) => fileReaches(file, cwd, reachDirs()) || mayReachWith(file, cwd, reachDirs()),
      )
    );
  } catch {
    return false;
  }
})();

// A lead's spawn the fast path allows queues its budget or none (the runtime
// queues one its gate lets through); a stopped subagent's budget files go.
// Copies of handle.ts noteClaudeSpawn and budget-signal.ts dropBudget.
const settleBudget = () => {
  try {
    const value = parsed;
    const session = value?.session_id;
    if (typeof session !== "string" || !session) return;
    const cwd = String(value.cwd ?? ".");
    if (value.hook_event_name === "SubagentStop") {
      const store = gitStoreDir(cwd);
      if (!store || typeof value.agent_id !== "string" || !value.agent_id) return;
      const base = path.join(store, "budget", budgetHash(`${session}\0${value.agent_id}`));
      rmSync(`${base}.json`, { force: true });
      rmSync(`${base}.calls`, { force: true });
      return;
    }
    const spawn = value.tool_input;
    if (fastAllow && !value.agent_id && (value.tool_name === "Agent" || value.tool_name === "Task"))
      noteSpawnBudget(
        cwd,
        session,
        typeof spawn?.subagent_type === "string" && spawn.subagent_type
          ? spawn.subagent_type
          : "general-purpose",
        typeof spawn?.prompt === "string" ? spawn.prompt : "",
      );
  } catch {
    // Budgets fail open.
  }
};
settleBudget();

// A SubagentStop loads the runtime only when its last message may be a
// provider usage limit (W2.19: hooks/handle.ts marks the provider exhausted).
const LIMIT_HINT = /\blimit\b|\bquota\b|\b429\b|rate_limit/iu;
const quietStop =
  parsed?.hook_event_name === "SubagentStop" &&
  !(
    typeof parsed.last_assistant_message === "string" &&
    parsed.last_assistant_message.length <= 1000 &&
    LIMIT_HINT.test(parsed.last_assistant_message)
  );

process.env.WORKIT_PLUGIN_ROOT = root;
if (quietStop || fastAllow) {
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
  if (runClaudeHook)
    try {
      process.exitCode = await runClaudeHook([payload], process.stdout);
    } catch (error) {
      failOpen(`crashed (${error instanceof Error ? error.message : String(error)})`);
    }
} else {
  failOpen(`${dist} is missing; run \`bun scripts/build.ts\` in ${root}`);
}
