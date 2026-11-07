// The before-write gate (S17). With no writer lease, a branch task's unmet
// before-write requirements (an open product choice, a missing plan) deny
// working-tree edits where the host has a pre-write hook, naming the exact
// unblock. History moves (commit, merge, rebase, stash pop) are not edits.
// Reads only the task index, one task snapshot and the ledger; never
// migrates, never captures a candidate, and fails open on any state error.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSignature, TaskStore } from "../core/task-store";
import { latestJudgment, writeBlockers, type WriteBlocker } from "../core/policy/derive";
import { applicableDecision } from "../core/task-evaluation";
import {
  claimLiveSession,
  liveConflict,
  type LiveConflict,
  type LiveDeps,
  type LiveOwner,
} from "../core/live-session";
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
      const target = args.indexOf("-t");
      if (target >= 0) return args[target + 1] ? [args[target + 1]] : null;
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

/** A `bash -c '<script>'` (any SCRIPT_SHELLS) script, else null. */
const shellScript = (words: readonly string[]): string | null => {
  if (!SCRIPT_SHELLS.has((words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase())) return null;
  // Options may come before `-c` (`bash --norc -c`, `sh -e -c`); the script follows it.
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (/^-[a-z]*c$/.test(word)) return words[index + 1] ?? null;
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
  if (name === "unlink" || name === "shred") return listed(files);
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
    return inlineWrites(scriptOf(input.length - args.length + at + 1), name) ? ["."] : null;
  };
  if (name === "perl") return inline(/^-[a-zA-Z]*[eE]$/);
  if (/^(?:python[\d.]*|node|bun|deno|ruby|php)$/.test(name))
    return inline(/^-[a-zA-Z]*[ce]$|^--eval$|^-p$/);
  return shellScript(words) === null ? null : ["."];
};

/** Calls and names an inline script uses to write files, run commands or hide either. */
const WRITE_NAME =
  /^(?:\w*(?:write|append|unlink|rmdir|mkdir|mkdtemp|makedirs|removedirs|rename|truncate|symlink|chmod|chown|utime|copyfile|copytree|rmtree|spawn|popen|subprocess|child_process|passthru|shell_exec|proc_open|execsync|execfile|system|fork|runin|o_wronly|o_rdwr|o_creat|o_trunc|o_append)\w*|exec[lv]\w*|rm|rmsync|rm_f|rm_r|rm_rf|remove|cp|cpsync|link|linksync|touch|eval|exec|__import__|importlib|getattr|setattr|globals|__builtins__|builtins|binding|dlopen|ctypes|dump|delete|fileutils|shutil|tofile|savetxt|save|savefig|to_csv|to_json|to_excel|to_parquet|to_pickle)$/;
/** `open(f, 'w')`, `Path(f).open('a')`, `new Function(…)`, `Bun.$`, `Deno.run`. */
const WRITE_TEXT =
  /,\s*(?:mode\s*=\s*)?["'](?:[rbtU]*[wax][rbtU+]*|[rbtU]*\+[rbtU]*)["']\s*[,)]|\.open\s*\(\s*(?:mode\s*=\s*)?["'][rbtU]*[wax+][rbtU+]*["']|\bFunction\s*\(|\bnew\s+Function\b|\bBun\.\$|\bDeno\.(?:run|Command)\b/;

/**
 * Whether an interpreter's inline script (`python3 -c`, `node -e|-p`,
 * `ruby -e`, `perl -e`) may write: it names a write, process or dynamic-code
 * call, opens a file for writing, or its text is unknown (undefined). A script file
 * (`node x.mjs`) is not judged, so neither is a script that only reads.
 */
const inlineWrites = (script: string | undefined, interpreter: string): boolean => {
  if (script === undefined) return true;
  const text = script
    .replace(/\b(?:sys\.|process\.)?std(?:out|err)(?:\.buffer)?\.write(?:lines)?\b/g, "")
    .replace(/\.exec\s*\(/g, ".match(");
  if (WRITE_TEXT.test(text)) return true;
  if (/^(?:perl|ruby|php)$/.test(interpreter) && /`|%x|\bqx\b|\bopen\b/.test(text)) return true;
  return (text.match(/[A-Za-z_$][\w$]*/g) ?? []).some((word) =>
    WRITE_NAME.test(word.toLowerCase()),
  );
};

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
  const store = new TaskStore(cwd);
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
): string | undefined => {
  const lost = strict ? UNKNOWN_DIR : undefined;
  const found = words.slice(1).find((word) => !word.startsWith("-") || word === "-");
  const named = found === undefined ? undefined : expandVars(found, vars);
  // Only a leading `~` or `$HOME` expands; a mid-path `~` is literal (Windows 8.3
  // short names like RUNNER~1).
  const target = named === undefined ? undefined : homeExpanded(named);
  if (target === "-" || (target && /^~|[$`*?]/.test(target))) return lost;
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
  while (start < words.length && COMPOUND.has(words[start])) start++;
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
 * sequence, or `export NAME=literal`, is substituted.
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
 * (URI-encoded, one path segment).
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

const unknownVarTarget = (text: string): string =>
  path.join(UNKNOWN_VAR, encodeURIComponent(unresolvedRefs(text).join(" ") || text));

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
    const applied = values?.map((item) => applyOperator(item, match[2] ?? ""));
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
  strict = false,
  inherited: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const targets: string[] = [];
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
  const assigned = (value: string): string | null => {
    const made = mktempPath(value, dir);
    if (made !== null) return made;
    const all = expansions(value, vars, loops).map(homeExpanded);
    return all.length === 1 && unresolvedRefs(all[0]).length === 0 ? all[0] : null;
  };
  for (const segment of segments) {
    if (segment.group === "open") {
      groups.push({ dir, stack: [...stack], vars: new Map(vars), loops: new Map(loops) });
      continue;
    }
    if (segment.group === "close") {
      const saved = groups.pop();
      if (saved) ({ dir, stack, vars, loops } = saved);
      continue;
    }
    const body = commandWords(segment.words);
    const keywords = segment.words.length - body.length;
    for (const keyword of segment.words.slice(0, keywords))
      if (OPENS.has(keyword)) nesting++;
      else if (CLOSES.has(keyword)) nesting = Math.max(0, nesting - 1);
    const loop = segment.words.slice(0, keywords).lastIndexOf("for");
    if (loop >= 0) {
      const [name = "", keyword, ...items] = segment.words.slice(loop + 1);
      const expanding = new Set(segment.expands ?? []);
      const literal =
        keyword === "in" && items.every((_, index) => !expanding.has(loop + 3 + index));
      vars.delete(name);
      if (literal && !untrusted.all && !untrusted.names.has(name))
        loops.set(name, items.map(homeExpanded));
      else loops.delete(name);
      continue;
    }
    const lead = body.findIndex((word) => !/^\w+=/.test(word));
    const words = lead < 0 ? [] : body.slice(lead);
    const offset = keywords + lead;
    if (!segment.conditional && !untrusted.all)
      for (const [key, value] of assignmentsOf(segment.words))
        if (!untrusted.names.has(key)) {
          loops.delete(key);
          const resolved = assigned(value);
          if (resolved === null) vars.delete(key);
          else vars.set(key, resolved);
        }
    const name = (words[0]?.split(/[\\/]/).at(-1) ?? "").toLowerCase();
    // A directory change inside a loop or conditional body may or may not run.
    const moves = CD.has(name) || PUSHD.has(name) || POPD.has(name);
    if (moves && strict && nesting > 0) {
      dir = UNKNOWN_DIR;
      continue;
    }
    if (moves && keywords > 0) continue;
    if (CD.has(name)) {
      dir = cdInto(dir, words, strict, vars);
      continue;
    }
    if (PUSHD.has(name)) {
      stack.push(dir);
      dir = cdInto(dir, words, strict, vars);
      continue;
    }
    if (POPD.has(name)) {
      dir = stack.length ? stack.pop() : strict ? UNKNOWN_DIR : undefined;
      continue;
    }
    const inner = depth < 4 ? (wrappedScript(words) ?? (strict ? shellScript(words) : null)) : null;
    if (inner !== null && dir !== undefined)
      for (const runIn of workitRunDir(dir, words, atAll))
        targets.push(...segmentTargets(runIn, inner, "posix", depth + 1, strict, vars));
    if (strict && dir !== undefined) {
      const runIn = dir;
      for (const sub of depth < 4 ? (segment.subs ?? []) : [])
        targets.push(...segmentTargets(runIn, sub, dialect, depth + 1, true, vars));
      const expanding = new Set(segment.expands ?? []);
      const scriptOf = (index: number): string | undefined => {
        const word = words[index];
        if (word === undefined || !expanding.has(offset + index)) return word;
        const all = expansions(word, vars, loops);
        return all.length === 1 && unresolvedRefs(all[0]).length === 0 ? all[0] : undefined;
      };
      const opaque = segment.unanalyzable
        ? ["."]
        : inner === null
          ? opaqueWrites(words, scriptOf)
          : null;
      for (const file of opaque ?? [])
        for (const resolved of atAll(file))
          targets.push(file === "." ? path.join(resolved, DIR_TARGET) : resolved);
      const ln = words.findIndex((word) => /^ln$/i.test(word.split(/[\\/]/).at(-1) ?? ""));
      if (ln >= 0 && words.slice(0, ln).every((word) => PREFIXES.has(word)))
        targets.push(...linkSources(words.slice(ln + 1), at));
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
  strict = false,
): string[] => {
  try {
    return [
      ...segmentTargets(cwd, command, dialect, 0, strict),
      ...gitMutationDirs(cwd, command, dialect).map((dir) => path.join(dir, DIR_TARGET)),
    ];
  } catch {
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

// --- the issued-registry guard (#292) ---------------------------------------

/**
 * The files an agent tool call writes under `<state>/issued*`: the issued-id
 * records and their token hashes. Only the hook and the CLI write there; an
 * agent that could would forge an issued session or token by hand.
 */
const issuedTarget = (cwd: string, targets: readonly string[]): string | null => {
  const state = resolveStateDir();
  const found = targets.find((target) =>
    underIssued(state, cwd, homeExpanded(target), process.platform, canonical),
  );
  return found ?? null;
};

/**
 * Whether `target` (resolved against `cwd`) is `<state>/issued*` or inside
 * it. Pure over `platform`, so Windows shapes are testable anywhere: mixed
 * `\` and `/`, drive-letter case, and the `/c/Users/...` form a POSIX shell
 * on Windows uses. `real` resolves symlinks and 8.3 short names (RUNNER~1) on
 * the live platform.
 */
export const underIssued = (
  state: string,
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real: (file: string) => string = (file) => file,
): boolean => {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const fold = (value: string) => (win || platform === "darwin" ? value.toLowerCase() : value);
  const named = win ? target.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:") : target;
  const relative = p.relative(fold(real(p.resolve(state))), fold(real(p.resolve(cwd, named))));
  if (relative.startsWith("..") || p.isAbsolute(relative)) return false;
  return relative.split(p.sep)[0].startsWith("issued");
};

/**
 * A POSIX shell drops an unquoted `\` before the analysis sees the words, so
 * `> C:\state\issued\x` loses its separators. On Windows, a command that
 * writes and spells out the registry path is denied.
 */
const unquotedWindowsIssued = (command: string): boolean => {
  if (process.platform !== "win32" || !command.includes("\\")) return false;
  const flat = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  return flat(command).includes(`${flat(resolveStateDir())}/issued`) && shellWrites(command).writes;
};

const issuedDeny = (file: string): HookDecision => {
  const unblock =
    "Issued ids and tokens are written only by Workit's SubagentStart hook. Run the verifier or reviewer agent so the host issues its own session; never edit the issued registries by hand.";
  return {
    kind: "deny",
    reason: `workit issued-registry guard: ${file} is under Workit's issued-session state. ${unblock}`,
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
  const forged = paths?.length ? issuedTarget(cwd, paths) : null;
  if (forged) return issuedDeny(forged);
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
    const forged =
      issuedTarget(cwd, segmentTargets(cwd, command, dialect)) ??
      (unquotedWindowsIssued(command) ? "the issued registry" : null);
    if (forged) return issuedDeny(forged);
  } catch {
    // Fail open, like the other shell analyses here.
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
