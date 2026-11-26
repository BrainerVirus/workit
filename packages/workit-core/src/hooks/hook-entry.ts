// A shell command that runs one of Workit's own hook entries (#984). The host
// runs its hooks itself, outside the agent's shell tool, so no PreToolUse ever
// sees a real hook run: one in an agent's shell feeds the hook a payload the
// agent wrote (a SubagentStart that issues a token to a subagent that never
// existed, a SessionStart that rewrites the state-dir pin, a PreToolUse that
// stamps any agent id). Denied on every host when the command executes an
// entry: as its command word, behind wrappers, assignments and `env`, through
// an interpreter or package runner (`node`, `bun`, `deno`, `npx tsx`, a shell),
// on an interpreter's stdin (`node < entry`), in a `-c` script, a heredoc fed
// to a shell or a `$(…)`. A word names an entry by its basename or by its
// resolved path (after `$VAR`, `~`, a `cd` earlier in the command, a glob and
// symlinks) inside a Workit host package. A read (`cat`, `ls`, `git diff`)
// passes. An interpreter whose inline code imports the module, or a copy run
// from elsewhere, is the interpreter-class limit (hosts.md#host-parity).
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellScript } from "./delivery-verbs";
import { segmentsOf, type ShellDialect } from "./shell-words";
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
const NO_RUN = new Set(["build", "fmt", "lint", "check", "doc", "info", "install", "add", "pm"]);
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

/** `$NAME`/`${NAME}` from the command's own assignments, then the hook's environment; `~` home. */
const expand = (word: string, vars: ReadonlyMap<string, string>): string =>
  word
    .replace(/\$\{(\w+)\}|\$(\w+)/gu, (match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      return vars.get(name) ?? process.env[name] ?? match;
    })
    .replace(/^~(?=[\\/]|$)/u, os.homedir());

/** The paths an absolute glob expands to, segment by segment (at most 64), or the path itself. */
const globbed = (file: string): string[] => {
  if (!/[*?[]/u.test(file)) return [file];
  const { root } = path.parse(file);
  let found = [root];
  for (const part of file.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    if (!/[*?[]/u.test(part)) {
      found = found.map((dir) => path.join(dir, part));
      continue;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(
        `^${part
          .replace(/[.+^$(){}|\\]/gu, "\\$&")
          .replace(/\[!/gu, "[^")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")}$`,
        "u",
      );
    } catch {
      return [file];
    }
    found = found
      .flatMap((dir) => {
        try {
          return readdirSync(dir)
            .filter((name) => pattern.test(name))
            .map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      })
      .slice(0, 64);
  }
  return found.length > 0 ? found : [file];
};

type Scan = {
  /** Where the next relative path resolves; null once a `cd` Workit cannot follow ran. */
  dir: string | null;
  /** Paths the command's own assignments set. */
  vars: Map<string, string>;
  /** Links and copies of an entry the command makes before it runs them. */
  links: Set<string>;
  depth: number;
};

/** The hook entry `word` names in `scan`, as written, or null. */
const entryNamed = (word: string | undefined, scan: Scan): string | null => {
  if (!word) return null;
  const text = expand(word, scan.vars);
  if (ENTRY_NAMES.test(baseName(text))) return text;
  if (scan.dir === null && !path.isAbsolute(text)) return null;
  for (const file of globbed(path.resolve(scan.dir ?? "/", text))) {
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

/** The entry a command (and every script it nests) runs, or null. */
const scanCommand = (command: string, dialect: ShellDialect, scan: Scan): string | null => {
  let segments;
  try {
    segments = segmentsOf(command, dialect);
  } catch {
    return null;
  }
  for (const segment of segments) {
    const { words } = segment;
    if (segment.unanalyzable || words.length === 0) continue;
    const verb = baseName(words[0] ?? "");
    // `cd <dir>` moves where the next relative path resolves; one Workit cannot follow loses it.
    if (["cd", "pushd", "chdir", "set-location", "sl"].includes(verb)) {
      const target = words.slice(1).find((word) => !word.startsWith("-") || word === "-");
      const moved = target === undefined ? os.homedir() : expand(target, scan.vars);
      scan.dir =
        moved === "-" || /[$`]/u.test(moved)
          ? null
          : path.isAbsolute(moved)
            ? moved
            : scan.dir && path.resolve(scan.dir, moved);
      if (scan.dir === null) scan.vars.delete("PWD");
      else scan.vars.set("PWD", scan.dir);
      continue;
    }
    if (verb === "popd") {
      scan.dir = null;
      continue;
    }
    // `F=…` alone, or `export F=…`, names a path a later word may use.
    const assigns = ["export", "declare", "typeset", "local", "readonly"].includes(verb)
      ? words.slice(1)
      : words.every((word) => /^[A-Za-z_]\w*=/u.test(word))
        ? words
        : [];
    for (const word of assigns) {
      const [name = "", value] = word.split(/=(.*)/su);
      if (value !== undefined && /^[A-Za-z_]\w*$/u.test(name))
        scan.vars.set(name, expand(value.replace(/^(['"])(.*)\1$/su, "$2"), scan.vars));
    }
    const entry = runsEntry(words, segment.inputs ?? [], scan);
    if (entry) return entry;
    noteLink(words, scan);
    if (scan.depth >= 4) continue;
    const nested = (script: string) =>
      scanCommand(script, dialect, { ...scan, vars: new Map(scan.vars), depth: scan.depth + 1 });
    const scripts = [...(segment.subs ?? [])];
    const script = shellScript(words) ?? cmdScript(words);
    if (script) scripts.push(script);
    // A shell reading its script on stdin (`bash <<'EOF'`, `sh -s`) runs the heredoc.
    if (
      !script &&
      /^(?:ba|z|da|k)?sh$/u.test(verb) &&
      words.slice(1).every((word) => word.startsWith("-"))
    )
      scripts.push(...(segment.stdin ?? []));
    for (const text of scripts) {
      const hit = nested(text);
      if (hit) return hit;
    }
  }
  return null;
};

/** The script `cmd /c …` or `pwsh -c …` runs: the rest of its words. */
const cmdScript = (words: readonly string[]): string | null => {
  const name = baseName(words[0] ?? "");
  if (!/^(?:cmd|pwsh|powershell)$/u.test(name)) return null;
  const flag = words.findIndex((word, at) => at > 0 && /^[/-](?:c|k|command)$/iu.test(word));
  return flag < 0 ? null : words.slice(flag + 1).join(" ") || null;
};

/** The Workit hook entry `command` runs from `cwd`, or null when it runs none. */
export const hookEntryRun = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
): string | null =>
  scanCommand(command, dialect, {
    dir: cwd,
    vars: new Map([["PWD", cwd]]),
    links: new Set(),
    depth: 0,
  });

export const hookEntryDeny = (entry: string): string =>
  `workit hook guard: this command runs Workit's hook entry ${entry}. Only the host runs Workit's hooks, with the payload it builds; a payload written in a shell would act as a session, subagent or agent that never existed. Use the workit CLI for what you need (\`workit doctor\` probes the installed hooks).`;
