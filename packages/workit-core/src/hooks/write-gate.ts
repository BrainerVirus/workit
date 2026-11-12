// The before-write gate (S17). With no writer lease, a branch task's unmet
// before-write requirements (an open product choice, a missing plan) deny
// working-tree edits where the host has a pre-write hook, naming the exact
// unblock. History moves (commit, merge, rebase, stash pop) are not edits.
// Reads only the task index, one task snapshot and the ledger; never
// migrates, never captures a candidate, and fails open on any state error.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSignature, TaskReader } from "../core/task-read";
import { latestJudgment, writeBlockers, type WriteBlocker } from "../core/policy/derive";
import { applicableDecision } from "../core/task-evaluation";
import {
  claimLiveSession,
  liveConflict,
  type LiveConflict,
  type LiveDeps,
  type LiveOwner,
} from "../core/live-session";
import { grantsDir } from "../autonomy";
import { resolveConfigDir } from "../core/config";
import { resolveStateDir } from "../core/logger";
import { workspaceLiveSessionGuard } from "../core/workspaces";
import { appendHookObserved, ledgerPath } from "../ledger";
import type { HookDecision } from "./protocol";
import {
  inWorkitWorkspace,
  rawInvocations,
  workitCheckTail,
  skipWorkitGlobals,
  workitInvocations,
  type RawInvocation,
} from "./raw-git";
import { segmentsOf, type Segment, type ShellDialect } from "./shell-words";

const NONE: HookDecision = { kind: "none" };

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * The real path of `file`: the nearest existing ancestor resolved through
 * symlinks (macOS /var → /private/var), then the not-yet-existing rest.
 */
const canonical = (file: string): string => {
  let rest = "";
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
    try {
      // Native resolution also expands Windows 8.3 short names (RUNNER~1).
      return path.join(realpathSync.native(dir), rest);
    } catch {
      if (path.dirname(dir) === dir) return path.resolve(file);
      rest = rest ? path.join(path.basename(dir), rest) : path.basename(dir);
    }
  }
};

/**
 * Writes the gate never blocks: files outside the checkout (e.g. /tmp),
 * Markdown (*.md, *.mdx), the top-level `docs/` tree, any `plans/` directory,
 * and the plan files the task's judgment cites.
 */
const exempt = (cwd: string, root: string, file: string, plans: ReadonlySet<string>): boolean => {
  const fold = (value: string) => (CASE_INSENSITIVE ? value.toLowerCase() : value);
  const relative = path.relative(fold(canonical(root)), fold(canonical(path.resolve(cwd, file))));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  return (
    /\.mdx?$/i.test(posix) ||
    segments[0] === "docs" ||
    segments.includes("plans") ||
    [...plans].some((plan) => fold(plan) === posix)
  );
};

const PREFIXES = new Set(["sudo", "command", "env", "nohup", "time", "exec", "xargs", "busybox"]);
const operands = (words: string[]) => words.filter((item) => !item.startsWith("-"));

const SCRIPT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * The script `workit check … -- <cmd>` runs, so the gates judge it as if it
 * ran raw: the `--shell` string, a `bash -c` script, or the argv. Other
 * workit verbs stay exempt (null).
 */
const wrappedScript = (input: string[]): string | null => {
  let words = input;
  while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words = words.slice(1);
  const tail = workitCheckTail(words);
  if (!tail) return null;
  if ("script" in tail) return tail.script;
  const script = shellScript(tail.argv);
  if (SCRIPT_SHELLS.has((tail.argv[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase()) && script)
    return script;
  return tail.argv.map(quoteWord).join(" ");
};

/** The files one simple command edits: [] none, null unknown. */
const editsOf = (input: string[]): string[] | null => {
  let words = input;
  while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) words = words.slice(1);
  const [verb, ...args] = words;
  const name = (verb?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  if (!name || name === "workit" || (name === "npx" && args.some((item) => /workit/.test(item))))
    return [];
  switch (name) {
    case "touch":
    case "mkdir":
    case "rm":
    case "rmdir":
    case "tee":
    case "mv":
    case "truncate":
      return operands(args);
    case "cp":
    case "ln":
    case "install": {
      // `-t D`, `-tD`, `--target-directory[=]D`.
      const into = valueOf(args, /^(?:-t|--target-directory=?)(.*)$/s);
      if (into !== undefined) return [into];
      const last = operands(args).at(-1);
      return last ? [last] : null;
    }
    case "dd":
      return args.filter((item) => item.startsWith("of=")).map((item) => item.slice(3));
    case "sed":
    case "perl": {
      if (!args.some((item) => /^-[a-zA-Z]*i|^--in-place/.test(item))) return [];
      const scripted = args.some((item) => item === "-e" || item === "-f");
      const files: string[] = [];
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "-e" || args[index] === "-f") index++;
        else if (!args[index].startsWith("-")) files.push(args[index]);
      }
      return scripted ? files : files.slice(1);
    }
    case "patch":
      return null;
    // PowerShell (Claude Code's PowerShell tool): the path parameter, else the first operand.
    case "set-content":
    case "add-content":
    case "out-file":
    case "new-item":
    case "ni":
    case "remove-item":
    case "del":
    case "copy-item":
    case "move-item": {
      const flag = args.findIndex((item) =>
        /^-(?:path|filepath|literalpath|destination)$/i.test(item),
      );
      if (flag >= 0) return args[flag + 1] ? [args[flag + 1]] : null;
      const files = operands(args);
      if (name === "move-item") return files.length ? files : null;
      const file = name === "copy-item" ? files.at(-1) : files[0];
      return file ? [file] : null;
    }
    case "git": {
      const sub = operands(args)[0];
      if (sub === "apply") return null;
      if (sub === "restore" || sub === "mv" || sub === "rm") return operands(args).slice(1);
      if (sub === "checkout" && args.includes("--")) return args.slice(args.indexOf("--") + 1);
      // commit, merge, rebase, stash, cherry-pick… move history, not edits.
      return [];
    }
    default:
      return [];
  }
};

/** Wrappers that run their operand as the command, with the option letters that take a value. */
const WRAPPERS: Record<string, string> = {
  sudo: "ugCDhpRrTtU",
  doas: "uC",
  env: "uCS",
  nice: "n",
  ionice: "cnp",
  timeout: "sk",
  stdbuf: "ioe",
  time: "fo",
  nohup: "",
  command: "",
  exec: "a",
  setsid: "",
  builtin: "",
  "!": "",
  // `npx tsx x.ts`: the package's binary runs the script.
  npx: "p",
  bunx: "p",
};

const INTERPRETERS = /^(?:python[\d.]*|node|bun|deno|ruby|perl|php|tsx|ts-node)$/;

/** Whether `file` is a config dir itself. */
const isConfigDir = (file: string): boolean =>
  configDirs().some((dir) => canonical(dir) === canonical(file));

/** Whether `file` is a config dir or a state registry root (`<state>/issued*`, `<state>/approvals`). */
const isRoot = (file: string): boolean =>
  isConfigDir(file) ||
  /^(?:issued[^\\/]*|approvals)$/.test(
    path.relative(canonical(resolveStateDir()), canonical(file)),
  );

/** Calls that only read or print what they are given. */
const READ_CALLS =
  /^(?:print|log|info|warn|error|debug|puts|readdir(?:Sync)?|listdir|scandir|iterdir|glob|l?stat(?:Sync)?|exists(?:Sync)?|isdir|isfile|is_dir|is_file|access(?:Sync)?|realpath(?:Sync)?|dirname|basename|relative|str|repr|len)$/;
/** Calls that change files (Python, Node, Ruby, PHP names), for a path value that may reach one. */
const MUTATING_CALLS =
  /^(?:renames?(?:Sync)?|move|copy(?:2|file|tree|File)?(?:Sync)?|cp(?:Sync)?|rm(?:tree|dir|Sync|dirSync)?|unlink(?:Sync)?|remove(?:dirs)?|mkdirs?(?:Sync)?|makedirs|mkdtemp(?:Sync)?|(?:sym|hard)?link(?:Sync|_to)?|write\w*|append\w*|truncate(?:Sync)?|ch(?:mod|own)(?:Sync)?|touch|open(?:Sync)?|dump|save|extractall|unpack_archive|put_contents|mv|FileUtils)$/;
/** Calls that only build a path: the value they return may reach any later call. */
const PATH_CALLS =
  /^(?:join|resolve|normalize|abspath|expanduser|expandvars|Path|PurePath|fspath)$/;

/**
 * Code that takes a guarded dir (a config dir, a registry root) only to read
 * or name it, at `at`: the call around it is a known reader, or it only builds
 * a path (or is assigned) in code with no call that may change files. Any
 * other call around it, recognised or not, counts as a write.
 */
const readsRoot = (text: string, at: number): boolean => {
  let call: string | undefined;
  for (let index = at, depth = 0; index > 0 && call === undefined; index--) {
    const char = text[index - 1];
    if (char === ")") depth++;
    else if (char === "(" && depth-- === 0)
      call = /([\w$]+)\s*$/.exec(text.slice(0, index - 1))?.[1] ?? "";
    else if (depth <= 0 && /[;\n]/.test(char)) break;
  }
  if (call !== undefined && READ_CALLS.test(call)) return true;
  if (call !== undefined && !PATH_CALLS.test(call)) return false;
  return ![...text.matchAll(/([\w$]+)\s*\(/g)].some(([, name]) => MUTATING_CALLS.test(name));
};

/**
 * An editor command that cannot write: every `|`-separated part is `set`,
 * `syntax`, `colorscheme`, a bare search or a line number.
 */
const inertEdit = (command: string): boolean =>
  command
    .split("|")
    .every((part) =>
      /^:?(?:se(?:t)?|sy(?:ntax)?|colo(?:rscheme)?)(?:\s|$)|^[/?][^/?]*[/?]?$|^\d+$/.test(
        part.trim(),
      ),
    );

/** Options that take a value, by interpreter (the shape of WRAPPERS); a preload option's value runs too. */
const SCRIPT_OPTIONS: Array<[RegExp, RegExp]> = [
  [/^(?:(?:ba|z|k|da)?sh|source|\.)$/, /^(?:[-+][oO]|--(?:rcfile|init-file))$/],
  [/^python/, /^-[WXQ]$/],
  [
    /./,
    /^(?:-[rCI]|--(?:require|import|(?:experimental-)?loader|preload|input-type|conditions|title|cwd|tsconfig|project|env-file|config))$/,
  ],
];
const PRELOAD = /^(?:-r|--(?:require|import|(?:experimental-)?loader|preload|rcfile|init-file))$/;

/**
 * The script operand of a shell or interpreter, past options and their
 * values (none after `-m`, `-c`, `-e`), and the modules its preload options run.
 */
const scriptArgs = (
  verb: string,
  args: readonly string[],
): { named?: string; preloads: string[] } => {
  const takes = SCRIPT_OPTIONS.find(([family]) => family.test(verb))?.[1] ?? /^$/;
  const preloads: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const [option, value] = args[at].split(/=(.*)/s);
    if (value !== undefined && PRELOAD.test(option)) preloads.push(value);
    else if (/^-[mce]$|^--(?:eval|print)$/.test(option)) break;
    else if (takes.test(option)) {
      if (PRELOAD.test(option)) preloads.push(args[at + 1] ?? "");
      at++;
    } else if (!/^[-+]/.test(option) && option !== "run") return { named: args[at], preloads };
  }
  return { preloads };
};

/** The command a wrapper runs, past its options, values, assignments and a leading number; null with no wrapper. */
const unwrapped = (words: readonly string[]): string[] | null => {
  let at = 0;
  for (
    let takes: string | undefined;
    (takes = WRAPPERS[words[at]?.split(/[\\/]/).at(-1) ?? ""]) !== undefined;
  ) {
    at++;
    while (at < words.length && /^-|^\w+=|^\d[\w.]*$/.test(words[at]))
      at += words[at].length === 2 && words[at][0] === "-" && takes.includes(words[at][1]) ? 2 : 1;
  }
  return at ? words.slice(at) : null;
};

/** A `bash -c '<script>'` (any SCRIPT_SHELLS) script, else null. */
const shellScript = (words: readonly string[]): string | null => {
  if (!SCRIPT_SHELLS.has((words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase())) return null;
  // Options may come before `-c` (`bash --norc -c`, `sh -e -c`); the script follows it.
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (/^-[a-z]*c[a-z]*$/.test(word)) return words[index + 1] ?? null;
    if (/^[-+][oO]$/.test(word)) index++;
    else if (!/^[-+]/.test(word)) return null;
  }
  return null;
};

/** xargs options that take the next word as their value. */
const XARGS_VALUE = /^-[IinLPdsEa]$/;

/** The command `xargs` (or `find -exec`) runs with `{}` filled in by a path. */
const runsWriter = (words: readonly string[]): boolean => {
  const filled = [...words.filter((word) => word !== "{}" && word !== ";" && word !== "+"), "x"];
  const edits = editsOf(filled);
  return edits === null || edits.length > 0 || opaqueWrites(filled) !== null;
};

/**
 * For an implementer's confinement: commands that may write where the edit
 * analysis cannot see (interpreters, chmod, rsync, `find -delete`, `xargs rm`,
 * `awk -i`, a `-c` shell script): the paths they may change, "." standing for
 * the directory they run in; null when the command is none of them.
 */
const opaqueWrites = (
  input: readonly string[],
  scriptOf: (index: number) => string | undefined = (index) => input[index],
): string[] | null => {
  let words = input;
  while (words.length && (PREFIXES.has(words[0]) || /^\w+=/.test(words[0]))) {
    if (words[0] === "xargs") {
      let at = 1;
      while (words[at]?.startsWith("-")) at += XARGS_VALUE.test(words[at]) ? 2 : 1;
      return runsWriter(words.slice(at)) ? ["."] : null;
    }
    words = words.slice(1);
  }
  const [verb, ...args] = words;
  const name = (verb?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  const files = operands(args);
  const has = (pattern: RegExp) => args.some((arg) => pattern.test(arg));
  const listed = (named: string[]) => (named.length ? named : ["."]);
  if (name === "unlink" || name === "shred" || name === "mkfifo") return listed(files);
  if (name === "wget") return wgetOutputs(args);
  if (name === "tar") return tarOutputs(args);
  if (name === "unzip")
    return has(/^-[a-zA-Z]*[lptvzZ]/)
      ? null
      : listed(
          args.flatMap((arg, at) =>
            arg.startsWith("-d") ? [arg.slice(2) || args[at + 1] || "."] : [],
          ),
        );
  if (name === "git") return gitOutputs(args);
  // The mode or owner comes first, unless `--reference` names it.
  if (/^(?:chmod|chown|chgrp|chattr)$/.test(name))
    return listed(has(/^--reference/) ? files : files.slice(1));
  if (name === "rsync") {
    const dest = files.at(-1);
    // `host:path` is remote; a drive letter (`C:/…`, `C:\…`) is a local path.
    const remote = /^[\w.@-]*:/.test(dest ?? "") && !/^[A-Za-z]:[\\/]/.test(dest ?? "");
    return dest === undefined ? ["."] : remote ? [] : [dest];
  }
  if (name === "find") {
    const exec = args.findIndex((arg) => /^-(?:exec|execdir|ok|okdir)$/.test(arg));
    const writes =
      has(/^-(?:delete|fprint\w*|fls)$/) || (exec >= 0 && runsWriter(args.slice(exec + 1)));
    const end = args.findIndex((arg) => /^[-(!]/.test(arg));
    return writes ? listed(end < 0 ? args : args.slice(0, end)) : null;
  }
  if (/^g?awk$/.test(name)) {
    if (!has(/^-i|^--include/)) return null;
    const named: string[] = [];
    let program = !has(/^-f$|^--file/);
    for (let index = 0; index < args.length; index++)
      if (/^(?:-[ifvF]|--(?:include|file|assign|field-separator))$/.test(args[index])) index++;
      else if (args[index].startsWith("-")) continue;
      else if (program) program = false;
      else named.push(args[index]);
    return listed(named);
  }
  const inline = (flag: RegExp): string[] | null => {
    const at = args.findIndex((arg) => flag.test(arg));
    if (at < 0) return null;
    const runs = input.length - args.length - 1;
    // The script, the interpreter's options and arguments, and the environment
    // it is given (`X=/p node -e …`, `NODE_OPTIONS=--require …`).
    return [
      ".",
      ...input.flatMap((word, index) => {
        if (index === runs || (index < runs && !/^\w+=/.test(word))) return [];
        const text = scriptOf(index);
        return text === undefined ? [unknownVarTarget(word)] : pathsIn(text);
      }),
    ];
  };
  if (name === "curl") return curlOutputs(args);
  if (name === "perl") return inline(/^-[a-zA-Z]*[eE]$/);
  if (/^(?:python[\d.]*|node|bun|deno|ruby|php)$/.test(name))
    return inline(/^-[a-zA-Z]*[ce]$|^--eval$|^-p$/);
  return shellScript(words) === null ? null : ["."];
};

// curl's long options that name a file it writes, matched by any prefix curl
// accepts (`--dump-h`); `--output-dir` is where `-o` and `-O` save, `-K` and
// `-w @file` read options Workit cannot see. `--cookie` itself only reads.
const CURL_LONG = [
  "output",
  "output-dir",
  "cookie-jar",
  "dump-header",
  "trace",
  "trace-ascii",
  "stderr",
  "libcurl",
  "hsts",
  "alt-svc",
  "etag-save",
  "config",
  "write-out",
  "remote-name",
  "remote-name-all",
];
const CURL_SHORT_LONG: Record<string, string> = {
  o: "output",
  c: "cookie-jar",
  D: "dump-header",
  K: "config",
  w: "write-out",
};
// Short options that take a value (the rest of the word, else the next word).
const CURL_SHORT = /^-([^-AbcCdDeEFHKmoPQrtTuUwxXyYz]*)(?:([AbcCdDeEFHKmoPQrtTuUwxXyYz])(.*))?$/s;

/**
 * The files `curl` writes (`-o` under `--output-dir`, `-c`, `-D`, traces, state
 * files, `-w '%output{…}'`), the directory `-O` saves in ("." where it runs),
 * and an unresolvable target for options read from a file; null when it only prints.
 */
const curlOutputs = (args: readonly string[]): string[] | null => {
  const files: string[] = [];
  const named: string[] = [];
  const dirs: string[] = [];
  let remote = false;
  for (let index = 0; index < args.length; index++) {
    const long = /^--([\w.-]+)(?:=(.*))?$/s.exec(args[index]);
    const short = long ? null : CURL_SHORT.exec(args[index]);
    if (short?.[1].includes("O")) remote = true;
    const option = long
      ? long[1] === "cookie"
        ? undefined
        : (CURL_LONG.find((name) => name === long[1]) ??
          CURL_LONG.find((name) => name.startsWith(long[1])))
      : CURL_SHORT_LONG[short?.[2] ?? ""];
    if (option?.startsWith("remote-name")) remote = true;
    if (option === undefined || option.startsWith("remote-name")) {
      if (short?.[2] && !short[3]) index++;
      continue;
    }
    const value = (long ? long[2] : short?.[3]) || args[++index];
    if (option === "config" || (option === "write-out" && value?.startsWith("@")))
      files.push(unknownVarTarget(`curl ${option === "config" ? "-K <config>" : "-w @<format>"}`));
    else if (value === undefined || value === "-") continue;
    else if (option === "output") named.push(value);
    else if (option === "output-dir") dirs.push(value);
    else if (option === "write-out")
      for (const match of value.matchAll(/%output\{(?:>>)?([^}]*)\}/g)) files.push(match[1]);
    else files.push(value);
  }
  for (const name of named) {
    // A relative name saves under `--output-dir`; an absolute one may too.
    if (dirs.length === 0 || /^[/~$]|^[A-Za-z]:[\\/]/.test(name)) files.push(name);
    files.push(...dirs.map((dir) => `${dir}/${name}`));
  }
  if (remote) files.push(...(dirs.length ? dirs : ["."]));
  return files.length > 0 ? files : null;
};

/** The value of the first option matching `option` (`-oX`, `-o X`, `--opt=X`, `--opt X`). */
const valueOf = (args: readonly string[], option: RegExp): string | undefined => {
  const at = args.findIndex((arg) => option.test(arg));
  return at < 0 ? undefined : option.exec(args[at])?.[1] || args[at + 1];
};

/** `wget`'s `-O` (not `-`) and log files, else the directory it saves in (`-P`, "."). */
const wgetOutputs = (args: readonly string[]): string[] => {
  const named = valueOf(args, /^(?:-[a-zA-Z]*O|--output-document=?)(.*)$/s);
  const logs = [/^-[a-zA-Z]*[oa](.*)$/s, /^--(?:output-file|append-output)=?(.*)$/s].flatMap(
    (option) => valueOf(args, option) ?? [],
  );
  if (named === undefined)
    return [...logs, valueOf(args, /^(?:-[a-zA-Z]*P|--directory-prefix=?)(.*)$/s) ?? "."];
  return named === "-" ? logs : [...logs, named];
};

/** `tar`: where it extracts (`-C`, else "."), the archive it creates or changes (`-f`); null to list. */
const tarOutputs = (args: readonly string[]): string[] | null => {
  // Old-style letters (`tar xzf a.tgz`) or short options (`-xzf`); `-C` takes a directory.
  const letters = args
    .filter((arg, at) => (at === 0 && !arg.startsWith("-")) || /^-[a-zA-Z]+$/.test(arg))
    .join("")
    .replaceAll("C", "");
  const long = (pattern: RegExp) => args.some((arg) => pattern.test(arg));
  const extract = /x/.test(letters) || long(/^--(?:extract|get)$/);
  const creates = /[cruA]/.test(letters) || long(/^--(?:create|append|update|concatenate|delete)$/);
  if (!extract && !creates) return null;
  const files: string[] = [];
  if (extract) {
    const dirs = args.flatMap((arg, at) =>
      /^-C|^--directory(?:=|$)/.test(arg)
        ? [arg.replace(/^-C|^--directory=?/, "") || args[at + 1] || "."]
        : [],
    );
    files.push(...(dirs.length ? dirs : ["."]));
  }
  const old = args[0] !== undefined && !args[0].startsWith("-") && args[0].includes("f");
  const archive = old ? args[1] : valueOf(args, /^(?:-[a-zA-Z]*f|--file=?)(.*)$/s);
  if (creates && archive !== undefined && archive !== "-") files.push(archive);
  return files;
};

const CONFIG_READ = /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|get|list)$/;
const CONFIG_WRITE =
  /^(?:--(?:unset(?:-all)?|add|replace-all|rename-section|remove-section|edit)|-e|set|unset|rename-section|remove-section|edit)$/;
const CONFIG_VALUE = /^(?:--file|-f|--blob|--type|--default|--comment)$/;

/** Whether `git config <rest>` writes (rather than reads) a value. */
export const configWrites = (rest: readonly string[]): boolean => {
  if (rest.some((arg) => CONFIG_READ.test(arg))) return false;
  if (rest.some((arg) => CONFIG_WRITE.test(arg))) return true;
  let named = 0;
  for (let index = 0; index < rest.length; index++)
    if (CONFIG_VALUE.test(rest[index])) index++;
    else if (!rest[index].startsWith("-")) named++;
  return named > 1;
};

/** git options before the subcommand, and `git clone|init` options, that take the next word. */
const GIT_VALUE =
  /^(?:-[Ccbouj]|--(?:git-dir|work-tree|namespace|config-env|branch|origin|config|depth|reference(?:-if-able)?|template|separate-git-dir|upload-pack|jobs|filter|initial-branch|object-format))$/;

/**
 * What git writes outside the edit analysis (#790): `init` and `clone` their
 * directory, `format-patch` its patches, `archive -o`, `bundle create`, any
 * `--output`, a `config` write its file, and `fetch`, `gc` and `branch`
 * writes the repository ("."); paths are under `-C`. Null for the rest.
 */
const gitOutputs = (args: readonly string[]): string[] | null => {
  let at = 0;
  let base: string | undefined;
  for (; args[at]?.startsWith("-"); at += GIT_VALUE.test(args[at]) ? 2 : 1)
    if (args[at] === "-C") base = args[at + 1];
  const [sub = "", ...rest] = args.slice(at);
  if (rest.some((arg) => arg === "--help" || arg === "-h")) return null;
  const names = rest.filter(
    (arg, index) => !arg.startsWith("-") && !GIT_VALUE.test(rest[index - 1] ?? ""),
  );
  const has = (pattern: RegExp) => rest.some((arg) => pattern.test(arg));
  const files: string[] = [];
  const output = valueOf(
    rest,
    sub === "archive" ? /^(?:-o|--output=?)(.*)$/s : /^--output=?(.*)$/s,
  );
  if (output !== undefined) files.push(output);
  if (sub === "init") files.push(names[0] ?? ".");
  if (sub === "clone")
    files.push(
      names[1] ??
        names[0]
          ?.replace(/(?:\.git)?[\\/]*$/, "")
          .split(/[\\/:]/)
          .at(-1) ??
        ".",
    );
  if (sub === "format-patch" && !has(/^--stdout$/))
    files.push(valueOf(rest, /^(?:-o|--output-directory=?)(.*)$/s) ?? ".");
  if (sub === "bundle" && names[0] === "create" && names[1]) files.push(names[1]);
  if (sub === "config" && configWrites(rest))
    files.push(
      has(/^--global$/)
        ? "~/.gitconfig"
        : has(/^--system$/)
          ? "/etc/gitconfig"
          : (valueOf(rest, /^(?:-f|--file=?)(.*)$/s) ?? "."),
    );
  const branchWrite =
    has(/^-[a-zA-Z]*[dDfmMcCu]|^--(?:delete|force|move|copy|set-upstream|unset-upstream|edit)/) ||
    (names.length > 0 &&
      !has(
        /^-[a-zA-Z]*[lavr]|^--(?:list|all|remotes|verbose|show|contains|no-contains|merged|no-merged|points-at|format|sort)/,
      ));
  if (sub === "fetch" || sub === "gc" || (sub === "branch" && branchWrite)) files.push(".");
  if (base === undefined) return files.length ? files : null;
  const under = (file: string) =>
    file === "."
      ? `${base}/${OPAQUE_TARGET}git`
      : /^[/~$]|^[A-Za-z]:[\\/]/.test(file)
        ? file
        : `${base}/${file}`;
  return files.length ? files.map(under) : null;
};

/**
 * The paths an inline script or its arguments spell out: every absolute or
 * `~/` path, and every relative one that climbs with `..`. An interpreter's
 * inline script may write anywhere it names, so each counts as a change, with
 * the directory it runs in.
 */
const PATHS = /(?<![\w.~:/$-])(?:~\/|\/|[A-Za-z]:\/|\.\.(?:\/|$))[^\s'"`$),;:*?<>|\\[\]{}]*/g;
const pathsIn = (text: string): string[] => [...text.matchAll(PATHS)].map((match) => match[0]);

/**
 * `ln`'s link sources, resolved as the link will: a relative symbolic source
 * against the directory the link lands in. Writes through such a link change
 * its source, so an implementer's links are judged by where they point.
 */
const linkSources = (args: readonly string[], at: (file: string) => string | null): string[] => {
  const names = operands([...args]);
  const into = args.indexOf("-t");
  const dest = into >= 0 ? args[into + 1] : names.length > 1 ? names.at(-1) : ".";
  const sources = names.filter((name, index) =>
    into >= 0 ? name !== dest : index < names.length - 1 || names.length === 1,
  );
  const target = dest === undefined ? null : at(dest);
  const symbolic = args.some((arg) => /^-[a-zA-Z]*s|^--symbolic$/.test(arg));
  const base =
    target === null
      ? null
      : into >= 0 || sources.length > 1 || existsSync(target) || /[\\/]$/.test(dest ?? "")
        ? target
        : path.dirname(target);
  return sources.flatMap((source) => {
    if (symbolic && base !== null && !path.isAbsolute(homeExpanded(source)))
      return [path.resolve(base, source)];
    const resolved = at(source);
    return resolved ? [resolved] : [];
  });
};

/**
 * Whether a shell command recognizably edits files (redirects, tee, touch,
 * mkdir, cp/mv/rm, `sed -i`/`perl -i`, dd, and working-tree git: apply,
 * restore, checkout --, mv, rm). `targets` lists the files when they are all
 * known, else null. Interpreters and formatters are not detected; Workit's
 * own commands never count.
 */
export const shellWrites = (
  command: string,
  depth = 0,
): { writes: boolean; targets: string[] | null } => {
  const targets: string[] = [];
  let unknown = false;
  for (const segment of segmentsOf(command)) {
    const inner = depth < 4 ? wrappedScript(segment.words) : null;
    if (inner !== null) {
      const nested = shellWrites(inner, depth + 1);
      if (nested.writes && nested.targets === null) unknown = true;
      else if (nested.targets) targets.push(...nested.targets);
    }
    targets.push(
      ...segment.redirects.filter((item) => !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(item)),
    );
    const edits = editsOf(segment.words);
    if (edits === null) unknown = true;
    else targets.push(...edits);
  }
  if (!unknown && targets.length === 0) return { writes: false, targets: null };
  return { writes: true, targets: unknown ? null : targets };
};

type Gate = { blockers: WriteBlocker[]; root: string; plans: Set<string> };
type Cached = Gate & { key: string; planKey: string };
const cache = new Map<string, Cached>();

const planKeyOf = (root: string, plans: Iterable<string>) =>
  [...plans].map((file) => fileSignature(path.resolve(root, file)) ?? "-").join("\0");

/** Unmet, unwaived before-write requirements of the checkout branch's open task. */
const gateFor = (cwd: string): Gate | null => {
  const store = new TaskReader(cwd);
  const listed = store.listTaskIndex();
  if (!listed.ok) return null;
  const key = store.currentKey();
  if (!key.ok) return null;
  const entry = listed.data
    .filter((item) => item.key === key.data.key && item.status !== "closed")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!entry) return { blockers: [], root: store.root, plans: new Set() };
  const ledger = ledgerPath(store.root);
  const cacheKey = `${entry.id}\0${entry.revision}\0${(ledger.ok && fileSignature(ledger.value)) || "-"}`;
  const hit = cache.get(store.root);
  // A cited plan created or edited since changes the answer (long-lived hosts).
  if (hit && hit.key === cacheKey && hit.planKey === planKeyOf(store.root, hit.plans)) return hit;
  const task = store.readTask(entry.id);
  if (!task.ok) return null;
  const workspace = store.readWorkspace();
  const plans = new Set(
    (latestJudgment(task.data)?.refs ?? []).flatMap((ref) =>
      ref.kind === "file" ? [ref.path] : [],
    ),
  );
  // An approved limitation clears a waivable requirement, as at close.
  const blockers = writeBlockers(task.data, store.root).filter((blocker) => {
    const requirement = task.data.policy?.requirements.find(
      (item) => item.ruleId === blocker.ruleId && item.before === "write",
    );
    return !(
      requirement?.acceptanceAllowed &&
      workspace.ok &&
      workspace.data &&
      applicableDecision(task.data, workspace.data, requirement, store.root).length > 0
    );
  });
  const gate: Cached = {
    blockers,
    root: store.root,
    plans,
    key: cacheKey,
    planKey: planKeyOf(store.root, plans),
  };
  cache.set(store.root, gate);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return gate;
};

// --- the live-session guard (#274) ------------------------------------------

/** git subcommands that change a checkout's files, index or HEAD. */
const MUTATING_GIT = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
]);
/** Subcommands whose `-n` means `--dry-run` (for `commit`, `-n` skips hooks). */
const DRY_N = new Set(["add", "clean", "rm", "mv"]);
/** `workit git` verbs that commit, move HEAD or change the index in the checkout. */
const MUTATING_WORKIT_GIT = new Set(["commit", "branch", "stage", "unstage"]);

/** A placeholder file name that stands for its directory (an unknown write, a git command). */
const DIR_TARGET = ".workit-live-target";

/**
 * For an implementer's confinement: a placeholder file name, then the command's
 * name (URI-encoded), standing for the directory a writer Workit cannot see
 * into (an interpreter's inline script, a `-c` shell, `curl -O`) runs in.
 */
export const OPAQUE_TARGET = ".workit-runs-";

/** A one-command override: `WORKIT_LIVE_SESSION=override <command>`. */
const OVERRIDE = "WORKIT_LIVE_SESSION=override";

/** Only asks for help or a dry run: changes nothing. */
const inert = (args: readonly string[], sub: string): boolean =>
  args.some(
    (arg) =>
      arg === "--help" ||
      arg === "-h" ||
      arg === "--dry-run" ||
      (DRY_N.has(sub) && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) && !arg.startsWith("--")),
  );

/**
 * The directories mutating git commands in `command` run in (raw-git's
 * analysis: `cd`/`pushd`, groups, `-C`, env and wrapper prefixes, `bash -c`,
 * `$(…)`, `eval`, `xargs`, `find -exec`, PowerShell, `cmd /c`). A command
 * whose directory cannot be known is skipped, never denied.
 */
const gitMutationDirs = (cwd: string, command: string, dialect: ShellDialect): string[] => {
  let invocations: readonly RawInvocation[];
  try {
    invocations = rawInvocations(command, dialect);
  } catch {
    return [];
  }
  return invocations.flatMap((invocation) => {
    if (invocation.tool !== "git" || invocation.dir === undefined) return [];
    const at = invocation.args.findIndex((arg) => !arg.startsWith("-"));
    const sub = invocation.args[at] ?? "";
    const rest = invocation.args.slice(at + 1);
    if (!MUTATING_GIT.has(sub) || inert(rest, sub)) return [];
    // `git stash list|show` only reads.
    if (sub === "stash" && ["list", "show"].includes(rest[0] ?? "")) return [];
    return [path.resolve(cwd, invocation.dir ?? ".")];
  });
};

const CD = new Set(["cd", "chdir", "set-location", "sl"]);
const PUSHD = new Set(["pushd", "push-location"]);
const POPD = new Set(["popd", "pop-location"]);

/**
 * Stands for a directory an implementer's command moved to but the analysis
 * cannot name (`cd -`, `cd "$X"`, a bare `popd`): a write that lands under it
 * is denied by `confineImplementer`, as the shell may be anywhere.
 */
export const UNKNOWN_DIR = path.resolve(path.parse(process.cwd()).root, ".workit-unknown-dir");

/**
 * A `cd` operand resolved against `dir`. A target that cannot be known is
 * undefined, or `UNKNOWN_DIR` when `strict`.
 */
const cdInto = (
  dir: string | undefined,
  words: string[],
  strict = false,
  vars: ReadonlyMap<string, string> = new Map(),
  globs = false,
): string | undefined => {
  const lost = strict ? UNKNOWN_DIR : undefined;
  const found = words.slice(1).find((word) => !word.startsWith("-") || word === "-");
  const named = found === undefined ? undefined : expandVars(found, vars);
  // Only a leading `~` or `$HOME` expands; a mid-path `~` is literal (Windows 8.3
  // short names like RUNNER~1).
  const target = named === undefined ? undefined : homeExpanded(named);
  if (target === "-" || (target && (globs ? /^~|[$`]/ : /^~|[$`*?]/).test(target))) return lost;
  if (dir === undefined) return lost;
  return target === undefined ? os.homedir() : path.resolve(dir, target);
};

const quoteWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * `$NAME` and `${NAME}` replaced by the value a same-command assignment gave
 * it. A name the command never assigned stays as written.
 */
const expandVars = (text: string, vars: ReadonlyMap<string, string>): string =>
  vars.size === 0 || !text.includes("$")
    ? text
    : text.replace(/\$(?:(\w+)|\{(\w+)\})/g, (whole, bare?: string, braced?: string) => {
        const value = vars.get(bare ?? braced ?? "");
        return value === undefined ? whole : value;
      });

const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

/** The `NAME=value` assignments a segment makes to the shell itself (alone, or after `export`). */
const assignmentsOf = (words: readonly string[]): Array<[string, string]> => {
  const first = words.findIndex((word) => !/^\w+=/.test(word));
  const named =
    first < 0
      ? words
      : first === 0 && DECLARERS.has(words[0])
        ? words.slice(1).filter((word) => !word.startsWith("-"))
        : [];
  return named.flatMap((word) => {
    const match = /^(\w+)=(.*)$/s.exec(word);
    return match && /^[A-Za-z_]/.test(match[1]) ? [[match[1], match[2]] as [string, string]] : [];
  });
};

/** `words` without the leading `do`, `then`, `else`… that only introduce the command. */
const commandWords = (words: readonly string[]): string[] => {
  let start = 0;
  // `function name { … }`: the name is not the command.
  while (start < words.length && COMPOUND.has(words[start]))
    if (words[start++] === "function") start++;
  return words.slice(start);
};

/** Commands that can set any variable, whatever their arguments name: no variable is trusted after one. */
const REBINDS_ANY = new Set([
  "source",
  ".",
  "eval",
  "trap",
  "alias",
  "declare",
  "typeset",
  "local",
]);

const BINDERS = new Set([
  "read",
  "mapfile",
  "readarray",
  "printf",
  "getopts",
  "unset",
  "eval",
  "let",
  "set",
  "source",
  ".",
  "declare",
  "typeset",
  "local",
  "readonly",
  "export",
  "builtin",
  "command",
]);
const COMPOUND = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "{",
  "}",
]);

/** Keywords that open and close a compound body; `case`, `select` and functions are not followed. */
const OPENS = new Set(["if", "for", "while", "until", "{"]);
const CLOSES = new Set(["fi", "done", "}"]);
const UNFOLLOWED = new Set(["case", "esac", "select", "function"]);
/** Words before the command that leave it the command: `builtin eval` is still `eval`. */
const TRANSPARENT = new Set(["builtin", "command", "time", "!"]);

/**
 * Which variables a command's assignments may not be trusted for: none at all
 * after `case`, `select`, a function or a command that can set any variable
 * (`eval`, `source`, `declare`…) (`all`); else the names assigned inside a
 * loop or conditional body, and the names a conditional or non-plain
 * assignment (`+=`, `a[i]=`), a binder (`read`, `unset`, `declare -n`,
 * `printf -v`…) or `${N:=…}` can change. A `for` variable is followed
 * apart, in `segmentTargets`. Only a plain `NAME=literal` that runs in
 * sequence, or `export NAME=literal`, is substituted. None is after an IFS
 * assignment.
 */
const untrustedVars = (
  segments: readonly Segment[],
): { all: boolean; names: ReadonlySet<string> } => {
  const names = new Set<string>();
  let all = false;
  let depth = 0;
  const poison = (text: string) => {
    for (const match of text.matchAll(/[A-Za-z_]\w*/g)) names.add(match[0]);
  };
  for (const segment of segments) {
    let start = 0;
    for (; start < segment.words.length && COMPOUND.has(segment.words[start]); start++) {
      const keyword = segment.words[start];
      if (UNFOLLOWED.has(keyword)) all = true;
      if (OPENS.has(keyword)) depth++;
      else if (CLOSES.has(keyword)) depth = Math.max(0, depth - 1);
    }
    const words = segment.words.slice(start);
    // A changed IFS splits every expansion where it likes, except in a `read` it prefixes.
    const at = words.findIndex((word) => !/^\w+=/.test(word));
    const ifs = (word: string) => /\bIFS\b/.test(word);
    if (
      segment.subs?.some(ifs) ||
      words.some((w, i) => ifs(w) && !(i < at && words[at] === "read"))
    )
      all = true;
    if (depth > 0) for (const [key] of assignmentsOf(words)) names.add(key);
    const lead = words.findIndex((word) => !/^\w+\+?=|^\w+\[.*\]\+?=/.test(word));
    const first = lead < 0 ? undefined : words[lead];
    let command = lead;
    while (command >= 0 && TRANSPARENT.has(words[command] ?? "")) command++;
    if (command >= 0 && REBINDS_ANY.has(words[command] ?? "")) all = true;
    if (command >= 0 && UNFOLLOWED.has(words[command] ?? "")) all = true;
    for (const word of words)
      for (const match of word.matchAll(/\$\{(\w+)(?:\[[^\]]*\])?:?[=]/g)) names.add(match[1]);
    const assigned = lead < 0 ? words : first === "export" ? words.slice(lead + 1) : [];
    const plainOnly = assigned.every((word) => /^\w+=/.test(word) || word === "export");
    if (segment.conditional || (!plainOnly && lead < 0))
      for (const word of assigned) poison(word.split("=")[0]);
    if (lead >= 0 && words.slice(lead).some((word) => BINDERS.has(word))) {
      const flagged = words.slice(lead + 1).some((word) => word.startsWith("-"));
      const plainExport = first === "export" && !flagged;
      if (!plainExport) poison(words.slice(lead).join(" "));
      else if (segment.conditional) poison(words.slice(lead).join(" "));
    }
    if (words.some((word) => /^\w+\+=/.test(word)))
      for (const word of words) if (/^\w+\+=/.test(word)) poison(word.split("+")[0]);
  }
  return { all, names };
};

/**
 * Where a variable reference stands in a path Workit cannot resolve: a write
 * under it is denied by `confineImplementer`, naming the references
 * (each URI-encoded, joined by `+`, in one path segment).
 */
export const UNKNOWN_VAR = path.resolve(path.parse(process.cwd()).root, ".workit-unknown-var");

const REFERENCE = /\$\{(\w+)[^}]*\}|\$(\w+)|\$\([^)]*\)?|`[^`]*`?/g;

/** The variable references and substitutions left in `text`, as written (`$T`, `$(cat f)`). */
export const unresolvedRefs = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(REFERENCE)].map((match) => {
      const name = match[1] ?? match[2];
      return name === undefined ? match[0] : `$${name}`;
    }),
  ),
];

const unknownVarTarget = (text: string): string => {
  const refs = unresolvedRefs(text);
  return path.join(
    UNKNOWN_VAR,
    (refs.length > 0 ? refs : [text]).map(encodeURIComponent).join("+"),
  );
};

/** Literal-pattern parameter operators: `/`, `//`, `%`, `%%`, `#`, `##`; null for any other. */
const applyOperator = (value: string, operator: string): string | null => {
  if (operator === "") return value;
  const swap = /^(\/\/?)([^/*?[\]]+)\/([^*?[\]]*)$/.exec(operator);
  if (swap)
    return swap[1] === "//" ? value.replaceAll(swap[2], swap[3]) : value.replace(swap[2], swap[3]);
  const trim = /^(%%?|##?)([^*?[\]]*)$/.exec(operator);
  if (!trim) return null;
  if (trim[1].startsWith("%"))
    return value.endsWith(trim[2]) ? value.slice(0, value.length - trim[2].length) : value;
  return value.startsWith(trim[2]) ? value.slice(trim[2].length) : value;
};

/** One word expands to at most this many texts; past it, the reference stays unresolved. */
const MAX_EXPANSIONS = 16;

/**
 * Every text `text` may expand to: each `$NAME`, `${NAME}` or literal
 * `${NAME/a/b}`-style reference replaced by the value an assignment gave it,
 * or by each word of the `for` list it loops over. Other references stay as
 * written.
 */
const expansions = (
  text: string,
  vars: ReadonlyMap<string, string>,
  loops: ReadonlyMap<string, readonly string[]>,
): string[] => {
  if (!text.includes("$")) return [text];
  let results = [""];
  let last = 0;
  for (const match of text.matchAll(/\$\{(\w+)([^}]*)\}|\$(\w+)/g)) {
    const name = match[1] ?? match[3];
    const literal = text.slice(last, match.index);
    last = match.index + match[0].length;
    const value = vars.get(name);
    const values = loops.get(name) ?? (value === undefined ? null : [value]);
    // `${NAME:-default}` (and `-`, `=`, `:=`): the default, itself expanded, for an empty value.
    const fallback = /^:?[-=](.*)$/s.exec(match[2] ?? "")?.[1];
    const applied = values?.flatMap((item) =>
      fallback === undefined
        ? [applyOperator(item, match[2] ?? "")]
        : item === ""
          ? expansions(fallback, vars, loops)
          : [item],
    );
    const fits = applied && results.length * applied.length <= MAX_EXPANSIONS;
    results =
      fits && applied.every((item) => item !== null)
        ? results.flatMap((prefix) => applied.map((item) => prefix + literal + item))
        : results.map((prefix) => prefix + literal + match[0]);
  }
  return results.map((prefix) => prefix + text.slice(last));
};

/**
 * The path `$(mktemp [-d] [-p DIR|-t] [TEMPLATE])` prints: TEMPLATE under DIR,
 * the temp dir, or (no `-p`/`-t`) the directory it runs in; null for any
 * other value.
 */
const mktempPath = (value: string, dir: string | undefined): string | null => {
  const match = /^\$\(\s*mktemp\b([^()`$]*)\)$/.exec(value.trim());
  if (!match) return null;
  const args = match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((arg) => arg.replace(/^(["'])(.*)\1$/, "$2"));
  let base: string | null = null;
  let template: string | undefined;
  let temp = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-p" || arg === "--tmpdir") {
      if (arg === "-p") base = args[++index] ?? null;
      else temp = true;
      if (arg === "-p" && base === null) return null;
    } else if (arg.startsWith("--tmpdir=")) base = arg.slice("--tmpdir=".length);
    else if (arg === "-t") temp = true;
    else if (!arg.startsWith("-")) template = arg;
  }
  if (base === null && (temp || template === undefined)) base = os.tmpdir();
  const name = homeExpanded(template ?? "tmp.XXXXXXXXXX");
  if (path.isAbsolute(name)) return name;
  const from = base === null ? dir : homeExpanded(base);
  if (from === undefined || (!path.isAbsolute(from) && dir === undefined)) return null;
  return path.resolve(dir ?? from, from, name);
};

/** A leading `~`, `$HOME` or `${HOME}` the shell would expand. */
const homeExpanded = (file: string): string => {
  const match = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(file);
  return match ? (process.env.HOME || os.homedir()) + file.slice(match[0].length) : file;
};

/**
 * How far segmentTargets looks: false, the edit analysis; true, an
 * implementer's confinement (opaque writers, `-c` scripts, unknowns as
 * placeholders); "registry", that plus what only the registry guard reads
 * (eval, a heredoc-fed shell, a scripted editor, a script held in a variable).
 */
type Strict = boolean | "registry";

/**
 * Per top-level segment, the files it writes (redirects, `touch`, `rm`,
 * `sed -i`…) and `workit git commit|branch|stage|unstage`, resolved against the
 * directory that segment runs in (`cd`, `pushd`/`popd`, `( … )` groups). A
 * relative target in an unknown directory is skipped.
 */
const segmentTargets = (
  cwd: string,
  command: string,
  dialect: ShellDialect,
  depth = 0,
  strict: Strict = false,
  inherited: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const targets: string[] = [];
  // Scripts this command writes from a heredoc (`cat > t.sh <<'EOF'`), by path.
  const written = new Map<string, string>();
  let dir: string | undefined = cwd;
  let stack: Array<string | undefined> = [];
  const segments = segmentsOf(command, dialect);
  const untrusted = untrustedVars(segments);
  let vars = new Map(
    untrusted.all ? [] : [...inherited].filter(([key]) => !untrusted.names.has(key)),
  );
  let loops = new Map<string, string[]>();
  let nesting = 0;
  const groups: Array<{
    dir: string | undefined;
    stack: Array<string | undefined>;
    vars: Map<string, string>;
    loops: Map<string, string[]>;
  }> = [];
  const atAll = (file: string, base: string | undefined = dir): string[] =>
    expansions(file, vars, loops).flatMap((text) => {
      const home = homeExpanded(text);
      if (strict && unresolvedRefs(home).length > 0) return [unknownVarTarget(home)];
      if (path.isAbsolute(home)) return [home];
      return base === undefined ? [] : [path.resolve(base, home)];
    });
  const at = (file: string): string | null => {
    const all = atAll(file);
    return all.length > 1 ? unknownVarTarget(file) : (all[0] ?? null);
  };
  /** A reference the command spells without a `\\` before its `$` somewhere: the shell expands it. */
  const unescaped = (ref: string): boolean => {
    const name = /^\$(\w+)$/.exec(ref)?.[1];
    return (
      name === undefined || new RegExp(`(?<!\\\\)\\$(?:${name}(?!\\w)|\\{${name}\\b)`).test(command)
    );
  };
  // A `for` word Workit can know: whitespace or a glob in it (even quoted) splits `$name`.
  const listWord = (word: string): string | null =>
    unresolvedRefs(word).length > 0 || /[\s*?[]/.test(word) ? null : word;
  /** The words a `for` list item built from variables stands for; null for any it cannot know. */
  const listWords = (item: string): Array<string | null> =>
    expansions(item, vars, loops).map((text) => listWord(homeExpanded(text)));
  // `$PWD` names the directory a literal `cd` moved to when that `cd` starts its own
  // `;` or newline segment (`plain`) and lands in a directory that exists; a CDPATH
  // or a function (`f() …`, which may be `cd`) leaves it unknown.
  const redefined =
    untrusted.all ||
    Boolean(process.env.CDPATH) ||
    /\bCDPATH\b/.test(command) ||
    segments.some(
      (s, i) =>
        s.words.length > 0 &&
        segments[i + 1]?.group === "open" &&
        segments[i + 2]?.group === "close",
    );
  const moved = (plain: boolean) => {
    if (
      plain &&
      !redefined &&
      !untrusted.names.has("PWD") &&
      dir !== undefined &&
      dir !== UNKNOWN_DIR &&
      statSync(dir, { throwIfNoEntry: false })?.isDirectory()
    )
      vars.set("PWD", dir);
    else vars.delete("PWD");
  };
  const lost = () => {
    dir = strict ? UNKNOWN_DIR : undefined;
    stack = [];
    moved(false);
  };
  const assigned = (value: string): string | null => {
    const made = mktempPath(value, dir);
    if (made !== null) return made;
    const all = expansions(value, vars, loops).map(homeExpanded);
    return all.length === 1 && unresolvedRefs(all[0]).length === 0 ? all[0] : null;
  };
  for (const segment of segments) {
    if (segment.group === "open") {
      groups.push({
        dir,
        stack: [...stack],
        vars: new Map(vars),
        loops: new Map(loops),
      });
      continue;
    }
    if (segment.group === "close") {
      const saved = groups.pop();
      if (saved) ({ dir, stack, vars, loops } = saved);
      continue;
    }
    const body = commandWords(segment.words);
    // The segment whose output this one reads (`a | b`).
    const before = segments[segments.indexOf(segment) - 1];
    const feeder = before?.pipe ? before : undefined;
    const keywords = segment.words.length - body.length;
    for (const keyword of segment.words.slice(0, keywords))
      if (OPENS.has(keyword)) nesting++;
      else if (CLOSES.has(keyword)) nesting = Math.max(0, nesting - 1);
    const loop = segment.words.slice(0, keywords).lastIndexOf("for");
    if (loop >= 0) {
      const [name = "", keyword, ...items] = segment.words.slice(loop + 1);
      const expanding = new Set(segment.expands ?? []);
      const list = items.flatMap((item, index) =>
        expanding.has(loop + 3 + index) ? listWords(item) : [listWord(homeExpanded(item))],
      );
      vars.delete(name);
      if (
        keyword === "in" &&
        list.length <= MAX_EXPANSIONS &&
        !list.includes(null) &&
        !untrusted.all &&
        !untrusted.names.has(name)
      )
        loops.set(name, list as string[]);
      else loops.delete(name);
      continue;
    }
    const lead = body.findIndex((word) => !/^\w+=/.test(word));
    const words = lead < 0 ? [] : body.slice(lead);
    if (!segment.conditional && !untrusted.all)
      for (const [key, value] of assignmentsOf(segment.words))
        if (!untrusted.names.has(key)) {
          loops.delete(key);
          const resolved = assigned(value);
          if (resolved === null) vars.delete(key);
          else vars.set(key, resolved);
        }
    const moving = (word = "") => {
      const verb = (word.split(/[\\/]/).at(-1) ?? "").toLowerCase();
      return CD.has(verb) || PUSHD.has(verb) || POPD.has(verb);
    };
    const name = (words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
    // A directory change inside a loop or conditional body may or may not run.
    const moves = moving(name);
    if (moves && strict && nesting > 0) {
      dir = UNKNOWN_DIR;
      moved(false);
      continue;
    }
    if (moves && keywords > 0) {
      moved(false);
      continue;
    }
    // `command cd`, `builtin cd`: Workit does not follow where they land.
    const wrapper = words.findIndex((word) => !TRANSPARENT.has(word) && !PREFIXES.has(word));
    if (wrapper > 0 && moving(words[wrapper])) {
      lost();
      continue;
    }
    const plain = !segment.conditional;
    if (CD.has(name)) {
      dir = cdInto(dir, words, Boolean(strict), vars, strict === "registry");
      moved(plain);
      continue;
    }
    // `pushd` with no directory, `+N`/`-N` or an option, or `popd` with any, rotates the stack.
    const rotates = words.length < 2 || words.slice(1).some((word) => /^[-+]/.test(word));
    if (dialect === "posix" && (PUSHD.has(name) ? rotates : POPD.has(name) && words.length > 1)) {
      lost();
      continue;
    }
    if (PUSHD.has(name)) {
      stack.push(dir);
      dir = cdInto(dir, words, Boolean(strict), vars, strict === "registry");
      moved(plain);
      continue;
    }
    if (POPD.has(name)) {
      dir = stack.length ? stack.pop() : strict ? UNKNOWN_DIR : undefined;
      moved(plain);
      continue;
    }
    const literal =
      depth < 4 ? (wrappedScript(words) ?? (strict ? shellScript(words) : null)) : null;
    // `S='…'; bash -c "$S"`: the script a variable set in this command holds.
    const held = literal !== null && strict === "registry" ? expansions(literal, vars, loops) : [];
    const inner = held.length === 1 ? held[0] : literal;
    const unPwd = () => new Map([...vars].filter(([key]) => key !== "PWD"));
    if (inner !== null && dir !== undefined)
      for (const runIn of workitRunDir(dir, words, atAll))
        targets.push(
          // `$PWD` in a command run elsewhere is not this directory.
          ...segmentTargets(
            runIn,
            inner,
            "posix",
            depth + 1,
            strict,
            runIn === dir ? vars : unPwd(),
          ),
        );
    // `sudo -u U cp …`, `timeout 5 bash -c …`, `! cp …`: the wrapped command, judged on its own.
    const bare = strict === "registry" && depth < 4 ? unwrapped(words) : null;
    if (bare?.length && dir !== undefined)
      targets.push(
        ...segmentTargets(
          dir,
          bare
            .flatMap((word) => expansions(word, vars, loops))
            .map(quoteWord)
            .join(" "),
          "posix",
          depth + 1,
          strict,
          vars,
        ),
      );
    if (strict === "registry" && dir !== undefined && depth < 4) {
      const run = words.slice(
        Math.max(
          0,
          words.findIndex((word) => !PREFIXES.has(word)),
        ),
      );
      const [verb = "", ...args] = run.map((word, index) =>
        index ? word : (word.split(/[\\/]/).at(-1) ?? "").toLowerCase(),
      );
      const fed = segment.stdin?.join("\n");
      if (fed !== undefined)
        for (const file of segment.redirects)
          for (const into of atAll(file)) written.set(into, fed);
      // A script file, read now (up to 256 KB), or the heredoc this command wrote it from.
      const read = (file: string): string[] =>
        atAll(file).flatMap((script) => {
          const made = written.get(script);
          if (made !== undefined) return [made];
          try {
            // Only a regular file: a FIFO or a device would block the hook.
            const stat = statSync(script);
            const text =
              stat.isFile() && stat.size <= 262_144 ? readFileSync(script, "utf8") : "\0";
            return text.includes("\0") ? [] : [text];
          } catch {
            return [];
          }
        });
      // `/dev/stdin` (like `-`) is the heredoc the command feeds it, never the hook's own stdin.
      const { named: operand, preloads } = scriptArgs(verb, args);
      const named = operand === "/dev/stdin" ? undefined : operand;
      // What a literal producer pipes in: `echo`/`printf` words (a printf format
      // too, which may be the script itself), `cat` of a heredoc or files.
      const maker = feeder ? commandWords(feeder.words) : [];
      const [format = "", ...values] = maker.slice(1);
      let filled = 0;
      // printf's `%s`, `%b`, `%q` take its arguments in order; the arguments count on their own too.
      const printed = format.replace(/%[sbq]/g, () => values[filled++] ?? "");
      const piped: string[] = /^(?:echo|printf)$/.test(maker[0] ?? "")
        ? [[maker[0] === "printf" ? printed : format, ...values].join("\n").replaceAll("\\n", "\n")]
        : maker[0] === "cat"
          ? [...(feeder?.stdin ?? []), ...operands(maker.slice(1)).flatMap(read)]
          : [];
      const inputs = (segment.inputs ?? []).filter((file) => file !== "/dev/null");
      // `eval`, `trap '<script>' SIG` and `alias n='<script>'` hold shell text.
      const shells: string[] =
        verb === "eval"
          ? [args.join(" ")]
          : verb === "trap"
            ? args.slice(0, 1)
            : verb === "alias"
              ? args.map((arg) => arg.replace(/^[^=]*=/, ""))
              : [];
      const others: string[] = [];
      if (SCRIPT_SHELLS.has(verb) || verb === "." || verb === "source") {
        // No script operand: the heredoc, or the file `<` feeds it (`bash < x.sh`).
        if (named === undefined && shellScript(run) === null)
          shells.push(...(segment.stdin ?? []), ...inputs.flatMap(read), ...piped);
        else if (named !== undefined && shellScript(run) === null) shells.push(...read(named));
        shells.push(...preloads.flatMap(read));
      } else if (INTERPRETERS.test(verb)) {
        // Inline code (`-c`, `-e`) is judged like a script file.
        const code = args.findIndex((arg) => /^-[a-zA-Z]*[ce]$|^--eval$/.test(arg));
        // As the shell expands it (`"…$HOME/…"`).
        if (code >= 0) others.push(...expansions(args[code + 1] ?? "", vars, loops));
        // A script file, or the heredoc it reads on stdin (`python3 <<EOF`).
        others.push(
          ...(named === undefined
            ? [...(segment.stdin ?? []), ...inputs.flatMap(read), ...piped]
            : read(named)),
          ...preloads.flatMap(read),
        );
      } else if (/[\\/]/.test(run[0] ?? ""))
        // `./x.sh`: its shebang names the interpreter.
        for (const text of read(run[0]))
          (/^#!.*\b(?:python|node|bun|deno|ruby|perl|php)/.test(text) ? others : shells).push(text);
      for (const script of shells)
        targets.push(...segmentTargets(dir, script, "posix", depth + 1, strict, vars));
      for (const raw of others) {
        // Comment lines (`#`, `//`, `*`) are not code.
        const text = raw.replace(/^\s*(?:#(?!!)|\/\/|\/?\*).*$/gm, "");
        // `'.config', 'workit', 'x.json'`, `".config" / "workit"`: literals a join puts together.
        const joined = [
          ...text.matchAll(/(?:["'][^"'\s,*?[]+["']\s*[,/+]\s*)+["'][^"'\s,*?[]+["']/g),
        ].map(({ 0: literals, index }) => ({
          word: literals.replace(/["']\s*[,/+]\s*["']/g, "/").replace(/["']/g, ""),
          index,
        }));
        // Each path as spelled, and each under the home dir (`home + "/.config/…"`); a
        // config dir or registry root itself counts unless only read (readsRoot).
        // Only code that reads the home dir itself builds a path under it.
        const homes = /homedir\(|expanduser\(|Path\.home\(|['"]HOME['"]|env\.HOME|\$HOME|~/.test(
          text,
        );
        const under = (word: string) =>
          homes ? [path.join(homeExpanded("~"), word.replace(/^~/, ""))] : [];
        const found = [
          ...[...text.matchAll(PATHS)].flatMap(({ 0: word, index }) =>
            [...atAll(word), ...under(word)].map((file) => ({ file, index })),
          ),
          ...joined.flatMap(({ word, index }) => under(word).map((file) => ({ file, index }))),
        ];
        for (const { file, index } of found)
          if (!isRoot(file) || !readsRoot(text, index)) targets.push(file);
      }
      // An editor writes only when it runs commands: `-c`, `+cmd`, `-s`, ex mode or stdin.
      if (
        /^(?:n?vim?|ex|ed|emacs)$/.test(verb) &&
        (segment.stdin ||
          inputs.length > 0 ||
          feeder ||
          args.some(
            (arg, index) =>
              /^(?:-[a-zA-Z]*[se]|--(?:batch|eval|script))$/.test(arg) ||
              (/^(?:-c|--cmd)$/.test(arg) && !inertEdit(args[index + 1] ?? "")) ||
              (arg.startsWith("+") && !inertEdit(arg.slice(1) || "1")),
          ))
      )
        for (const file of operands(args)) targets.push(...atAll(file));
      // `cp -l` makes a hard link: a second name for its source.
      if (verb === "cp" && args.some((arg) => /^-[a-zA-Z]*l|^--link$/.test(arg)))
        for (const file of operands(args).slice(0, -1)) targets.push(...atAll(file));
    }
    if (strict && dir !== undefined) {
      const runIn = dir;
      for (const sub of depth < 4 ? (segment.subs ?? []) : [])
        targets.push(...segmentTargets(runIn, sub, dialect, depth + 1, strict, vars));
      const expanding = new Set(segment.expands ?? []);
      const scriptOf = (index: number): string | undefined => {
        const word = body[index];
        if (word === undefined || !expanding.has(keywords + index)) return word;
        // A loop variable stands for each of its words: the paths in any of them count.
        const all = expansions(word, vars, loops);
        return all.some((text) => unresolvedRefs(text).some(unescaped))
          ? undefined
          : all.join("\n");
      };
      const opaque = segment.unanalyzable
        ? ["."]
        : inner === null
          ? opaqueWrites(body, scriptOf)
          : null;
      // Named by the command it runs, past wrappers such as `env` or `sudo`.
      const ran = words.findIndex((word) => word === "xargs" || !PREFIXES.has(word));
      const runner = words[ran];
      // A command named by a variable (`c=curl; $c -o …`) may write anything.
      if (
        runner !== undefined &&
        expanding.has(keywords + lead + ran) &&
        unresolvedRefs(homeExpanded(runner)).length > 0
      )
        targets.push(unknownVarTarget(runner));
      const here = segment.unanalyzable
        ? DIR_TARGET
        : `${OPAQUE_TARGET}${encodeURIComponent(runner?.split(/[\\/]/).at(-1) ?? "a command")}`;
      // An interpreter's code is judged with its calls above (readsRoot), not here.
      const quiet = strict === "registry" && INTERPRETERS.test(runner?.split(/[\\/]/).at(-1) ?? "");
      for (const file of opaque ?? [])
        for (const resolved of atAll(file))
          if (!quiet || !isRoot(resolved))
            targets.push(file === "." ? path.join(resolved, here) : resolved);
      const ln = words.findIndex((word) => /^ln$/i.test(word.split(/[\\/]/).at(-1) ?? ""));
      const lnArgs = words.slice(ln + 1);
      // The registry guard: a hard link is a second name for its source; a symbolic one only points.
      if (
        ln >= 0 &&
        words.slice(0, ln).every((word) => PREFIXES.has(word)) &&
        (strict !== "registry" || !lnArgs.some((arg) => /^-[a-zA-Z]*s|^--symbolic$/.test(arg)))
      )
        targets.push(...linkSources(lnArgs, at));
    }
    for (const file of segment.redirects)
      if (!/^\/dev\/(?:null|stdout|stderr|tty)$/.test(file)) targets.push(...atAll(file));
    const edits = editsOf(body);
    if (edits === null) {
      if (dir !== undefined) targets.push(path.join(dir, DIR_TARGET));
    } else for (const file of edits) targets.push(...atAll(file));
    if (dir !== undefined)
      for (const invocation of workitInvocations(body.map(quoteWord).join(" "), "posix")) {
        const { at: runsIn, args } = workitCwd(dir, invocation, atAll);
        if (
          args[0] === "git" &&
          MUTATING_WORKIT_GIT.has(args[1] ?? "") &&
          !inert(args.slice(2), "")
        )
          targets.push(...runsIn.map((runs) => path.join(runs, DIR_TARGET)));
      }
  }
  return targets;
};

/** Where `workit check|lock run [--cwd <dir>] -- <cmd>` runs its command: `--cwd` resolved against `dir`. */
const workitRunDir = (dir: string, words: string[], resolve: Resolve): string[] => {
  for (const invocation of workitInvocations(words.map(quoteWord).join(" "), "posix")) {
    const { at, args } = workitCwd(dir, invocation, resolve);
    if (args[0] === "check" || (args[0] === "lock" && args[1] === "run")) return at;
  }
  return [dir];
};

/** Resolves a path a command names against a directory: every value it may take. */
type Resolve = (file: string, base: string) => string[];

/** A workit invocation's global `--cwd <dir>` (or `--cwd=<dir>`), resolved against `dir`. */
const workitCwd = (
  dir: string,
  args: string[],
  resolve: Resolve,
): { at: string[]; args: string[] } => {
  const { rest, cwd } = skipWorkitGlobals(args);
  return { at: cwd === null ? [dir] : resolve(cwd, dir), args: rest };
};

/**
 * Where one shell command changes files: the files it writes and, as
 * `<dir>/.workit-live-target`, each directory a mutating git or
 * `workit git commit|branch|stage|unstage` runs in or an unknown write happens in.
 * `strict` (an implementer's confinement) also reads `-c` shell scripts and
 * `$(…)`, counts writers the analysis cannot see in the directory they run
 * in, and judges `ln` sources. Absolute paths; [] when the command cannot be
 * analysed (fail open).
 */
export const shellMutationTargets = (
  cwd: string,
  command: string,
  dialect: ShellDialect = "posix",
  strict: Strict = false,
): string[] => {
  try {
    // The registry guard reads a name the command does not set from the hook's own environment.
    const env = new Map(
      strict === "registry"
        ? [...command.matchAll(/\$\{?([A-Za-z_]\w*)/g)]
            .filter((match) => !/^(?:OLD)?PWD$/.test(match[1]))
            .map((match) => [match[1], process.env[match[1]] ?? ""])
        : [],
    );
    return [
      ...segmentTargets(cwd, command, dialect, 0, strict, env),
      ...gitMutationDirs(cwd, command, dialect).map((dir) => path.join(dir, DIR_TARGET)),
    ];
  } catch (error) {
    if (strict === "registry") throw error;
    return [];
  }
};

/** The command is one simple command led by `WORKIT_LIVE_SESSION=override`. */
const overridden = (command: string, dialect: ShellDialect): boolean => {
  const segments = segmentsOf(command, dialect);
  if (segments.length !== 1 || segments[0].group || segments[0].subs?.length) return false;
  const words = segments[0].words;
  const lead = words.findIndex((word) => !/^\w+=/.test(word));
  return lead > 0 && words.slice(0, lead).includes(OVERRIDE);
};

const HOST_LABELS: Readonly<Record<string, string>> = {
  claude_code: "Claude Code",
  opencode: "OpenCode",
  codex_cli: "Codex CLI",
  codex_desktop: "Codex Desktop",
  cursor: "Cursor",
  pi: "Pi",
};

const ageText = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
};

const liveDeny = ({ marker, checkout, ageMs, file }: LiveConflict): HookDecision => {
  const unblock = `Work in your own worktree (\`git worktree add <path> -b <branch>\`, or \`workit fanout worktree create <slice>\`). Only if the user confirms that session is finished: release it with \`rm '${file}'\`, or prefix one command with ${OVERRIDE}.`;
  return {
    kind: "deny",
    reason: `workit live-session guard: ${checkout} belongs to another live agent session, ${HOST_LABELS[marker.host] ?? marker.host} session ${marker.session}${marker.pid === null ? "" : ` (pid ${marker.pid})`}, last active ${ageText(ageMs)} ago. Do not edit a checkout another session is working in; read-only commands stay allowed. ${unblock}`,
    unblock,
  };
};

/** One target per directory. */
const guarded = (targets: readonly string[]): string[] => {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const dir = path.dirname(target);
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
};

/**
 * Deny when a target's checkout belongs to another live session and its
 * workspace keeps `liveSessionGuard` on. Fails open.
 */
const liveGate = (owner: LiveOwner, targets: readonly string[], deps?: LiveDeps): HookDecision => {
  try {
    for (const target of guarded(targets)) {
      const conflict = liveConflict(target, owner, deps);
      if (conflict && workspaceLiveSessionGuard(conflict.checkout)) return liveDeny(conflict);
    }
  } catch {
    // Fail open.
  }
  return NONE;
};

const claimAll = (owner: LiveOwner, targets: readonly string[], deps?: LiveDeps): void => {
  for (const target of guarded(targets)) claimLiveSession(target, owner, deps);
};

/** The absolute paths an edit touches: its files, or cwd itself when unknown. */
export const liveTargets = (cwd: string, paths: readonly string[] | null): string[] =>
  paths?.length ? paths.map((file) => path.resolve(cwd, file)) : [path.join(cwd, DIR_TARGET)];

// --- the issued-registry, approvals and config guard (#292) ----------------

/**
 * What only Workit's hooks and the CLI write (`<state>/issued*`,
 * `<state>/approvals/`) or only the user changes (the config dir's
 * workspaces.json: grants, roles, youtrack.writes). An agent that could write
 * one would forge an issued session, a token or the user's yes, or raise its
 * own grants.
 */
type Registry = "issued" | "approvals" | "grants";

/** The config dirs whose workspaces.json is guarded: this env's and the account home's (grants). */
const configDirs = (): string[] => [resolveConfigDir(), grantsDir()];

/**
 * The guarded paths a glob `target` may expand to, matched segment by
 * segment (`*`, `?`, `[…]`) against the state registries Workit lists in
 * its own state dir and the config files; the user's tree is never globbed.
 */
const globbed = (cwd: string, target: string, state: string, configs: string[]): string[] => {
  if (!/[*?[]/.test(target)) return [];
  // The literal prefix through the same canonical form as the guarded paths
  // (symlinks, Windows 8.3 short names such as RUNNER~1); the glob segments as written.
  const raw = path.resolve(cwd, target).split(path.sep);
  const literal = raw.findIndex((part) => /[*?[]/.test(part));
  const pattern = [
    ...canonical(raw.slice(0, literal).join(path.sep) || path.sep)
      .replace(/[\\/]+$/, "")
      .split(path.sep),
    ...raw.slice(literal),
  ];
  const segment = (glob: string, name: string) => {
    try {
      return new RegExp(
        // Like the shell, `*` and `?` never match a leading dot unless the pattern spells it.
        `^${glob.startsWith(".") ? "" : "(?!\\.)"}${glob
          .replace(/[.+^$(){}|\\]/g, "\\$&")
          .replace(/\[!/g, "[^")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")}$`,
        CASE_INSENSITIVE ? "i" : "",
      ).test(name);
    } catch {
      // `x[`, `x[z-a]`: no glob the shell expands, so it names no guarded file.
      return false;
    }
  };
  const hit = (file: string, below: boolean) => {
    const parts = canonical(file).split(path.sep);
    return (
      (below ? pattern.length >= parts.length : pattern.length === parts.length) &&
      parts.every((part, index) => segment(pattern[index], part))
    );
  };
  let roots: string[] = [];
  try {
    roots = readdirSync(state).filter((name) => /^(?:issued|approvals$)/.test(name));
  } catch {
    // No state dir yet: no registry to hit.
  }
  return [
    ...roots.map((name) => path.join(state, name)).filter((root) => hit(root, true)),
    ...configs
      .flatMap((dir) => [dir, path.join(dir, "workspaces.json")])
      .filter((file) => hit(file, false)),
  ];
};

/** The device and inode of each guarded file (the config files, files in the state registries), bounded. */
const guardedInodes = (state: string, configs: string[]): Map<string, Registry> => {
  const seen = new Map<string, Registry>();
  let budget = 2000;
  const add = (file: string, registry: Registry) => {
    if (budget-- <= 0) return;
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat?.isFile()) seen.set(`${stat.dev}:${stat.ino}`, registry);
    else if (stat?.isDirectory())
      for (const name of readdirSync(file)) add(path.join(file, name), registry);
  };
  try {
    for (const dir of configs) add(path.join(dir, "workspaces.json"), "grants");
    for (const name of readdirSync(state))
      if (/^(?:issued|approvals$)/.test(name))
        add(path.join(state, name), name === "approvals" ? "approvals" : "issued");
  } catch {
    // An unreadable state dir: the files read so far.
  }
  return seen;
};

/** A second name for a guarded file: a regular file with more links whose inode a guarded file has. */
const hardLinked = (
  file: string,
  state: string,
  configs: string[],
  inodes: { map?: Map<string, Registry> },
): Registry | undefined => {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink < 2 || !stat.ino) return undefined;
    inodes.map ??= guardedInodes(state, configs);
    return inodes.map.get(`${stat.dev}:${stat.ino}`);
  } catch {
    return undefined;
  }
};

/** The first of `targets` an agent tool call writes into a guarded registry, with it. */
const registryTarget = (
  cwd: string,
  targets: readonly string[],
): { file: string; registry: Registry } | null => {
  const state = resolveStateDir();
  const configs = configDirs();
  const inodes = {};
  for (const target of targets) {
    const file = homeExpanded(target);
    const glob = globbed(cwd, file, state, configs)[0];
    const viaGlob = glob === undefined ? null : registryTarget(cwd, [glob]);
    if (viaGlob) return { file: target, registry: viaGlob.registry };
    const registry =
      hardLinked(path.resolve(cwd, file), state, configs, inodes) ??
      underRegistry(state, cwd, file, process.platform, canonical) ??
      (configs.some((dir) => underConfig(dir, cwd, file, process.platform, canonical))
        ? "grants"
        : null);
    if (registry) return { file: target, registry };
  }
  return null;
};

/**
 * The parts of `target` (resolved against `cwd`) below `dir`, or null outside
 * it. Pure over `platform`, so Windows shapes are testable anywhere: mixed `\`
 * and `/`, case, and the `/c/Users/...` form a POSIX shell on Windows uses.
 * `real` resolves symlinks and 8.3 short names (RUNNER~1) on the live platform.
 */
const partsUnder = (
  dir: string,
  cwd: string,
  target: string,
  platform: NodeJS.Platform,
  real: (file: string) => string,
): string[] | null => {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const fold = (value: string) => (win || platform === "darwin" ? value.toLowerCase() : value);
  const named = win ? target.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:") : target;
  const relative = p.relative(fold(real(p.resolve(dir))), fold(real(p.resolve(cwd, named))));
  return relative.startsWith("..") || p.isAbsolute(relative) ? null : relative.split(p.sep);
};

/** Which state registry `target` is or is inside: `<state>/issued*` or `<state>/approvals`. */
export const underRegistry = (
  state: string,
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real: (file: string) => string = (file) => file,
): Registry | null => {
  const first = partsUnder(state, cwd, target, platform, real)?.[0];
  if (first?.startsWith("issued")) return "issued";
  return first === "approvals" ? "approvals" : null;
};

/** Whether `target` is `<state>/issued*` or inside it (see underRegistry). */
export const underIssued = (
  state: string,
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real: (file: string) => string = (file) => file,
): boolean => underRegistry(state, cwd, target, platform, real) === "issued";

/**
 * Whether `target` is `<dir>/workspaces.json`, or `dir` itself (a copy, move
 * or removal of the dir can replace the file). Other files there grant nothing.
 */
export const underConfig = (
  dir: string,
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real: (file: string) => string = (file) => file,
): boolean => {
  const parts = partsUnder(dir, cwd, target, platform, real);
  // DIR_TARGET: a mutating git or an unknown edit run in the dir itself.
  return parts?.length === 1 && ["", "workspaces.json", DIR_TARGET].includes(parts[0]);
};

/**
 * A POSIX shell drops an unquoted `\` before the analysis sees the words, so
 * `> C:\state\issued\x` loses its separators. On Windows, a command that
 * spells out a registry path is judged with its backslashes turned into
 * slashes: denied when that path is in a write position or the targets are
 * unknown, so a copy out of it passes.
 */
export const unquotedWindowsRegistry = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): Registry | null => {
  if (platform !== "win32" || !command.includes("\\")) return null;
  const flat = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  const text = flat(command);
  const state = flat(resolveStateDir());
  const configs = configDirs().map(flat);
  const registry: Registry | null = text.includes(`${state}/issued`)
    ? "issued"
    : text.includes(`${state}/approvals`)
      ? "approvals"
      : configs.some((dir) => text.includes(dir))
        ? "grants"
        : null;
  if (!registry) return null;
  const spans = command.replace(/[^\s'"|;&<>()]*\\[^\s'"|;&<>()]*/g, (word) =>
    word.replaceAll("\\", "/"),
  );
  const writes = shellWrites(spans);
  // A relative target lands in the dir a `cd` or `pushd` moved to.
  const moved = [
    "",
    ...[...spans.matchAll(/(?:^|[;&|(]\s*)(?:cd|pushd|chdir)\s+([^\s;&|)]+)/g)].map(
      (match) => `${match[1]}/`,
    ),
  ];
  const named = (target: string) =>
    moved.some((dir) => {
      const at = flat(/^(?:[a-z]:)?\//i.test(target) ? target : dir + target).replace(
        /\/\.?\//g,
        "/",
      );
      return registry === "grants"
        ? configs.some((cfg) => [cfg, `${cfg}/`, `${cfg}/workspaces.json`].includes(at))
        : at.includes(`${state}/${registry}`);
    });
  return writes.writes && (writes.targets === null || writes.targets.some(named)) ? registry : null;
};

const REGISTRY_DENY: Record<Registry, { label: string; what: string; unblock: string }> = {
  issued: {
    label: "issued-registry guard",
    what: "Workit's issued-session state",
    unblock:
      "Issued ids and tokens are written only by Workit's SubagentStart hook. Run the verifier or reviewer agent so the host issues its own session; never edit the issued registries by hand.",
  },
  approvals: {
    label: "approvals guard",
    what: "Workit's host-approval state",
    unblock:
      "Approval requests and the user's yes are written only by Workit: run `workit approve <id>` as its own call so the host asks the user, or ask the user to run it in their own terminal; never edit the approvals registry by hand.",
  },
  grants: {
    label: "config guard",
    what: "the user's Workit config (grants, roles, youtrack.writes)",
    unblock:
      "Only the user changes it: ask them to run `workit grant set <ws> <kind>=<value>` or `workit workspace set <ws> <key>=<value>` in a terminal outside this host. `workit grant show` and `workit workspace list` read it.",
  },
};

const registryDeny = ({ file, registry }: { file: string; registry: Registry }): HookDecision => {
  const { label, what, unblock } = REGISTRY_DENY[registry];
  // A placeholder (`<dir>/.workit-live-target`) names the dir it stands in.
  const named = path.basename(file).startsWith(".workit-") ? path.dirname(file) : file;
  return {
    kind: "deny",
    reason: `workit ${label}: ${named} is under ${what}. ${unblock}`,
    unblock,
  };
};

/**
 * Deny a working-tree edit while the branch task has unmet before-write
 * requirements. `paths` are the files the tool writes, or null when unknown
 * (a shell write, a patch whose headers cannot be read); unknown or empty
 * targets are gated, and an edit touching only exempt files is always allowed.
 * With `owner` (the hook's session), the live-session guard runs first, and
 * an allowed edit refreshes the owner's marker in each checkout it touches.
 */
export function writeGate(
  cwd: string,
  paths: readonly string[] | null,
  owner?: LiveOwner | null,
  deps?: LiveDeps,
): HookDecision {
  const forged = paths?.length ? registryTarget(cwd, paths) : null;
  if (forged) return registryDeny(forged);
  if (!owner) return beforeWriteGate(cwd, paths);
  const targets = liveTargets(cwd, paths);
  const live = liveGate(owner, targets, deps);
  if (live.kind !== "none") return live;
  const decision = beforeWriteGate(cwd, paths);
  if (decision.kind === "none") claimAll(owner, targets, deps);
  return decision;
}

/**
 * The write gates on one shell command: the live-session guard on its writes
 * and mutating git commands in the directories they run in, then the
 * before-write gate on its writes. A command that is only
 * `WORKIT_LIVE_SESSION=override <command>` skips the guard and leaves a
 * ledger row. An allowed mutation refreshes the owner's marker.
 */
export function shellGate(
  cwd: string,
  command: string,
  owner: LiveOwner | null,
  dialect: ShellDialect = "posix",
  deps?: LiveDeps,
): HookDecision {
  try {
    const windows = unquotedWindowsRegistry(command);
    const forged =
      registryTarget(cwd, shellMutationTargets(cwd, command, dialect, "registry")) ??
      (windows ? { file: `the ${windows} registry`, registry: windows } : null);
    if (forged) return registryDeny(forged);
  } catch {
    // The registry check is never dropped: a command it could not analyse that
    // names a guarded path is denied.
    const text = command.replaceAll("\\", "/").replace(/['"]/g, "").toLowerCase();
    if (
      /issued|approvals|workspaces\.json|\.config\/workit|state\/workit/.test(text) ||
      [resolveStateDir(), ...configDirs()].some((dir) =>
        text.includes(dir.replaceAll("\\", "/").toLowerCase()),
      )
    ) {
      const { unblock } = REGISTRY_DENY.grants;
      return {
        kind: "deny",
        reason: `workit registry guard: Workit could not analyse this command, which names a guarded path; split it into plain commands. ${unblock}`,
        unblock,
      };
    }
  }
  const writes = shellWrites(command);
  let targets: string[] = [];
  if (owner) targets = shellMutationTargets(cwd, command, dialect);
  if (owner && targets.length) {
    const live = liveGate(owner, targets, deps);
    if (live.kind !== "none") {
      if (!overridden(command, dialect)) return live;
      noteOverride(cwd, owner, command);
    }
  }
  const decision = writes.writes ? beforeWriteGate(cwd, writes.targets) : NONE;
  if (owner && targets.length && decision.kind === "none") claimAll(owner, targets, deps);
  return decision;
}

/** A ledger row for an override that let a command past the guard (managed repositories only). */
const noteOverride = (cwd: string, owner: LiveOwner, command: string): void => {
  try {
    if (!inWorkitWorkspace(cwd)) return;
    appendHookObserved(cwd, {
      type: "live_session.override",
      actor: { host: owner.host, session: owner.session, agentId: null },
      session: owner.session,
      command: command.slice(0, 200),
    });
  } catch {
    // A note never blocks the command.
  }
};

function beforeWriteGate(cwd: string, paths: readonly string[] | null): HookDecision {
  try {
    const gate = gateFor(cwd);
    if (!gate || gate.blockers.length === 0) return NONE;
    if (paths?.length && paths.every((file) => exempt(cwd, gate.root, file, gate.plans)))
      return NONE;
    const reasons = gate.blockers.map((item) => `${item.ruleId}: ${item.reason}`).join("; ");
    return {
      kind: "deny",
      reason: `workit before-write gate: ${reasons}. Markdown, docs/, plans/ and files outside the checkout stay writable.`,
      unblock: gate.blockers[0].reason,
    };
  } catch {
    return NONE;
  }
}
