// Raw git/forge commands on an agent's shell (audit B1/B2). Workit's delivery
// rules (merge grant, verdict gate, protected branches, session trailer) live
// in its own verbs, so a raw command skips them. The pre-tool hook:
//   - refuses, inside a Workit workspace, the raw forms that bypass a gate:
//     `gh pr merge`, `glab mr merge`, and `git push` to the workspace's push
//     remote onto a protected branch or the default target, naming the
//     workit command;
//   - lets routine raw commands run (`git commit`, a feature-branch push,
//     `gh pr create|view|checks`, `glab mr create|view`) with a short nudge,
//     once per kind per session, and none on a command that runs workit.
// A raw `git commit` is recorded as the session's `commit.recorded` row so
// the author's own verdict never reads as independent. The pre-tool hook
// notes HEAD before the command (a marker in the commit's own repository);
// the post-tool hook records only a commit that moved HEAD away from it and
// was made after it, and that no other session claims. Hosts without a
// post-tool event settle the marker on the session's next shell command.
//
// Classification is string parsing only. Git is spawned only to read the new
// commit after a raw commit and the push remote before a deny; HEAD and the
// current branch are read from the git dir. Every failure answers "no
// decision": hooks fail open.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseBranch, resolveBranchPolicyFor, validateBranchNameFor } from "../core/branch";
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import { appendHookObserved, readLedger } from "../ledger";
import { resolveStore, resolveTaskKey, type StoreLocation } from "../store/paths";
import type { HookDecision, HookInput } from "./protocol";
import { readSessionMarker, sessionMarkerFile, writeSessionMarker } from "./session-marker";
import { segmentsOf, type Segment, type ShellDialect } from "./shell-words";

const NONE: HookDecision = { kind: "none" };

/** One git/gh/glab invocation: its arguments after global options, and the
 * directory it runs in relative to the hook's cwd (`cd x`, `git -C x`).
 * `dir` is undefined when it cannot be known (`cd -`, `cd $X`, an unmatched
 * `popd`): such an invocation never gets a decision. */
export type RawInvocation = {
  tool: "git" | "gh" | "glab";
  dir: string | null | undefined;
  args: string[];
  /** git's global options that change its configuration (`-c k=v`,
   * `--config-env`, `--git-dir`): replayed when its config is read. */
  config?: string[];
  /** Assignments before the command that change git's configuration
   * (`GIT_CONFIG_*`, `GIT_DIR`): replayed the same way. */
  env?: Record<string, string>;
  /** Its standard input when the command line spells it out: a heredoc, a
   * here-string or a literal `echo …|`/`printf …|`. */
  stdin?: string;
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "yash", "fish"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const EVALS = new Set(["eval", "iex", "invoke-expression"]);
/**
 * Wrappers that run the command after their options: the options that take
 * a value, and how many operands come before the command (`timeout 30`).
 */
const WRAPPERS: Record<string, { values: string; operands?: number }> = {
  sudo: { values: "-u -g -h -p -C -D -R -T -r -t -U --user --group --host --prompt --chdir" },
  doas: { values: "-u -C" },
  command: { values: "" },
  builtin: { values: "" },
  env: { values: "-u -C --unset --chdir" },
  nohup: { values: "" },
  setsid: { values: "" },
  time: { values: "-f -o --format --output" },
  exec: { values: "-a" },
  nice: { values: "-n --adjustment" },
  ionice: { values: "-c -n -p --class --classdata" },
  stdbuf: { values: "-i -o -e --input --output --error" },
  chronic: { values: "" },
  unbuffer: { values: "" },
  wsl: { values: "-d -u --cd --distribution --user" },
  timeout: { values: "-s -k --signal --kill-after", operands: 1 },
  flock: { values: "-w -E --timeout --conflict-exit-code", operands: 1 },
  "&": { values: "" },
};
const WRAPPER_VALUES = new Map(
  Object.entries(WRAPPERS).map(([name, wrapper]) => [name, new Set(wrapper.values.split(" "))]),
);
/** Shell keywords that open a compound command: the command follows them. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const DECLARATIONS = new Set(["export", "local", "declare", "readonly", "typeset"]);
const SCRIPT_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const CD = new Set(["cd", "chdir", "set-location", "sl"]);
const PUSHD = new Set(["pushd", "push-location"]);
const POPD = new Set(["popd", "pop-location"]);
/** git global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
]);
/** git global options that change which configuration it reads. */
const GIT_CONFIG_OPTIONS = new Set(["-c", "--config-env", "--git-dir"]);
/** Environment that changes which configuration git reads; nothing that runs code. */
const GIT_CONFIG_ENV = /^GIT_(?:CONFIG\w*|DIR|COMMON_DIR|WORK_TREE)$/;
const ASSIGNMENT = /^([A-Za-z_]\w*)=([\s\S]*)$/;
/** Nested scripts (`bash -c`, `eval`, aliases) are followed this deep. */
const MAX_DEPTH = 4;
/** One word expands to at most this many (loop lists, brace lists). */
const MAX_EXPANSIONS = 16;

type Dir = string | null | undefined;

const isAbsolute = (value: string) =>
  path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");

const joinDir = (base: Dir, next: string): Dir => {
  if (base === undefined || /[$`*?]/.test(next) || next === "-") return undefined;
  const expanded =
    next === "~" || next.startsWith("~/") ? path.join(os.homedir(), next.slice(1)) : next;
  return base === null || isAbsolute(expanded) ? expanded : path.join(base, expanded);
};

/** An inner script's directory, relative to the one it was started in. */
const rebase = (base: Dir, inner: Dir): Dir =>
  inner === null ? base : inner === undefined ? undefined : joinDir(base, inner);

/** The directory operand of `cd`/`Set-Location` (`-Path x`, `-LiteralPath x`). */
const cdTarget = (words: string[]): string | null => {
  const args = words.slice(1);
  const flag = args.findIndex((word) => /^-(?:literal)?path$/i.test(word));
  if (flag >= 0) return args[flag + 1] ?? null;
  return args.find((word) => word === "-" || !word.startsWith("-")) ?? null;
};

/**
 * Drop env assignments, compound-command keywords (`if`, `do`, `{`) and
 * wrappers (`sudo`, `env -i`, `timeout 30`) with their options. The
 * assignments that change git's configuration are kept aside.
 */
const stripPrefixes = (input: string[]): { words: string[]; env: Record<string, string> } => {
  let words = input;
  const env: Record<string, string> = {};
  for (;;) {
    const first = words[0];
    if (first === undefined) return { words, env };
    const assignment = ASSIGNMENT.exec(first);
    if (assignment) {
      if (GIT_CONFIG_ENV.test(assignment[1])) env[assignment[1]] = assignment[2];
      words = words.slice(1);
    } else if (KEYWORDS.has(first)) words = words.slice(1);
    else if (Object.hasOwn(WRAPPERS, commandName(first))) {
      const name = commandName(first);
      const values = WRAPPER_VALUES.get(name)!;
      words = words.slice(1);
      while (words[0]?.startsWith("-") && words[0] !== "--")
        words = words.slice(values.has(words[0]) ? 2 : 1);
      if (words[0] === "--") words = words.slice(1);
      words = words.slice(WRAPPERS[name].operands ?? 0);
    } else return { words, env };
  }
};

const commandName = (word: string | undefined) =>
  (word?.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.exe$/, "");

const VARIABLE = /\$(?:\{(\w+)\}|(\w+))/g;

/** One word with the known variables substituted (a loop list gives several). */
const expandWord = (word: string, vars: ReadonlyMap<string, string[]>): string[] => {
  if (!word.includes("$")) return [word];
  let results = [""];
  let last = 0;
  for (const match of word.matchAll(VARIABLE)) {
    const values = vars.get(match[1] ?? match[2]) ?? [match[0]];
    const before = word.slice(last, match.index);
    results = results
      .flatMap((result) => values.map((value) => result + before + value))
      .slice(0, MAX_EXPANSIONS);
    last = match.index + match[0].length;
  }
  return results.map((result) => result + word.slice(last));
};

/** Every command line a segment stands for once its known variables are substituted. */
const substitute = (words: string[], vars: ReadonlyMap<string, string[]>): string[][] => {
  if (vars.size === 0) return [words];
  let lines: string[][] = [[]];
  for (const word of words) {
    const values = expandWord(word, vars);
    lines = lines
      .flatMap((line) => values.map((value) => [...line, value]))
      .slice(0, MAX_EXPANSIONS);
  }
  return lines;
};

/**
 * A segment that only assigns (`B=x`, `export B=x`) or opens a `for` loop
 * over literal words: the variables it sets. Null for any other segment.
 */
const assignments = (
  words: string[],
  vars: ReadonlyMap<string, string[]>,
): Array<[string, string[]]> | null => {
  if (words[0] === "for" && words[2] === "in" && /^\w+$/.test(words[1] ?? "")) {
    const values = words.slice(3).flatMap((word) => expandWord(word, vars));
    return [[words[1], values.slice(0, MAX_EXPANSIONS)]];
  }
  let rest = words;
  if (DECLARATIONS.has(rest[0] ?? "")) {
    rest = rest.slice(1);
    while (rest[0]?.startsWith("-")) rest = rest.slice(1);
  }
  if (rest.length === 0 || !rest.every((word) => ASSIGNMENT.test(word))) return null;
  return rest.map((word) => {
    const [, name, value] = ASSIGNMENT.exec(word)!;
    return [name, expandWord(value, vars)];
  });
};

/** What a literal producer piped into the next command writes (`echo x |`, `printf 'x\n' |`). */
const literalOutput = (segment: Segment | undefined): string | undefined => {
  if (!segment?.pipe) return undefined;
  const { words } = stripPrefixes(segment.words);
  const name = commandName(words[0]);
  if (name === "echo") {
    let args = words.slice(1);
    while (/^-[neE]+$/.test(args[0] ?? "")) args = args.slice(1);
    return args.join(" ");
  }
  if (name === "printf") {
    const [format = "", ...args] = words.slice(1);
    return (args.length ? args.join("\n") : format).replace(/\\n/g, "\n");
  }
  if (name === "cat" && words.length === 1 && segment.stdin) return segment.stdin.join("\n");
  return undefined;
};

const stdinOf = (segment: Segment, previous: Segment | undefined): string | undefined =>
  segment.stdin ? segment.stdin.join("\n") : literalOutput(previous);

/** xargs options that take a value (`-n 1`, `-d '\n'`). */
const XARGS_VALUES = new Set(
  ["-n", "-L", "-l", "-P", "-d", "-E", "-e", "-s", "-a", "--arg-file", "--delimiter"].concat([
    "--max-args",
    "--max-lines",
    "--max-procs",
    "--eof",
    "--max-chars",
    "--process-slot-var",
  ]),
);

/**
 * The commands `xargs …` runs: its command with the input appended, or
 * with `-I R` replaced per input line. Input that is not spelled out on
 * the command line adds nothing, like a `$VAR` name it stays unjudged.
 */
const xargsCommands = (words: string[], input: string | undefined): string[][] => {
  let replace: string | null = null;
  let index = 1;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word === "--") {
      index++;
      break;
    }
    if (!word.startsWith("-")) break;
    if (word === "-I") replace = words[++index] ?? "{}";
    else if (word === "--replace" || word === "-i") replace = "{}";
    else if (word.startsWith("--replace=")) replace = word.slice("--replace=".length);
    else if (/^-[Ii]./.test(word)) replace = word.slice(2);
    else if (XARGS_VALUES.has(word)) index++;
  }
  const command = words.slice(index);
  if (command.length === 0) return [];
  if (input === undefined) return [command];
  if (replace === null) return [[...command, ...input.split(/\s+/).filter(Boolean)]];
  const token = replace;
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_EXPANSIONS)
    .map((line) => command.map((word) => word.replaceAll(token, line)));
};

/** The commands `find … -exec cmd … ;` runs. */
const findCommands = (words: string[]): string[][] => {
  const found: string[][] = [];
  for (let index = 1; index < words.length; index++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[index])) continue;
    const end = words.findIndex((word, at) => at > index && (word === ";" || word === "+"));
    found.push(words.slice(index + 1, end < 0 ? undefined : end));
    if (end < 0) break;
    index = end;
  }
  return found;
};

/** PowerShell parameters that take a value; any other is a switch. */
const POWERSHELL_VALUES =
  /^-(?:f|file|ex|executionpolicy|wd|workingdirectory|config|configurationname|o|outputformat|if|inputformat|inp|w|windowstyle|settingsfile|custompipename|psconsolefile)$/;

/**
 * The script `pwsh`/`powershell` runs: `-Command …` (the rest of the line),
 * `-CommandWithArgs`, or `-EncodedCommand` (base64 UTF-16LE). Parameter
 * names match case-insensitively and by unambiguous prefix. Null for a
 * script file or an interactive shell.
 */
const powershellScript = (words: string[], stdin?: string): string | null => {
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (!/^[-/]/.test(word)) return null;
    const flag = word.replace(/^[-/]+/, "").toLowerCase();
    if (!flag) return null;
    if (flag === "e" || flag === "ec" || (flag.length >= 2 && "encodedcommand".startsWith(flag))) {
      try {
        return Buffer.from(words[index + 1] ?? "", "base64").toString("utf16le");
      } catch {
        return null;
      }
    }
    if (flag === "cwa" || (flag.length >= 8 && "commandwithargs".startsWith(flag)))
      return words[index + 1] ?? null;
    if ("command".startsWith(flag))
      return words[index + 1] === "-" ? (stdin ?? null) : words.slice(index + 1).join(" ");
    if (POWERSHELL_VALUES.test(`-${flag}`)) {
      if (flag === "f" || flag === "file") return null;
      index++;
    }
  }
  return null;
};

/** The script `cmd /c …` (or `/k`) runs. */
const cmdScript = (words: string[]): string | null => {
  const at = words.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
  if (at > 0) return words.slice(at + 1).join(" ");
  const attached = words.find((word, index) => index > 0 && /^\/[ck]./i.test(word));
  return attached
    ? [attached.slice(2), ...words.slice(words.indexOf(attached) + 1)].join(" ")
    : null;
};

/** The script a posix shell runs: `-c '…'`, else its stdin when it has no script operand. */
const shellScript = (words: string[], stdin: string | undefined): string | undefined => {
  const flag = words.findIndex((word, index) => index > 0 && SCRIPT_FLAG.test(word));
  if (flag > 0) return words[flag + 1] === "--" ? words[flag + 2] : words[flag + 1];
  return words.slice(1).every((word) => word.startsWith("-")) ? stdin : undefined;
};

/** `env -S 'cmd args'` (`--split-string`): the command line it splits, or null. */
const splitString = (line: string[]): string | null => {
  if (commandName(line[0]) !== "env") return null;
  for (let index = 1; index < line.length; index++) {
    const word = line[index];
    if (word === "-S" || word === "--split-string") return line.slice(index + 1).join(" ");
    if (word.startsWith("--split-string=")) return line.slice(index).join(" ").slice(15);
    if (/^-S./.test(word)) return [word.slice(2), ...line.slice(index + 1)].join(" ");
    if (!word.startsWith("-") && !ASSIGNMENT.test(word)) return null;
  }
  return null;
};

/**
 * A git invocation from the words after `git`: global options are read up
 * to the subcommand; `-C` moves the directory and the configuration options
 * are kept so an alias is resolved under them.
 */
const gitInvocation = (
  words: string[],
  dir: Dir,
  env: Record<string, string> = {},
  stdin?: string,
  inherited: string[] = [],
): RawInvocation => {
  let here = dir;
  const config = [...inherited];
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word === "-C") here = words[index + 1] ? joinDir(here, words[++index]) : here;
    else if (GIT_CONFIG_OPTIONS.has(word)) {
      if (words[index + 1] !== undefined) config.push(word, words[++index]);
    } else if (/^--(?:config-env|git-dir)=/.test(word)) config.push(word);
    else if (GIT_VALUE_OPTIONS.has(word)) index++;
    else if (!word.startsWith("-")) break;
  }
  return {
    tool: "git",
    dir: here,
    args: words.slice(index),
    ...(config.length ? { config } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(stdin === undefined ? {} : { stdin }),
  };
};

/**
 * Every git/gh/glab invocation in a shell command: `&&`/`;`/`|` chains,
 * `cd`/`pushd`/`popd` before it (scoped to `( … )` groups), `git -C dir`,
 * env prefixes, compound commands (`if`, `for`, `{ …; }`), literal
 * variables and loop lists, command substitutions, `bash -c '…'`, `eval`,
 * `xargs`, `find -exec`, `pwsh -Command`/`-EncodedCommand`, `cmd /c` and
 * shells fed a heredoc or a literal pipe. One hook call asks several
 * times for the same command: the last answers are kept.
 */
export function rawInvocations(
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): readonly RawInvocation[] {
  if (depth > 0) return walk(command, dialect, depth);
  const key = `${dialect}\0${command}`;
  const cached = RECENT.get(key);
  if (cached) return cached;
  const found = walk(command, dialect, depth);
  RECENT.set(key, found);
  if (RECENT.size > 8) RECENT.delete(RECENT.keys().next().value as string);
  return found;
}

/** The invocations of the last few commands parsed (pure: same text, same answer). */
const RECENT = new Map<string, readonly RawInvocation[]>();

function walk(command: string, dialect: ShellDialect, depth: number): RawInvocation[] {
  const found: RawInvocation[] = [];
  let dir: Dir = null;
  const groups: Array<{ dir: Dir; stack: Dir[] }> = [];
  let stack: Dir[] = [];
  const vars = new Map<string, string[]>();
  const nested = (script: string | null | undefined, inner: ShellDialect) => {
    if (!script || depth >= MAX_DEPTH) return;
    for (const invocation of rawInvocations(script, inner, depth + 1))
      found.push({ ...invocation, dir: rebase(dir, invocation.dir) });
  };
  const visit = (line: string[], stdin: string | undefined, hops: number) => {
    const split = splitString(line);
    if (split !== null) return nested(split, "posix");
    const { words, env } = stripPrefixes(line);
    const name = commandName(words[0]);
    if (!name) return;
    if (CD.has(name)) {
      const target = cdTarget(words);
      dir = target === null ? os.homedir() : joinDir(dir, target);
    } else if (PUSHD.has(name)) {
      const target = cdTarget(words);
      stack.push(dir);
      dir = target === null || target === "-" ? undefined : joinDir(dir, target);
    } else if (POPD.has(name)) dir = stack.length ? stack.pop() : undefined;
    else if (EVALS.has(name)) nested(words.slice(1).join(" "), dialect);
    else if (SHELLS.has(name)) nested(shellScript(words, stdin), "posix");
    else if (POWERSHELLS.has(name)) nested(powershellScript(words, stdin), "powershell");
    else if (name === "cmd") nested(cmdScript(words), "powershell");
    else if (name === "xargs" || name === "find") {
      if (hops >= MAX_DEPTH) return;
      const commands = name === "xargs" ? xargsCommands(words, stdin) : findCommands(words);
      for (const inner of commands) visit(inner, undefined, hops + 1);
    } else if (name === "gh" || name === "glab")
      found.push({ tool: name, dir, args: words.slice(1) });
    else if (name === "git") found.push(gitInvocation(words.slice(1), dir, env, stdin));
  };
  const segments = segmentsOf(command, dialect);
  for (const [index, segment] of segments.entries()) {
    if (segment.group === "open") {
      groups.push({ dir, stack: [...stack] });
      continue;
    }
    if (segment.group === "close") {
      const saved = groups.pop();
      if (saved) ({ dir, stack } = saved);
      continue;
    }
    for (const sub of segment.subs ?? []) nested(sub, "posix");
    const set = assignments(segment.words, vars);
    if (set) {
      for (const [name, values] of set) vars.set(name, values);
      continue;
    }
    const stdin = stdinOf(segment, segments[index - 1]);
    for (const line of substitute(segment.words, vars)) visit(line, stdin, 0);
  }
  return found;
}

const LAUNCHERS = new Set([
  "npx",
  "bunx",
  "pnpx",
  "-y",
  "--yes",
  "pnpm",
  "dlx",
  "exec",
  "env",
  "sudo",
  "command",
]);
const WORKIT_BIN = /(?:^|[\\/])workit(?:\.exe)?$|^@brainervirus\/workit-cli$/;

/**
 * The arguments of every workit CLI invocation in a shell command: past env
 * assignments and package runners (`npx -y @brainervirus/workit-cli …`), and
 * inside `bash -c '…'` scripts.
 */
export function workitInvocations(
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): string[][] {
  const found: string[][] = [];
  for (const { words } of segmentsOf(command, dialect)) {
    const at = words.findIndex((word) => !/^\w+=/.test(word) && !LAUNCHERS.has(word));
    if (at < 0) continue;
    if (WORKIT_BIN.test(words[at])) {
      found.push(words.slice(at + 1));
      continue;
    }
    const shell = SHELLS.has(commandName(words[at]));
    const script = shell && words[at + 1] === "-c" ? words[at + 2] : undefined;
    if (depth < 3 && script !== undefined)
      found.push(...workitInvocations(script, "posix", depth + 1));
  }
  return found;
}

/** What one raw invocation means for workit. */
export type RawAction =
  | { kind: "commit"; amend: boolean }
  | {
      kind: "push";
      /** Branches named by the refspecs; `null` stands for the current branch. */
      targets: Array<string | null>;
      /** Forced without a lease (`--force`, `-f`, `+refspec`). */
      blindForce: boolean;
      /** The remote named on the command line; null pushes to the default one. */
      remote: string | null;
      /** Tags named as `refs/tags/<t>` destinations (bare names are told apart later). */
      tags?: string[];
      /** `--tags`: every tag goes along. */
      allTags?: true;
      /** `--delete`/`-d`: the refspecs are deleted, not pushed. */
      deletes?: true;
      /** Names deleted by a colon refspec (`:chore/old`). */
      deleted?: string[];
      /** `--all`/`--branches`: every local branch. */
      allBranches?: true;
      /** `--mirror`: every ref, deletions included. */
      mirror?: true;
      /** No refspec: push.default and remote.<name>.push decide what goes. */
      implicit?: true;
      /** Glob refspecs (`refs/heads/*:refs/heads/*`), expanded against local refs. */
      globs?: Array<{ source: string; destination: string }>;
      /** `:` (or push.default=matching): every branch both sides have. */
      matching?: true;
    }
  | { kind: "merge"; forge: "gh" | "glab"; via?: "api" }
  | { kind: "pr-create"; forge: "gh" | "glab" }
  | { kind: "pr-read"; forge: "gh" | "glab" };

/** git push options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

type PushTarget = { name: string | null | undefined; tag?: string };

/** The destination of one push refspec: a branch, `null` for HEAD, undefined for another namespace. */
/** `$(git branch --show-current)` and its spellings: the current branch. */
const CURRENT_BRANCH =
  /^\$\(\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+HEAD)\s*\)$/;

const pushDestination = (destination: string): PushTarget => {
  if (destination === "HEAD" || destination === "@" || CURRENT_BRANCH.test(destination))
    return { name: null };
  if (destination.startsWith("refs/heads/")) return { name: destination.slice(11) };
  if (destination.startsWith("refs/tags/")) return { name: undefined, tag: destination.slice(10) };
  if (destination.startsWith("refs/")) return { name: undefined };
  return { name: destination };
};

/** The parts of a push the refspecs name (`[+]<src>[:<dst>]`). */
const pushRefspecs = (specs: readonly string[]) => {
  let force = false;
  let matching = false;
  const targets: Array<string | null> = [];
  const tags: string[] = [];
  const deleted: string[] = [];
  const globs: Array<{ source: string; destination: string }> = [];
  for (const raw of specs) {
    if (raw.startsWith("+")) force = true;
    const spec = raw.replace(/^\+/, "");
    if (spec.startsWith("^")) continue;
    if (spec === ":") {
      matching = true;
      continue;
    }
    const colon = spec.indexOf(":");
    const source = colon >= 0 ? spec.slice(0, colon) : spec;
    const destination = colon >= 0 ? spec.slice(colon + 1) : spec;
    if (!destination) continue;
    if (destination.includes("*")) {
      globs.push({ source, destination });
      continue;
    }
    const { name, tag } = pushDestination(destination);
    if (tag !== undefined) tags.push(tag);
    if (name === undefined) continue;
    targets.push(name);
    if (colon === 0 && name !== null) deleted.push(name);
  }
  return { force, matching, targets, tags, deleted, globs };
};

export const pushAction = (args: string[]): RawAction | null => {
  let force = false;
  let lease = false;
  let wholesale = false;
  let allTags = false;
  let deletes = false;
  let allBranches = false;
  let mirror = false;
  let remote: string | null = null;
  // The last of --dry-run (or an abbreviation, or -n) and --no-dry-run wins.
  let dryRun = false;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (/^--dr(?:y(?:-(?:r(?:un?)?)?)?)?$/.test(arg) || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg))
      dryRun = true;
    else if (/^--no-dr(?:y(?:-(?:r(?:un?)?)?)?)?$/.test(arg)) dryRun = false;
    else if (arg === "--repo") remote = args[++index] ?? null;
    else if (arg.startsWith("--repo=")) remote = arg.slice("--repo=".length);
    else if (PUSH_VALUE_OPTIONS.has(arg)) index++;
    else if (arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) force = true;
    else if (arg.startsWith("--force-with-lease") || arg === "--force-if-includes") lease = true;
    else if (arg === "--delete" || arg === "-d") deletes = true;
    else if (arg === "--tags") allTags = wholesale = true;
    else if (arg === "--all" || arg === "--branches") allBranches = wholesale = true;
    else if (arg === "--mirror") mirror = wholesale = true;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (dryRun) return null;
  // `--repo` names the remote; positionals are then all refspecs.
  const specs = remote === null ? positionals.slice(1) : positionals;
  remote ??= positionals[0] ?? null;
  const parsed = pushRefspecs(specs);
  // No refspec pushes what push.default says (the current branch by default).
  const implicit = specs.length === 0 && !wholesale;
  if (implicit) parsed.targets.push(null);
  return {
    kind: "push",
    targets: parsed.targets,
    blindForce: (force || parsed.force) && !lease,
    remote,
    ...(parsed.tags.length ? { tags: parsed.tags } : {}),
    ...(allTags ? { allTags: true as const } : {}),
    ...(deletes ? { deletes: true as const } : {}),
    ...(parsed.deleted.length ? { deleted: parsed.deleted } : {}),
    ...(allBranches ? { allBranches: true as const } : {}),
    ...(mirror ? { mirror: true as const } : {}),
    ...(implicit ? { implicit: true as const } : {}),
    ...(parsed.globs.length ? { globs: parsed.globs } : {}),
    ...(parsed.matching ? { matching: true as const } : {}),
  };
};

/** Options whose next word is their value (never an option or subcommand). */
const VALUE_OPTIONS: Record<RawInvocation["tool"], ReadonlySet<string>> = {
  git: new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-C",
    "-c",
    "--reuse-message",
    "--reedit-message",
    "--author",
    "--date",
    "--trailer",
    "-t",
    "--template",
    "--cleanup",
    "--fixup",
    "--squash",
    "-o",
    "--push-option",
    "--repo",
    "--receive-pack",
    "--exec",
  ]),
  gh: new Set(
    ["-b", "--body", "-F", "--body-file", "-t", "--title", "--subject", "-A", "--author-email"]
      .concat(["-B", "--base", "-H", "--head", "-l", "--label", "-a", "--assignee"])
      .concat(["-r", "--reviewer", "-m", "--milestone", "-p", "--project", "-T", "--template"])
      .concat(["--match-head-commit", "-R", "--repo"]),
  ),
  glab: new Set(
    ["-m", "--message", "--squash-message", "--sha", "-t", "--title", "-d", "--description"]
      .concat(["-b", "--target-branch", "-s", "--source-branch", "-l", "--label"])
      .concat(["-a", "--assignee", "--reviewer", "-R", "--repo"]),
  ),
};

/**
 * A help request: `help` as the subcommand (`git help push`, `gh pr help`),
 * or `--help`/`-h` where an option can stand, never as an option's value
 * (`git commit -m help` is a commit).
 */
const asksHelp = (invocation: RawInvocation): boolean => {
  const { tool, args } = invocation;
  if (args[0] === "help" || (tool !== "git" && args[1] === "help")) return true;
  const values = VALUE_OPTIONS[tool];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
    if (values.has(arg)) index++;
  }
  return false;
};

/** `gh api`/`glab api` options that take a value, long and short. */
const API_VALUES = new Set(
  ["--method", "--header", "--raw-field", "--field", "--jq", "--template", "--input"].concat([
    "--hostname",
    "--preview",
    "--cache",
    "--output",
  ]),
);
const API_SHORT_VALUES = "XHfFqtp";
const API_FIELDS = new Set(["-f", "-F", "--raw-field", "--field"]);
/** REST merges: a PR (`pulls/<n>/merge`), a branch into another (`merges`), an MR. */
const API_MERGE = {
  gh: /(?:^|\/)(?:pulls\/[^/?#]+\/merge|merges)\/?(?:[?#]|$)/i,
  glab: /(?:^|\/)merge_requests\/[^/?#]+\/merge\/?(?:[?#]|$)/i,
};
/** GraphQL mutations that merge. */
const GRAPHQL_MERGE =
  /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch|mergeRequestAccept)\b/;

/**
 * `gh api`/`glab api` that merges: a write (any method but GET/HEAD; fields
 * or `--input` without `-X` make it a POST) to a merge endpoint, or a GraphQL
 * merge mutation. Options are read wherever they stand; a help flag does not
 * excuse a merge (it can be another option's value).
 */
const apiMerges = (tool: "gh" | "glab", args: string[]): boolean => {
  const request = { method: null as string | null, body: false };
  let endpoint: string | null = null;
  const values: string[] = [];
  const take = (name: string, value: string) => {
    if (name === "-X" || name === "--method") request.method = value.toUpperCase();
    if (API_FIELDS.has(name) || name === "--input") request.body = true;
    values.push(value);
  };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      endpoint ??= args[index + 1] ?? null;
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (API_VALUES.has(name)) take(name, eq > 0 ? arg.slice(eq + 1) : (args[++index] ?? ""));
    } else if (arg.startsWith("-") && arg.length > 1) {
      // A cluster of short flags; the first one that takes a value ends it.
      for (let at = 1; at < arg.length; at++) {
        if (!API_SHORT_VALUES.includes(arg[at])) continue;
        take(`-${arg[at]}`, at + 1 < arg.length ? arg.slice(at + 1) : (args[++index] ?? ""));
        break;
      }
    } else endpoint ??= arg;
  }
  if (!endpoint) return false;
  if (/(?:^|\/)graphql\/?$/i.test(endpoint))
    return values.some((value) => GRAPHQL_MERGE.test(value));
  const verb = request.method ?? (request.body ? "POST" : "GET");
  return verb !== "GET" && verb !== "HEAD" && API_MERGE[tool].test(endpoint);
};

/** The workit meaning of one invocation; null for read-only, help or unrelated ones. */
export function rawAction(invocation: RawInvocation): RawAction | null {
  const args = invocation.args;
  if (invocation.tool !== "git" && args[0] === "api")
    return apiMerges(invocation.tool, args)
      ? { kind: "merge", forge: invocation.tool, via: "api" }
      : null;
  if (asksHelp(invocation)) return null;
  const [first, second] = args;
  if (invocation.tool === "git") {
    if (first === "commit")
      return args.includes("--dry-run")
        ? null
        : { kind: "commit", amend: args.includes("--amend") };
    if (first === "push") return pushAction(args);
    return null;
  }
  const forge = invocation.tool;
  const noun = forge === "gh" ? "pr" : "mr";
  if (first !== noun) return null;
  if (second === "merge") return { kind: "merge", forge };
  if (second === "create") return { kind: "pr-create", forge };
  if (["view", "checks", "status", "ci", "list"].includes(second ?? ""))
    return { kind: "pr-read", forge };
  return null;
}

// ---------------------------------------------------------------------------
// repository facts (filesystem only)

type Repo = { location: StoreLocation; dir: string; branch: string | null };

const repoAt = (dir: string): Repo | null => {
  const location = resolveStore(dir);
  if (location instanceof Error || !location.shared) return null;
  return { location, dir, branch: resolveTaskKey(dir, location).branch };
};

/** A repository Workit manages: it has a Workit store, or workspaces.json matches it. */
const isWorkitWorkspace = (repo: Repo): boolean => {
  if (fs.existsSync(repo.location.dir)) return true;
  try {
    return resolveRuntimeWorkspaceVcs(repo.location.top ?? repo.dir) !== null;
  } catch {
    return false;
  }
};

/** Protected by the branch policy, or the workspace's default target. */
export const guardedBranch = (dir: string, branch: string): boolean => {
  try {
    const policy = resolveBranchPolicyFor(dir);
    return (
      policy.protected.has(branch.toLowerCase()) ||
      policy.defaultTargetBranch.toLowerCase() === branch.toLowerCase()
    );
  } catch {
    return false;
  }
};

/** HEAD's commit read from the git dir (loose or packed ref), or null. */
const headSha = (repo: Repo): string | null => {
  const git = repo.location.git;
  if (!git || git.reftable) return null;
  try {
    const head = fs.readFileSync(path.join(git.gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const common = path.dirname(repo.location.dir);
    try {
      return fs.readFileSync(path.join(common, ref), "utf8").trim() || null;
    } catch {}
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    return (
      new RegExp(`^([0-9a-f]{40,64}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(
        packed,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// git configuration (one `git config --list` per directory and command line)

type GitConfig = Map<string, string[]>;
/** Configuration read once per hook call, keyed by directory and replayed options. */
type ConfigCache = Map<string, GitConfig>;

/**
 * The configuration an invocation runs under in `dir`, its `-c`/
 * `--config-env`/`--git-dir` options and GIT_CONFIG_* assignments
 * replayed. Reading config runs nothing. Empty on any failure.
 */
const gitConfig = (dir: string, invocation: RawInvocation, cache: ConfigCache): GitConfig => {
  const key = JSON.stringify([dir, invocation.config ?? [], invocation.env ?? {}]);
  const cached = cache.get(key);
  if (cached) return cached;
  const config: GitConfig = new Map();
  const listed = spawnSync("git", [...(invocation.config ?? []), "config", "-z", "--list"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    env: { ...process.env, ...invocation.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  for (const entry of (listed.status === 0 ? listed.stdout : "").split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const name = newline < 0 ? entry : entry.slice(0, newline);
    config.set(name, [
      ...(config.get(name) ?? []),
      newline < 0 ? "true" : entry.slice(newline + 1),
    ]);
  }
  cache.set(key, config);
  return config;
};

const configValue = (config: GitConfig, key: string) => config.get(key)?.at(-1);

/** git's own commands (`git --list-cmds=main`): an alias never shadows one. */
const GIT_COMMANDS = new Set(
  (
    "add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr " +
    "check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick " +
    "citool clean clone column commit commit-graph commit-tree config count-objects credential " +
    "daemon describe diagnose diff diff-files diff-index diff-tree difftool fast-export " +
    "fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo " +
    "format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init " +
    "instaweb interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit " +
    "maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree " +
    "multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune pull push " +
    "range-diff read-tree rebase reflog remote repack replace request-pull rerere reset " +
    "restore rev-list rev-parse revert rm send-email shortlog show show-branch show-ref " +
    "sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag " +
    "update-index update-ref var verify-commit verify-pack verify-tag version whatchanged " +
    "worktree write-tree"
  ).split(" "),
);

/** The commands workit judges: what help.autocorrect may turn a typo into. */
const JUDGED_COMMANDS = [
  "push",
  "commit",
  "switch",
  "checkout",
  "branch",
  "worktree",
  "stash",
  "update-ref",
  "symbolic-ref",
  "fetch",
  "pull",
  "subtree",
];

/** Edits between two words, a swap of neighbours counting as one (git's typos). */
const editDistance = (a: string, b: string): number => {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j], before[j - 2] + 1);
    }
    [before, previous] = [previous, row];
  }
  return previous[b.length];
};

/** With help.autocorrect set to run, the judged command a typo runs as (unique and within 2 edits). */
const autocorrected = (name: string, config: GitConfig): string | null => {
  const setting = (configValue(config, "help.autocorrect") ?? "0").toLowerCase();
  if (setting !== "immediate" && !/^-?[1-9]\d*$/.test(setting)) return null;
  let best: string | null = null;
  let bestDistance = 3;
  let tie = false;
  for (const command of JUDGED_COMMANDS) {
    const distance = editDistance(name, command);
    if (distance < bestDistance) [best, bestDistance, tie] = [command, distance, false];
    else if (distance === bestDistance) tie = true;
  }
  return tie ? null : best;
};

const shellQuote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** A `!` alias's `$1`…`$9`, `$@` and `$*` with the arguments git hands it. */
const positional = (script: string, args: readonly string[]): string => {
  const word = (arg: string) => (/^[\w./@+:=-]+$/.test(arg) ? arg : shellQuote(arg));
  return script
    .replace(/\$\{?([1-9])\}?/g, (_, n: string) => word(args[Number(n) - 1] ?? ""))
    .replace(/\$\{?[@*]\}?/g, args.map(word).join(" "));
};

/**
 * A git invocation as git runs it once its alias is resolved: aliases from
 * the repository and user config, `-c alias.x=…` and GIT_CONFIG_* all count,
 * and expand recursively. A `!` alias is a shell script, read like any
 * other command line. With help.autocorrect set to run, a near-miss of a
 * judged command runs as that command. git's own commands spawn nothing.
 */
export const expandGitAliases = (
  root: string,
  invocation: RawInvocation,
  cache: ConfigCache = new Map(),
  depth = 0,
): RawInvocation[] => {
  const sub = invocation.args[0];
  if (
    invocation.tool !== "git" ||
    invocation.dir === undefined ||
    !sub ||
    sub.startsWith("-") ||
    GIT_COMMANDS.has(sub) ||
    depth >= MAX_DEPTH
  )
    return [invocation];
  const dir = path.resolve(root, invocation.dir ?? ".");
  if (!fs.existsSync(dir)) return [invocation];
  const config = gitConfig(dir, invocation, cache);
  const alias = configValue(config, `alias.${sub.toLowerCase()}`);
  if (alias === undefined) {
    const corrected = autocorrected(sub, config);
    return corrected
      ? [{ ...invocation, args: [corrected, ...invocation.args.slice(1)] }]
      : [invocation];
  }
  const rest = invocation.args.slice(1);
  const expanded = alias.startsWith("!")
    ? // A shell alias inherits the outer -c options and environment.
      rawInvocations([positional(alias.slice(1), rest), ...rest.map(shellQuote)].join(" ")).map(
        (inner) => ({
          ...inner,
          dir: rebase(invocation.dir, inner.dir),
          ...(inner.tool === "git" && (invocation.config || inner.config)
            ? { config: [...(invocation.config ?? []), ...(inner.config ?? [])] }
            : {}),
          ...(inner.tool === "git" && (invocation.env || inner.env)
            ? { env: { ...invocation.env, ...inner.env } }
            : {}),
        }),
      )
    : [
        gitInvocation(
          [...(segmentsOf(alias)[0]?.words ?? []), ...rest],
          invocation.dir,
          invocation.env,
          invocation.stdin,
          invocation.config,
        ),
      ];
  return expanded.flatMap((inner) => expandGitAliases(root, inner, cache, depth + 1));
};

/** A remote URL in a comparable form: no scheme, credentials, port, trailing `/` or `.git`. */
const normalizedUrl = (url: string, dir: string): string => {
  let value = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (scheme)
    value = value
      .slice(scheme[0].length)
      .replace(/^[^@/]*@/, "")
      .replace(/^([^/:]+):\d+(?=\/)/, "$1");
  else if (/^(?:[^@/\\]+@)?[^/\\:]{2,}:/.test(value))
    value = value.replace(/^[^@/]*@/, "").replace(":", "/");
  else value = path.resolve(dir, value);
  value = value.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash).toLowerCase() + value.slice(slash) : value;
};

/** `url.<base>.pushInsteadOf`/`insteadOf`: the longest matching prefix is rewritten. */
const rewrittenUrl = (url: string, config: GitConfig): string => {
  for (const kind of ["pushinsteadof", "insteadof"]) {
    let best: { base: string; prefix: string } | null = null;
    for (const [key, prefixes] of config) {
      if (!key.startsWith("url.") || !key.endsWith(`.${kind}`)) continue;
      const base = key.slice(4, -(kind.length + 1));
      for (const prefix of prefixes)
        if (url.startsWith(prefix) && prefix.length > (best?.prefix.length ?? -1))
          best = { base, prefix };
    }
    if (best) return best.base + url.slice(best.prefix.length);
  }
  return url;
};

/** Where a remote name or URL pushes, comparable across names and spellings. */
const pushUrl = (config: GitConfig, remote: string, dir: string): string => {
  const configured =
    configValue(config, `remote.${remote}.pushurl`) ?? configValue(config, `remote.${remote}.url`);
  return normalizedUrl(rewrittenUrl(configured ?? remote, config), dir);
};

/** The remote workit pushes to, from the same config `pushRemoteName` reads. */
const pushRemoteOf = (config: GitConfig, branch: string | null): string | null => {
  const remotes = new Set<string>();
  for (const key of config.keys()) {
    const name = /^remote\.(.+)\.url$/.exec(key)?.[1];
    if (name) remotes.add(name);
  }
  for (const candidate of [
    branch ? configValue(config, `branch.${branch}.pushremote`) : undefined,
    configValue(config, "remote.pushdefault"),
    branch ? configValue(config, `branch.${branch}.remote`) : undefined,
  ])
    if (candidate && candidate !== "." && remotes.has(candidate)) return candidate;
  if (remotes.has("origin")) return "origin";
  return remotes.size === 1 ? [...remotes][0] : null;
};

/**
 * A push names the remote workit itself pushes to: none (the default), its
 * name, or another name or URL that pushes to the same place (a second
 * remote, an insteadOf rewrite, the URL spelled out).
 */
const toPushRemote = (repo: Repo, remote: string | null, config: GitConfig): boolean => {
  // None, or one the shell computes (`"$(git remote get-url origin)"`): it may well be it.
  if (remote === null || /[$`]/.test(remote)) return true;
  // No known push remote: the named one may well be it.
  const pushRemote = pushRemoteOf(config, repo.branch);
  if (pushRemote === null || pushRemote === remote) return true;
  return pushUrl(config, remote, repo.dir) === pushUrl(config, pushRemote, repo.dir);
};

// ---------------------------------------------------------------------------
// pre-tool: refuse or nudge

const quote = (text: string) => `\`${text}\``;

const refusal = (action: RawAction, branch: string | null, dir?: string): string => {
  if (action.kind === "merge")
    return `workit: raw ${quote(action.via === "api" ? `${action.forge} api` : action.forge === "gh" ? "gh pr merge" : "glab mr merge")}${action.via === "api" ? " merge" : ""} bypasses the merge grant and the verdict gate. Run ${quote("workit pr merge")} instead (it checks both; ${quote("workit help pr")}).`;
  // Finishing a release (git-flow main/develop, the github-flow trunk, a
  // custom protected branch): the push has its own granted verb.
  const plainPush = action.kind === "push" && !action.blindForce && !action.deletes;
  if (dir && branch && plainPush && releaseBranch(dir, branch))
    return `workit: raw ${quote("git push")} onto ${branch}, a protected release branch, bypasses workit's protected-branch check. To finish a release or hotfix, push it with ${quote(`workit git push --release ${branch} [--release v<version>]`)}: it pushes ${branch} (fast-forward only) and the release tag, verifies the remote and records it, under the ${quote("release")} grant (if refused, ask the user to run ${quote("workit grant set <workspace> release=true")}). Feature work goes through ${quote("workit git push")} and ${quote("workit pr merge")}.`;
  return `workit: raw ${quote("git push")}${action.kind === "push" && action.blindForce ? " --force" : ""} onto ${branch}, a protected branch or the default target, bypasses workit's protected-branch check. Push your feature branch with ${quote("workit git push")} (${quote("workit git push --force-with-lease")} to rewrite it) and land it with ${quote("workit pr merge")}.`;
};

type PushAction = Extract<RawAction, { kind: "push" }>;

/** The local branches and tags, and the remote's branches as last fetched: one git call. */
type RefFacts = { heads: Set<string>; tags: Set<string>; remoteHeads: Set<string> };

const refFacts = (repo: Repo, remote: string): RefFacts => {
  const facts: RefFacts = { heads: new Set(), tags: new Set(), remoteHeads: new Set() };
  const listed = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", `refs/remotes/${remote}`],
    { cwd: repo.dir, encoding: "utf8", timeout: 5_000 },
  );
  const remotePrefix = `refs/remotes/${remote}/`;
  for (const ref of (listed.stdout ?? "").split("\n")) {
    if (ref.startsWith("refs/heads/")) facts.heads.add(ref.slice(11));
    else if (ref.startsWith("refs/tags/")) facts.tags.add(ref.slice(10));
    else if (ref.startsWith(remotePrefix)) facts.remoteHeads.add(ref.slice(remotePrefix.length));
  }
  return facts;
};

/**
 * The branches a glob refspec writes (`refs/heads/*:refs/heads/*`): every
 * local ref its source matches, mapped onto its destination.
 */
const globBranches = (repo: Repo, glob: { source: string; destination: string }): string[] => {
  const source = glob.source.startsWith("refs/") ? glob.source : `refs/heads/${glob.source}`;
  const [sourcePrefix, sourceSuffix = ""] = source.split("*");
  const [destinationPrefix, destinationSuffix = ""] = glob.destination.split("*");
  const listed = spawnSync(
    "git",
    [
      "for-each-ref",
      "--format=%(refname)",
      sourcePrefix.slice(0, sourcePrefix.lastIndexOf("/") + 1),
    ],
    { cwd: repo.dir, encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  const names: string[] = [];
  for (const ref of (listed.stdout ?? "").split("\n")) {
    if (!ref.startsWith(sourcePrefix) || !ref.endsWith(sourceSuffix)) continue;
    const middle = ref.slice(sourcePrefix.length, ref.length - sourceSuffix.length);
    const { name } = pushDestination(destinationPrefix + middle + destinationSuffix);
    if (name) names.push(name);
  }
  return names;
};

/**
 * The branches a push writes on the remote: its named refspecs, a glob's
 * matches, and, with no refspec, what `remote.<name>.push` or push.default
 * picks (`upstream` pushes onto the upstream's name, `matching` onto every
 * branch both sides have, `nothing` onto none). `null` is the current branch.
 */
const pushedBranches = (
  action: PushAction,
  repo: Repo,
  config: GitConfig,
  facts: RefFacts,
  remote: string,
): Array<string | null> => {
  const targets = action.implicit ? [] : [...action.targets];
  const globs = [...(action.globs ?? [])];
  let matching = action.matching === true;
  const configured = action.implicit ? config.get(`remote.${remote}.push`) : undefined;
  if (configured?.length) {
    const parsed = pushRefspecs(configured);
    targets.push(...parsed.targets);
    globs.push(...parsed.globs);
    matching ||= parsed.matching;
  } else if (action.implicit) {
    const mode = (configValue(config, "push.default") ?? "simple").toLowerCase();
    const merge = repo.branch ? configValue(config, `branch.${repo.branch}.merge`) : undefined;
    if (mode === "matching") matching = true;
    else if ((mode === "upstream" || mode === "tracking") && merge?.startsWith("refs/heads/"))
      targets.push(merge.slice(11));
    else if (mode !== "nothing") targets.push(null);
  }
  if (matching) for (const head of facts.heads) if (facts.remoteHeads.has(head)) targets.push(head);
  for (const glob of globs) targets.push(...globBranches(repo, glob));
  return targets;
};

/** A protected branch or the default target; `heads/<b>` reaches `refs/heads/<b>` on the remote. */
const guardedTarget = (dir: string, branch: string): string | null => {
  if (guardedBranch(dir, branch)) return branch;
  const bare = branch.startsWith("heads/") ? branch.slice(6) : null;
  return bare && guardedBranch(dir, bare) ? bare : null;
};

/** A bare refspec naming a local tag and no local branch pushes the tag. */
const isTag = (facts: RefFacts, name: string): boolean =>
  facts.tags.has(name) && !facts.heads.has(name);

/**
 * A raw tag push (`git push origin v1.0`, `refs/tags/v1.0`, `--tags`) skips
 * the release grant: denied with the workit command. `--follow-tags` only
 * nudges (it pushes annotated tags the pushed commits already reach).
 */
const tagRefusal = (action: PushAction, facts: RefFacts): string | null => {
  const tags = [
    ...(action.tags ?? []),
    ...action.targets.filter((name): name is string => name !== null && isTag(facts, name)),
  ];
  if (!tags.length && !action.allTags) return null;
  const named = tags.length ? tags.join(" --release ") : "v<version>";
  return `workit: raw ${quote(`git push${action.allTags ? " --tags" : ""}`)} of ${tags.length ? `tag ${tags.join(", ")}` : "tags"} bypasses the release grant. Push a release tag with ${quote(`workit git push --release ${named}`)} (v<version> tags whose commit the production branch already has; a tag never moves), under the ${quote("release")} grant (if refused, ask the user to run ${quote("workit grant set <workspace> release=true")}).`;
};

/** The remote already has the branch (ls-remote, bounded; unreachable answers yes: fail open). */
const remoteHas = (repo: Repo, remote: string, branch: string): boolean => {
  const listed = spawnSync("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
    cwd: repo.dir,
    encoding: "utf8",
    timeout: 3_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return listed.status !== 0 || (listed.stdout ?? "").trim() !== "";
};

/**
 * A branch name that would be new on the remote and that the workspace policy
 * does not allow, with the closest allowed name. An existing remote branch
 * (`dependabot/…`, a legacy name) is never judged: pushing it is not a new
 * name. `--all`/`--branches` expand to every local branch.
 */
const offPolicyPush = (action: PushAction, repo: Repo, facts: RefFacts, remote: string) => {
  const names = action.allBranches
    ? [...facts.heads]
    : action.targets.map((target) => target ?? repo.branch);
  for (const branch of names) {
    // A name the shell computes is not judged (like `git switch -c $B`).
    if (!branch || /[$`]/.test(branch)) continue;
    if (action.deleted?.includes(branch) || isTag(facts, branch)) continue;
    if (facts.remoteHeads.has(branch)) continue;
    const check = validateBranchNameFor(repo.dir, branch);
    if (check.ok || check.rule !== "allowed_pattern" || remoteHas(repo, remote, branch)) continue;
    return `workit: raw ${quote("git push")} onto ${branch}: ${check.error}`;
  }
  return null;
};

const nudgeFor = (action: RawAction, host: HookInput["host"], session: string): string | null => {
  switch (action.kind) {
    case "commit": {
      // Cursor's shell carries no conversation id: name it explicitly.
      const prefix = host === "cursor" && session ? `WORKIT_SESSION_ID=${session} ` : "";
      return action.amend
        ? `workit: raw ${quote("git commit --amend")} is recorded for this session; for new commits prefer ${quote(`${prefix}workit git commit -m '<msg>'`)} (adds the Workit-Session trailer and checks branch and commit policy).`
        : `workit: prefer ${quote(`${prefix}workit git commit -m '<msg>' [--all | -- <paths>]`)}: it adds the Workit-Session trailer and checks branch and commit policy.`;
    }
    case "push":
      return action.blindForce
        ? `workit: ${quote("git push --force")} overwrites without a lease; use ${quote("workit git push --force-with-lease")}.`
        : `workit: prefer ${quote("workit git push")}: it refuses protected branches and verifies the remote tip.`;
    case "pr-create":
      return `workit: prefer ${quote("workit pr create --fill")} (or --title/--body): it records the PR the merge gate checks.`;
    case "pr-read":
      return `workit: ${quote("workit pr status")} shows the PR, its checks and the verdict state; ${quote("workit ci wait")} waits for checks.`;
    case "merge":
      return null;
  }
};

/**
 * Why a raw push to workit's push remote is refused, or null: `--mirror`,
 * a protected branch or the default target, a tag, or a new off-policy name.
 */
const pushRefusal = (action: PushAction, repo: Repo, config: GitConfig): string | null => {
  if (!toPushRemote(repo, action.remote, config)) return null;
  if (action.mirror)
    return `workit: raw ${quote("git push --mirror")} rewrites and deletes every remote ref, protected branches and tags included. Push one branch with ${quote("workit git push")}.`;
  const remote = action.remote ?? pushRemoteOf(config, repo.branch) ?? "origin";
  const facts = refFacts(repo, remote);
  const targets = pushedBranches(action, repo, config, facts, remote);
  for (const target of targets) {
    const guarded = guardedTarget(repo.dir, target ?? repo.branch ?? "");
    if (guarded) return refusal(action, guarded, repo.dir);
  }
  const pushed = { ...action, targets };
  return (
    tagRefusal(pushed, facts) ??
    (action.deletes ? null : offPolicyPush(pushed, repo, facts, remote))
  );
};

type Located = { action: RawAction; repo: Repo; invocation: RawInvocation };

/**
 * Raw invocations with a meaning, each with its Workit repository. A git
 * subcommand that is not one of git's own is resolved as an alias first
 * (inside a Workit workspace only: that costs one config read).
 */
const actionsIn = (
  cwd: string,
  command: string,
  dialect: ShellDialect,
  cache: ConfigCache = new Map(),
): Located[] => {
  const out: Located[] = [];
  const repos = new Map<string, Repo | null>();
  const repoFor = (relative: string | null): Repo | null => {
    const dir = path.resolve(cwd, relative ?? ".");
    if (!repos.has(dir)) {
      const repo = repoAt(dir);
      repos.set(dir, repo && isWorkitWorkspace(repo) ? repo : null);
    }
    return repos.get(dir) ?? null;
  };
  for (const raw of rawInvocations(command, dialect)) {
    if (raw.dir === undefined) continue;
    const known = raw.tool !== "git" || GIT_COMMANDS.has(raw.args[0] ?? "");
    if (!known && !repoFor(raw.dir)) continue;
    for (const invocation of known ? [raw] : expandGitAliases(cwd, raw, cache)) {
      if (invocation.dir === undefined) continue;
      const action = rawAction(invocation);
      const repo = action ? repoFor(invocation.dir) : null;
      if (action && repo) out.push({ action, repo, invocation });
    }
  }
  return out;
};

/** Is `dir` in a repository Workit manages? */
export const inWorkitWorkspace = (dir: string): boolean => {
  const repo = repoAt(dir);
  return repo !== null && isWorkitWorkspace(repo);
};

/** A raw push, PR/MR create or merge in a Workit workspace (help and dry runs excluded). */
export const rawDelivery = (cwd: string, command: string, dialect: ShellDialect): boolean =>
  mentionsRawTool(command) &&
  actionsIn(cwd, command, dialect).some(
    ({ action }) => action.kind !== "commit" && action.kind !== "pr-read",
  );

/** Cheap pre-filter: no git/gh/glab word, nothing to do. */
const mentionsRawTool = (command: string) => /\b(?:git|gh|glab)\b/i.test(command);

const dialectOf = (input: HookInput): ShellDialect =>
  (input.event.kind === "shell.pre" || input.event.kind === "shell.post"
    ? input.event.dialect
    : undefined) ?? "posix";

/** The nudge kind an action shows: each is shown once per session (agent). */
const nudgeKind = (action: RawAction): string =>
  action.kind === "commit" && action.amend
    ? "commit-amend"
    : action.kind === "push" && action.blindForce
      ? "push-force"
      : action.kind;

/**
 * The nudges a session (or one of its subagents) has not been shown yet,
 * recorded as shown in the per-session marker. Without a session or a
 * marker, every nudge shows: the throttle fails open to repeating.
 */
const unseenNudges = (input: HookInput, nudges: Map<string, string>, store: string): string[] => {
  const session = input.session.id;
  const file = session ? sessionMarkerFile(input, session, store) : null;
  if (!file) return [...nudges.values()];
  const marker = readSessionMarker(file);
  const agent = input.session.agentId ? `${input.session.agentId}:` : "";
  const fresh = [...nudges.keys()].filter((kind) => !marker.raw.includes(agent + kind));
  if (fresh.length)
    writeSessionMarker(file, {
      ...marker,
      raw: [...marker.raw, ...fresh.map((kind) => agent + kind)],
    });
  return fresh.map((kind) => nudges.get(kind) as string);
};

/**
 * The pre-tool decision for a shell command: deny a gate bypass inside a
 * Workit workspace, else a nudge (as context) for routine raw delivery
 * commands, else nothing. Each nudge kind is shown once per session, and a
 * command that runs a workit verb itself gets none (denies still apply).
 * `nudge: false` asks for the deny alone and spends no nudge. Never throws.
 */
export function rawGitPre(
  input: HookInput,
  command: string,
  options: { nudge?: boolean } = {},
): HookDecision {
  try {
    // No textual pre-filter: quoting, escapes and encoded scripts hide the
    // tool's name from one (`g''it`, `pwsh -EncodedCommand`).
    const dialect = dialectOf(input);
    const nudges = new Map<string, string>();
    let store: string | null = null;
    const cache: ConfigCache = new Map();
    for (const { action, repo, invocation } of actionsIn(input.cwd, command, dialect, cache)) {
      store ??= repo.location.dir;
      if (action.kind === "merge") return deny(refusal(action, null));
      if (action.kind === "push") {
        const refused = pushRefusal(action, repo, gitConfig(repo.dir, invocation, cache));
        if (refused) return deny(refused);
      }
      const nudge = nudgeFor(action, input.host, input.session.id);
      if (nudge && !nudges.has(nudgeKind(action))) nudges.set(nudgeKind(action), nudge);
    }
    if (options.nudge === false || !store || nudges.size === 0) return NONE;
    if (workitInvocations(command, dialect).length > 0) return NONE;
    const shown = unseenNudges(input, nudges, store);
    return shown.length ? { kind: "context", text: shown.join("\n") } : NONE;
  } catch {
    return NONE;
  }
}

const deny = (reason: string): HookDecision => ({ kind: "deny", reason, unblock: null });

// ---------------------------------------------------------------------------
// recording raw commits (B2)

/** The marker key for a shell call that has no post-tool event (Cursor). */
export const NEXT_COMMAND = "next";
/** A marker older than this is a command that never reported back. */
const MARKER_TTL_SECONDS = 3_600;

type Marker = { head: string | null; at: number };

const markerFile = (repo: Repo, session: string, key: string) =>
  path.join(
    repo.location.dir,
    "hooks",
    `commit-${createHash("sha256").update(`${session}\0${key}`).digest("hex").slice(0, 32)}.json`,
  );

/** The marker key of one shell call: its tool-use id, else the command. */
export const callKey = (toolUseId: string | null, command: string): string =>
  toolUseId ?? `cmd:${createHash("sha256").update(command).digest("hex")}`;

/**
 * Before a shell call that runs a raw `git commit` in a Workit workspace:
 * note HEAD and the time in that repository's store, under the session and
 * `key`. Never throws.
 */
export function noteRawCommit(input: HookInput, command: string, key: string): void {
  try {
    if (!input.session.id || !/\bcommit\b/.test(command)) return;
    const at = Math.floor(Date.now() / 1000);
    for (const { action, repo } of actionsIn(input.cwd, command, dialectOf(input))) {
      if (action.kind !== "commit") continue;
      const file = markerFile(repo, input.session.id, key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ head: headSha(repo), at } satisfies Marker)}\n`);
    }
  } catch {
    // Fail open: a missing marker only loses this record.
  }
}

type HeadCommit = { sha: string; committed: number; subject: string; trailer: string | null };

const headCommit = (dir: string): HeadCommit | null => {
  const run = spawnSync(
    "git",
    [
      "log",
      "-1",
      "--format=%H%x1f%ct%x1f%s%x1f%(trailers:key=Workit-Session,valueonly,separator=%x2c)",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    },
  );
  const [sha, committed, subject = "", trailer = ""] = (
    run.status === 0 ? run.stdout.trim() : ""
  ).split("\x1f");
  return sha && /^[0-9a-f]{40,64}$/.test(sha)
    ? { sha, committed: Number(committed), subject, trailer: trailer.trim() || null }
    : null;
};

/**
 * Settle one marker: record HEAD for the session when HEAD moved away from
 * the noted commit, the new commit was made at or after the note, and no
 * other session claims it (a ledger row or a Workit-Session trailer).
 */
const settle = (input: HookInput, repo: Repo, file: string): void => {
  let marker: Marker;
  try {
    marker = JSON.parse(fs.readFileSync(file, "utf8")) as Marker;
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
  const session = input.session.id;
  const now = Date.now() / 1000;
  if (typeof marker.at !== "number" || now - marker.at > MARKER_TTL_SECONDS) return;
  if (!session || !repo.branch) return;
  const head = headCommit(repo.dir);
  if (!head || head.sha === marker.head || head.committed < marker.at) return;
  if (head.trailer && head.trailer !== session) return;
  const ledger = readLedger(repo.dir);
  if (!ledger.ok) return;
  const claimed = ledger.value.rows.some(
    (row) => row.type === "commit.recorded" && (row.sha === head.sha || row.head === head.sha),
  );
  if (claimed) return;
  appendHookObserved(repo.dir, {
    type: "commit.recorded",
    actor: { host: input.host, session, agentId: input.session.agentId },
    branch: repo.branch,
    head: head.sha,
    sha: head.sha,
    session,
    agentId: input.session.agentId,
    subject: head.subject.slice(0, 200),
    files: [],
    fileCount: null,
    via: "raw_shell",
  });
};

/** Post-tool: a raw `git commit` the pre-tool hook noted is recorded for the session. */
export function rawGitPost(input: HookInput, command: string, key: string): void {
  try {
    if (!input.session.id || !/\bcommit\b/.test(command)) return;
    for (const { action, repo } of actionsIn(input.cwd, command, dialectOf(input)))
      if (action.kind === "commit") settle(input, repo, markerFile(repo, input.session.id, key));
  } catch {
    // Fail open: a lost record only weakens author detection.
  }
}

/**
 * A host without a post-tool event: the session's previous raw commit in
 * the checkout it works in is settled on its next shell command (one stat
 * when nothing is pending). A commit made in another repository through
 * `cd`/`-C` is settled only when a later command runs there.
 */
export function settlePendingCommit(input: HookInput): void {
  try {
    if (!input.session.id) return;
    const repo = repoAt(input.cwd);
    if (!repo) return;
    const file = markerFile(repo, input.session.id, NEXT_COMMAND);
    if (fs.existsSync(file)) settle(input, repo, file);
  } catch {
    // Fail open.
  }
}
