// A shell command that runs one of Workit's own hook entries (#984). The host
// runs its hooks itself, outside the agent's shell tool, so no PreToolUse ever
// sees a real hook run: one in an agent's shell feeds the hook a payload the
// agent wrote (a SubagentStart that issues a token to a subagent that never
// existed, a SessionStart that rewrites the state-dir pin, a PreToolUse that
// stamps any agent id). Denied on every host when the command executes an
// entry: as its command word, behind wrappers, assignments and `env`, through
// an interpreter or package runner (`node`, `bun`, `deno`, `npx tsx`, a shell),
// on an interpreter's stdin (`node < entry`, `cat entry | node`, a `/dev/fd`
// it opened, `<(cat entry)`), in a `-c` script, a heredoc fed to a shell or a
// `$(…)`, inside any compound command (`{ …; }`, `if`, loops, `case`, function
// bodies), through `NODE_OPTIONS`/`BUN_OPTIONS`, and behind a command Workit
// does not follow (`flock`, `su -c`, `tmux`, `ssh`, `find -exec`, `xargs`,
// `Start-Process`…), which is denied when its words name an entry beside an
// interpreter. A word names an entry by its basename or by its resolved path
// (after `$VAR`, a literal `$(echo|printf|ls …)`, `~`, a `cd` earlier in the
// command, a glob and symlinks) inside a Workit host package. A read (`cat`,
// `ls`, `git diff`, `bun build`) passes. A path computed at run time, a copy
// run under a new name or a program that runs one is the interpreter-class
// limit (hosts.md#host-parity).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { userHome } from "../core/workit-paths.mjs";
import { shellScript } from "./delivery-verbs";
import { expandGlob, globPattern } from "./path-glob";
import { segmentsOf, type Segment, type ShellDialect } from "./shell-words";
import { pastOptions, WRAPPERS } from "./write-gate";

/** Entry basenames no other file shares: each host's launcher, bundle and npm bin. */
const ENTRY_NAMES =
  /^(?:workit-hook(?:-[\w-]+)?\.(?:m?js|ts)|cursor-session-start\.js|workit-(?:codex|cursor)-hook|workit-cursor-session-start)(?:\.(?:cmd|ps1|exe))?$/iu;

/** Each Workit host package's hook entries, relative to its root (source, launcher, bundle). */
const PACKAGE_ENTRIES: Readonly<Record<string, RegExp>> = {
  "claude-code": /^(?:bin\/workit-hook\.mjs|src\/(?:run|hook)\.ts|dist\/workit-hook\.js)$/u,
  codex: /^(?:hooks\/(?:launcher|workit-hook)\.ts|dist\/workit-hook(?:-[\w-]+)?\.js)$/u,
  cursor:
    /^(?:hooks\/(?:launch|launch-runtime)\.mjs|hooks\/(?:workit-hook|session-start|subagent-start)\.ts|dist\/(?:workit-hook|cursor-session-start)\.js)$/u,
  core: /^src\/hooks\/run\.ts$/u,
};

/** Interpreters and shells that run a file they are given. */
const RUNNERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "source",
  ".",
]);
/** Runners of a package's binary: the next word past their options is the program. */
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** `bun`/`deno` subcommands that read a file without running it. */
const NO_RUN = new Set([
  "build",
  "test",
  "fmt",
  "lint",
  "check",
  "doc",
  "info",
  "install",
  "add",
  "pm",
]);
/** Wrappers write-gate.ts does not list, which run the rest of their words. */
const MORE_WRAPPERS = new Set(["strace", "ltrace", "watch", "unshare", "firejail", "xargs", "&"]);

const baseName = (word: string): string =>
  (word.split(/[\\/]/u).at(-1) ?? "").replace(/\.exe$/iu, "").toLowerCase();

/** The Workit host package `dir` is the root of: its package.json or plugin manifest names it. */
const packageAt = (dir: string): string | null => {
  try {
    const name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
    const short = /^@workit-dev\/(claude-code|codex|cursor|core)$/u.exec(String(name))?.[1];
    if (short) return short;
  } catch {
    // No package.json: an installed plugin may still carry its manifest.
  }
  for (const [manifest, short] of [
    [".claude-plugin", "claude-code"],
    [".codex-plugin", "codex"],
    [".cursor-plugin", "cursor"],
  ] as const) {
    try {
      const name = JSON.parse(readFileSync(path.join(dir, manifest, "plugin.json"), "utf8")).name;
      if (name === "workit") return short;
    } catch {
      // Not this host's plugin.
    }
  }
  return null;
};

/** Whether `file` (absolute) is a hook entry of the Workit host package nearest above it. */
const entryByPath = (file: string): boolean => {
  let dir = path.dirname(file);
  for (let depth = 0; depth < 4; depth += 1, dir = path.dirname(dir)) {
    const short = packageAt(dir);
    if (short)
      return (
        PACKAGE_ENTRIES[short]?.test(path.relative(dir, file).split(path.sep).join("/")) ?? false
      );
    // The nearest package that is not Workit's owns the file.
    if (existsSync(path.join(dir, "package.json"))) return false;
  }
  return false;
};

/** A literal `$(echo|printf|ls|realpath|readlink … <path>)` or backtick form: the path it prints. */
const literalSub = (match: string, inner: string): string => {
  try {
    const [only, ...rest] = segmentsOf(inner);
    const [verb = "", ...args] = only?.words ?? [];
    const last = args.findLast((arg) => !arg.startsWith("-"));
    return rest.length === 0 &&
      /^(?:echo|printf|ls|realpath|readlink)$/u.test(baseName(verb)) &&
      last
      ? last
      : match;
  } catch {
    return match;
  }
};

/** `$NAME`/`${NAME}` from the command's own assignments, then the hook's environment; `~` home. */
const expand = (word: string, vars: ReadonlyMap<string, string>): string =>
  word
    .replace(/\$\(([^()]*)\)|`([^`]*)`/gu, (match, sub?: string, tick?: string) =>
      literalSub(match, sub ?? tick ?? ""),
    )
    .replace(/\$\{(\w+)\}|\$(\w+)/gu, (match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      return vars.get(name) ?? process.env[name] ?? match;
    })
    .replace(/^~(?=[\\/]|$)/u, userHome(process.env));

type Scan = {
  /** Where the next relative path resolves; null once a `cd` Workit cannot follow ran. */
  dir: string | null;
  /** Paths the command's own assignments set. */
  vars: Map<string, string>;
  /** Links and copies of an entry the command makes before it runs them. */
  links: Set<string>;
  /** File descriptors an `exec N<entry` opened on an entry. */
  fds: Set<string>;
  /** The entry the previous segment of a pipe names (`cat entry | node`). */
  fed: string | null;
  depth: number;
};

/** The hook entry `word` names in `scan`, as written, or null. */
const entryNamed = (word: string | undefined, scan: Scan): string | null => {
  if (!word) return null;
  const text = expand(word, scan.vars);
  if (ENTRY_NAMES.test(baseName(text))) return text;
  const fd = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/u.exec(text)?.[1];
  if (fd !== undefined && scan.fds.has(fd)) return text;
  if (scan.dir === null && !path.isAbsolute(text)) return null;
  for (const file of expandGlob(path.resolve(scan.dir ?? "/", text))) {
    if (scan.links.has(file) || entryByPath(file)) return text;
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      continue;
    }
    if (ENTRY_NAMES.test(baseName(real)) || entryByPath(real)) return text;
  }
  return null;
};

/** `ln`, `cp` or `install` of an entry: its new name is an entry for the rest of the command. */
const noteLink = (words: readonly string[], scan: Scan): void => {
  if (!/^(?:ln|cp|install)$/u.test(baseName(words[0] ?? "")) || scan.dir === null) return;
  const names = words.slice(1).filter((word) => !word.startsWith("-"));
  const dest = names.at(-1);
  if (dest === undefined || names.length < 2) return;
  for (const source of names.slice(0, -1).filter((name) => entryNamed(name, scan))) {
    const to = path.resolve(scan.dir, expand(dest, scan.vars));
    scan.links.add(to);
    scan.links.add(path.join(to, path.basename(source)));
  }
};

/** The entry one simple command runs, past its assignments and wrappers, or null. */
const runsEntry = (
  words: readonly string[],
  inputs: readonly string[],
  scan: Scan,
): string | null => {
  const named = (word: string | undefined) => entryNamed(word, scan);
  let at = 0;
  while (at < words.length) {
    while (/^[A-Za-z_]\w*=/u.test(words[at] ?? "")) at += 1;
    const word = words[at];
    if (word === undefined) return null;
    const entry = named(word);
    if (entry) return entry;
    const name = baseName(word);
    // `env -S '<line>'`: the line is more of env's words.
    const split =
      name === "env" ? words.findIndex((w) => /^(?:-\w*S|--split-string)/u.test(w)) : -1;
    if (split > at) {
      const line =
        /^(?:-\w*S|--split-string=?)(.*)$/su.exec(words[split] ?? "")?.[1] || words[split + 1];
      const rest = words.slice(split + (line === words[split + 1] ? 2 : 1));
      return runsEntry([...(line ?? "").split(/\s+/u).filter(Boolean), ...rest], inputs, scan);
    }
    if (MORE_WRAPPERS.has(name)) {
      at = pastOptions(words, at + 1, "");
      continue;
    }
    const takes = WRAPPERS[name];
    if (takes !== undefined && !PACKAGE_RUNNERS.has(name)) {
      at = pastOptions(words, at + 1, takes, name === "env" || name === "sudo");
      continue;
    }
    if (name === "busybox" || name === "toybox") {
      at += 1;
      continue;
    }
    // `npx [-y] [-p pkg] <bin> …`, `bun x <bin>`, `pnpm dlx <bin>`: the binary is the program,
    // and a Workit host package's own binary is its hook.
    const runner =
      PACKAGE_RUNNERS.has(name) ||
      (name === "bun" && words[at + 1] === "x") ||
      (/^(?:pnpm|yarn|npm)$/u.test(name) && /^(?:dlx|exec|x)$/u.test(words[at + 1] ?? ""));
    if (runner) {
      at += PACKAGE_RUNNERS.has(name) ? 1 : 2;
      while (words[at]?.startsWith("-"))
        at += /^(?:-p|--package|-c|--call)$/u.test(words[at] ?? "") ? 2 : 1;
      if (/^@workit-dev\/(?:claude-code|codex|cursor)(?:@|$)/u.test(words[at] ?? ""))
        return words[at] ?? null;
      continue;
    }
    if (!RUNNERS.has(name)) return null;
    if ((name === "bun" || name === "deno") && NO_RUN.has(words[at + 1] ?? "")) return null;
    // An interpreter runs the entry it is given, or the one on its stdin.
    for (const arg of [...words.slice(at + 1), ...inputs]) {
      const hit = named(arg);
      if (hit) return hit;
    }
    return null;
  }
  return null;
};

/** Keywords before a command that leave it the command (`{ node x; }`, `if node x`, `do node x`). */
const KEYWORDS = new Set([
  "{",
  "}",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "esac",
  "!",
]);

/** The simple command past compound keywords: `function f {` skips the name; a `for`, `case` or `select` header runs none. */
const pastKeywords = (words: readonly string[]): readonly string[] => {
  let at = 0;
  for (;;) {
    if (words[at] === "function") at += 2;
    else if (KEYWORDS.has(words[at] ?? "")) at += 1;
    else break;
  }
  return /^(?:for|case|select)$/u.test(words[at] ?? "") ? [] : words.slice(at);
};

/** Commands that read, copy or print the words they get and run none of them. */
const READERS = new Set(
  (
    "cat less more head tail ls dir stat file wc grep egrep fgrep rg ag diff cmp sha256sum md5sum " +
    "shasum du bat echo printf cp mv rm chmod touch mkdir realpath readlink dirname basename tee " +
    "oxfmt oxlint prettier eslint tsc gh jq sort uniq cut tr nl od xxd hexdump strings code vim " +
    "nano sed get-content gc type select-string get-childitem test-path"
  ).split(" "),
);

/** What splits a word into the words a nested program sees (`'!node x'`, `import('x')`, `--import=x`). */
const TOKENS = /[\s'"`(),[\]{};|&<>=!]+/u;

/** Basenames a `find -name` glob may match to name an entry. */
const ENTRY_SAMPLES = [
  "workit-hook.mjs",
  "workit-hook.js",
  "workit-hook.ts",
  "cursor-session-start.js",
];

/** A token naming an entry: a path (with a separator) to one, or a bare name of one in the dir. */
const tokenEntry = (token: string, scan: Scan): string | null => {
  if (!/[\\/]/u.test(token) && !existsSync(path.resolve(scan.dir ?? "/", token))) return null;
  return entryNamed(token, scan);
};

/**
 * A command Workit does not follow (`flock`, `su -c`, `tmux`, `ssh`, `docker`, `find -exec`,
 * `xargs`, awk's `system`, a git alias, `Start-Process`): denied when its words name an entry
 * beside an interpreter, or an entry fed to it on a pipe or in an `xargs` input file.
 */
const opaqueEntry = (
  words: readonly string[],
  inputs: readonly string[],
  scan: Scan,
): string | null => {
  let at = 0;
  while (/^[A-Za-z_]\w*=/u.test(words[at] ?? "")) at += 1;
  const head = baseName(words[at] ?? "");
  if (READERS.has(head)) return null;
  if ((head === "bun" || head === "deno") && NO_RUN.has(words[at + 1] ?? "")) return null;
  if (head === "git" && !words.some((word) => word.includes("alias."))) return null;
  if (head === "workit" || head === "workit-cli") return null;
  const tokens = words.flatMap((word) => word.split(TOKENS)).filter(Boolean);
  // An interpreter by name; `.` and `source` run a script only as the command word.
  const runner = (token: string) =>
    (RUNNERS.has(baseName(token)) && !/^(?:\.|source)$/u.test(token)) ||
    PACKAGE_RUNNERS.has(baseName(token));
  if (!tokens.some(runner)) return null;
  if (scan.fed) return scan.fed;
  for (const token of tokens) {
    const hit = tokenEntry(token, scan);
    if (hit) return hit;
  }
  // `find … -name 'w*.mjs' -exec node {} \;`: a name glob that starts with a literal and matches an
  // entry's basename (`*.mjs` alone names any script).
  if (head === "find")
    for (const [index, word] of words.entries()) {
      const named = /^-i?name$/u.test(words[index - 1] ?? "") && /^[^*?[]/u.test(word);
      const pattern = named ? globPattern(word) : null;
      if (pattern && ENTRY_SAMPLES.some((sample) => pattern.test(sample))) return word;
    }
  // `xargs node < list`: the words its input file feeds it.
  if (/^(?:xargs|parallel)$/u.test(head) || tokens.includes("xargs"))
    for (const input of inputs) {
      try {
        const file = path.resolve(scan.dir ?? "/", expand(input, scan.vars));
        const text = readFileSync(file, "utf8").slice(0, 65_536);
        for (const token of text.split(/\s+/u).filter(Boolean)) {
          const hit = tokenEntry(token, scan);
          if (hit) return hit;
        }
      } catch {
        // An input Workit cannot read feeds nothing it can judge.
      }
    }
  return null;
};

/**
 * A command word the shell builds (`$n`, `${n}`, `$(…)`, a backtick): what it runs is unknown, so
 * the command is denied when any of its words names an entry (`n=bun; $n …/run.ts`).
 */
const expandedCommand = (words: readonly string[], scan: Scan): string | null => {
  let at = 0;
  while (/^[A-Za-z_]\w*=/u.test(words[at] ?? "")) at += 1;
  if (!/[$`]/u.test(words[at] ?? "")) return null;
  for (const word of words.slice(at + 1)) {
    const hit = entryNamed(word, scan);
    if (hit) return hit;
  }
  return null;
};

/** `NODE_OPTIONS`/`BUN_OPTIONS` set (before a command or exported) to load an entry. */
const optionsEntry = (words: readonly string[], scan: Scan): string | null => {
  for (const word of words) {
    const value = /^(?:NODE_OPTIONS|BUN_OPTIONS)=(.*)$/su.exec(word)?.[1];
    if (value === undefined) continue;
    for (const token of value.split(TOKENS).filter(Boolean)) {
      const hit = tokenEntry(token, scan);
      if (hit) return hit;
    }
  }
  return null;
};

/** The entry a command (and every script it nests) runs, or null. */
const scanCommand = (command: string, dialect: ShellDialect, scan: Scan): string | null => {
  let segments;
  try {
    segments = segmentsOf(command, dialect);
  } catch {
    return null;
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.unanalyzable) continue;
    bindLoop(segment.words, segments.slice(index + 1), scan);
    const words = pastKeywords(segment.words);
    const fed = scan.fed;
    scan.fed = null;
    const hit = segmentEntry(segment, words, dialect, scan, fed);
    if (hit) return hit;
  }
  return null;
};

/**
 * A loop's variable bound like an assignment: `for|select NAME in <words>` to the word that names
 * an entry (else the first), `while|until read NAME …; done <<< <word>` (or a heredoc) to the
 * first line its `done` feeds.
 */
const bindLoop = (raw: readonly string[], after: readonly Segment[], scan: Scan): void => {
  const at = raw.findIndex((word) => !KEYWORDS.has(word));
  const verb = raw[at];
  if ((verb === "for" || verb === "select") && raw[at + 2] === "in") {
    const name = raw[at + 1] ?? "";
    const items = raw.slice(at + 3);
    const item = items.find((word) => entryNamed(word, scan)) ?? items[0];
    if (/^[A-Za-z_]\w*$/u.test(name) && item !== undefined)
      scan.vars.set(name, expand(item, scan.vars));
    return;
  }
  const read = raw.indexOf("read");
  if (read < 0 || !raw.slice(0, read).some((word) => word === "while" || word === "until")) return;
  const fed = after.find((segment) => segment.words[0] === "done")?.stdin?.[0];
  const line = fed?.split("\n")[0]?.trim();
  const name = raw.slice(read + 1).find((word) => /^[A-Za-z_]\w*$/u.test(word));
  if (name && line) scan.vars.set(name, line);
};

/** The entry one segment runs: its command, its nested scripts and substitutions. */
const segmentEntry = (
  segment: Segment,
  words: readonly string[],
  dialect: ShellDialect,
  scan: Scan,
  fed: string | null,
): string | null => {
  const verb = baseName(words[0] ?? "");
  // `cd <dir>` moves where the next relative path resolves; one Workit cannot follow loses it.
  if (["cd", "pushd", "chdir", "set-location", "sl"].includes(verb)) {
    const target = words.slice(1).find((word) => !word.startsWith("-") || word === "-");
    const moved = target === undefined ? userHome(process.env) : expand(target, scan.vars);
    scan.dir =
      moved === "-" || /[$`]/u.test(moved)
        ? null
        : path.isAbsolute(moved)
          ? moved
          : scan.dir && path.resolve(scan.dir, moved);
    if (scan.dir === null) scan.vars.delete("PWD");
    else scan.vars.set("PWD", scan.dir);
    return null;
  }
  if (verb === "popd") {
    scan.dir = null;
    return null;
  }
  // `F=…` alone, or `export F=…`, names a path a later word may use.
  const declares = ["export", "declare", "typeset", "local", "readonly"].includes(verb);
  const assigns = declares
    ? words.slice(1)
    : words.every((word) => /^[A-Za-z_]\w*=/u.test(word))
      ? words
      : [];
  for (const word of assigns) {
    const [name = "", value] = word.split(/=(.*)/su);
    if (value !== undefined && /^[A-Za-z_]\w*$/u.test(name))
      scan.vars.set(name, expand(value.replace(/^(['"])(.*)\1$/su, "$2"), scan.vars));
  }
  const options = optionsEntry(declares ? words.slice(1) : words, scan);
  if (options) return options;
  // `exec 3<entry`: /dev/fd/3 names the entry from here on.
  if (verb === "exec" && words.slice(1).every((word) => /^\d+$/u.test(word)))
    for (const input of segment.inputs ?? [])
      if (entryNamed(input, scan)) for (const fd of words.slice(1)) scan.fds.add(fd);
  const inputs = segment.inputs ?? [];
  const entry =
    runsEntry(words, inputs, scan) ??
    expandedCommand(words, scan) ??
    opaqueEntry(words, inputs, { ...scan, fed });
  if (entry) return entry;
  // The words this segment pipes on: an entry they name reaches the next command's stdin.
  if (segment.pipe)
    scan.fed =
      words
        .slice(1)
        .flatMap((word) => word.split(TOKENS))
        .map((token) => (token ? tokenEntry(token, scan) : null))
        .find(Boolean) ?? null;
  noteLink(words, scan);
  if (scan.depth >= 4) return null;
  const nested = (script: string) =>
    scanCommand(script, dialect, {
      ...scan,
      vars: new Map(scan.vars),
      fed: null,
      depth: scan.depth + 1,
    });
  const scripts = [...(segment.subs ?? [])];
  const script = shellScript(words) ?? cmdScript(words) ?? workitScript(words);
  if (script) scripts.push(script);
  // A shell reading its script on stdin (`bash <<'EOF'`, `sh -s`) runs the heredoc, and so do
  // `at` and `batch`.
  if (
    (!script &&
      /^(?:ba|z|da|k)?sh$/u.test(verb) &&
      words.slice(1).every((word) => word.startsWith("-"))) ||
    verb === "at" ||
    verb === "batch"
  )
    scripts.push(...(segment.stdin ?? []));
  for (const text of scripts) {
    const hit = nested(text);
    if (hit) return hit;
  }
  return null;
};

/** The script `cmd /c …` or `pwsh -c …` runs: the rest of its words, `\` read as `/`. */
const cmdScript = (words: readonly string[]): string | null => {
  const name = baseName(words[0] ?? "");
  if (!/^(?:cmd|pwsh|powershell)$/u.test(name)) return null;
  const flag = words.findIndex((word, at) => at > 0 && /^[/-](?:c|k|command)$/iu.test(word));
  return flag < 0
    ? null
    : words
        .slice(flag + 1)
        .join(" ")
        .replaceAll("\\", "/") || null;
};

/** The command `workit check|lock run … -- <cmd>` runs. */
const workitScript = (words: readonly string[]): string | null => {
  if (!/^workit(?:-cli)?$/u.test(baseName(words[0] ?? ""))) return null;
  const dash = words.indexOf("--");
  return dash < 0 ? null : words.slice(dash + 1).join(" ") || null;
};

/** The text of every `$(…)` in `command` (not `$((`), its parentheses balanced, at most 32. */
const substitutions = (command: string): string[] => {
  const found: string[] = [];
  for (
    let at = command.indexOf("$(");
    at >= 0 && found.length < 32;
    at = command.indexOf("$(", at + 1)
  ) {
    if (command[at + 2] === "(") continue;
    let depth = 1;
    let end = at + 2;
    for (; end < command.length && depth > 0; end += 1)
      if (command[end] === "(") depth += 1;
      else if (command[end] === ")") depth -= 1;
    found.push(command.slice(at + 2, end - 1));
  }
  return found;
};

/** The Workit hook entry `command` runs from `cwd`, or null when it runs none. */
export const hookEntryRun = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
): string | null => {
  const scan = (text: string) =>
    scanCommand(text, dialect, {
      dir: cwd,
      vars: new Map([["PWD", cwd]]),
      links: new Set(),
      fds: new Set(),
      fed: null,
      depth: 0,
    });
  // An unquoted `C:\…` path loses its `\` to the POSIX reading: judged again with `/`. Every
  // `$(…)` is read on its own too, so one the reading drops (`(( $(…) ))`) still counts.
  const texts =
    dialect === "posix" && /[A-Za-z]:\\/u.test(command)
      ? [command, command.replaceAll("\\", "/")]
      : [command];
  for (const text of texts) {
    const hit = scan(text) ?? substitutions(text).map(scan).find(Boolean);
    if (hit) return hit;
  }
  return null;
};

export const hookEntryDeny = (entry: string): string =>
  `workit hook guard: this command runs Workit's hook entry ${entry}. Only the host runs Workit's hooks, with the payload it builds; a payload written in a shell would act as a session, subagent or agent that never existed. Use the workit CLI for what you need (\`workit doctor\` probes the installed hooks).`;
