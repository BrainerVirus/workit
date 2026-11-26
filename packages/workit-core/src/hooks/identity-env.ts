// A shell command that changes the variables Workit reads its acting identity
// from (#883). On Claude Code and Codex the host sets them (SessionStart's
// WORKIT_HOST and WORKIT_SESSION_ID, the agent stamp's WORKIT_AGENT_ID): an
// agent that sets, unsets or empties one could make the CLI read another
// actor, or no host at all, and take a forged agent id. A guard against
// careless changes, not a sandbox: it reads a prefix assignment, `env` or
// `env.exe` (its options by arity, `-S` lines, `-i`, the assignments after
// `--`) behind write-gate.ts's wrappers and `busybox`/`toybox`, the declare
// builtins (`export`, `unset`, `declare`, `typeset`, `local`, `readonly`),
// `bash -c`, `su -c` and `script -c` scripts and PowerShell `$env:NAME`; in a
// command that runs `workit` it also refuses what it cannot read there (an
// unknown `env` option, an expanded argument or `-S` line, a cleared
// environment, an env change inside a wrapper it does not follow or after a
// command it does not know). It does not read `read`, `printf -v`, `${X:=}`, `for X in`,
// `source`, an interpreter, a script file or control flow (hosts.md#host-parity).
// What it misses binds no agent: on Claude Code and Codex a verdict counts
// only check rows a claimed stamp named (#972, ledger.ts sessionOwnsRun).
// Words, not text, so a `grep WORKIT_HOST` or a quoted mention passes.
// A prefix or `env` assignment changes only its own command, so it counts only
// when that command may run `workit` (`OPENCODE_SESSION_ID=x opencode run hi;
// workit status` runs); `export`, `unset` or a bare `NAME=x;` of an identity
// variable counts anywhere. The variables Workit finds its state and config
// dirs by (#980) count only where the change reaches a `workit` run: a prefix
// assignment for its own command, an `export`/`unset`/bare assignment for the
// whole command line. The CLI counts under its other names too (`workit-cli`,
// `@workit-dev/cli` with npx or bunx, its dist entry under node, a symlink to
// it), and a command word the shell builds fails closed beside such a change.
// PowerShell counts assignments, never reads; cmd's `set NAME=` counts too.
// The hosts' own variables (OPENCODE_SESSION_ID, PI_SESSION_ID, CODEX_THREAD_ID,
// CLAUDECODE, CLAUDE_CODE_ENTRYPOINT) name the host the CLI reads (#981): on
// Claude Code and Codex a change to one counts like a state variable's, only
// where it reaches a `workit` run.
import fs from "node:fs";
import path from "node:path";
import { shellScript } from "./delivery-verbs";
import { segmentsOf, type ShellDialect } from "./shell-words";
import { pastOptions, WRAPPERS } from "./write-gate";

const NAMES = "WORKIT_(?:AGENT_ID|HOST|SESSION_ID|SESSION_TOKEN)";
const IDENTITY = new RegExp(`^${NAMES}$`, "u");
const HOST_NAMES =
  "(?:OPENCODE_SESSION_ID|PI_SESSION_ID|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)";
const HOST_VARIABLE = new RegExp(`^${HOST_NAMES}$`, "u");
const IDENTITY_ANY = new RegExp(NAMES, "iu");
/** Where core/workit-paths.mjs finds the state and config dirs (#980): Workit's overrides, XDG, the home. */
const STATE_NAMES =
  "(?:WORKIT_(?:STATE_DIR|CONFIG(?:_DIR)?)|XDG_(?:STATE|CONFIG|DATA)_HOME|HOME|USERPROFILE|(?:LOCAL)?APPDATA)";
const STATE = new RegExp(`^${STATE_NAMES}$`, "u");
const STATE_ANY = new RegExp(STATE_NAMES, "iu");
/** PowerShell's changes to `names`: an `$env:` assignment, an item cmdlet on `env:NAME`, SetEnvironmentVariable. */
const powershell = (names: string) =>
  new RegExp(
    [
      `\\$\\{?env:${names}\\}?\\s*(?:[-+*/]|\\?\\?)?=(?!=)`,
      `${PS_ITEM}[^;|\\n]*?(?<![$\\w{])env:[\\\\/]?${names}\\b`,
      `SetEnvironmentVariable\\(\\s*['"]${names}\\b`,
    ].join("|"),
    "iu",
  );
/** Cmdlets and aliases that write an item, as in `Remove-Item env:NAME`. */
const PS_ITEM =
  "\\b(?:(?:Set|New|Remove|Clear|Rename|Move|Copy)-Item(?:Property)?|(?:Set|Add|Clear)-Content|si|ni|ri|rm|del|erase|rd|rmdir|cli|sc|ac|clc|rni|mi|move|mv|cpi|copy|cp|ren)\\b";
const POWERSHELL = powershell(NAMES);
const POWERSHELL_STATE = powershell(STATE_NAMES);
const POWERSHELL_HOST = powershell(HOST_NAMES);
/** PowerShell Workit cannot read beside a workit run: a computed env name, a dot-sourced script, iex. */
const POWERSHELL_OPAQUE = new RegExp(
  [
    `SetEnvironmentVariable\\(\\s*(?:[^'"\\s]|"[^"]*\\$)`,
    `${PS_ITEM}[^;|\\n]*?(?<![$\\w{])env:[\\\\/]?["']?[$(]`,
    `(?:^|[;&|{(\\n])\\s*\\.\\s+[^\\s.]`,
    `\\b(?:iex|Invoke-Expression)\\b`,
  ].join("|"),
  "iu",
);
/** cmd's `set NAME=` (`set "NAME=…"`, `set /a`, `set /p`). */
const cmdSet = (names: string) =>
  new RegExp(`(?:^|[&|(\\s"])set\\s+(?:/[ap]\\s+)?"?(${names})\\s*\\+?=`, "iu");
const CMD_IDENTITY = cmdSet(NAMES);
const CMD_STATE = cmdSet(STATE_NAMES);
const CMD_HOST = cmdSet(HOST_NAMES);
/** A `workit` run in a script's text: the name, or the package. */
const RUNS_TEXT = /\bworkit(?:-cli)?\b|@workit-dev[\\/]cli/iu;
/** Builtins that export, unset or declare the names after them. */
const DECLARES = new Set(["export", "unset", "declare", "typeset", "local", "readonly"]);
/** Wrappers Workit does not follow into: any env change inside one is unreadable to it. */
const OPAQUE = new Set([
  "watch",
  "strace",
  "chroot",
  "flock",
  "ssh",
  "su",
  "runuser",
  "script",
  "parallel",
]);
/** `env` short options that take a value (GNU -u -C -S -a, BSD -P), and those that take none. */
const ENV_VALUED = new Set(["u", "C", "S", "a", "P"]);
const ENV_FLAGS = new Set(["i", "0", "v"]);
const ENV_LONG_VALUED = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);
const ENV_LONG_FLAGS =
  /^--(?:ignore-environment|null|debug|(?:block|default|ignore)-signal(?:=.*)?)$/u;

/** A command's name: its last path part, without a Windows `.exe` (`C:\\Git\\usr\\bin\\env.exe`). */
const base = (word: string | undefined): string =>
  (word?.split(/[\\/]/u).at(-1) ?? "").replace(/\.exe$/iu, "");
const ASSIGN = /^[A-Za-z_]\w*\+?=/u;
const nameOf = (word: string | undefined): string =>
  (word?.split("=")[0] ?? "").replace(/\+$/u, "");
const named = (word: string | undefined): boolean => IDENTITY.test(nameOf(word));
const stateNamed = (word: string | undefined): boolean => STATE.test(nameOf(word));
/** The CLI under any of its names: `workit`, `workit-cli`, the plugin's `workit.js`, the package or its dist entry. */
const isWorkit = (word: string | undefined): boolean =>
  /^workit(?:-cli)?(?:\.[cm]?js)?$/u.test(base(word)) ||
  /@workit-dev[\\/]cli\b|workit-cli[\\/](?:dist|src)[\\/]/u.test(word ?? "");

/**
 * Whether the command word `word` is the CLI under another name: a path or a
 * PATH entry whose symlinks lead to it. Read only beside a state change.
 */
const linksToWorkit = (word: string, cwd: string | undefined): boolean => {
  const places = /[\\/]/u.test(word)
    ? [path.resolve(cwd ?? process.cwd(), word)]
    : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, word));
  for (const place of places) {
    try {
      const real = fs.realpathSync(place);
      return isWorkit(real);
    } catch {
      // Not here: the next PATH entry.
    }
  }
  return false;
};

/** What a command (and every script it nests) does to the identity variables. */
type Scan = {
  /** Whether identity names count (the hosts whose hooks stamp each agent, Claude Code and Codex). */
  identity: boolean;
  /** Where relative command words resolve (the hook's cwd). */
  cwd: string | undefined;
  /** An identity name it sets, unsets or empties. */
  hit: string | null;
  /** A state-location name changed for a command that runs `workit` (#980). */
  state: string | null;
  /** A state-location name changed for the rest of the command line (`export`, `unset`, `HOME=x;`). */
  shell: string | null;
  /** What it does that only a `workit` run makes matter: a cleared env or an argument Workit cannot read. */
  risky: string | null;
  /** Whether a segment runs `workit` (a command word, past assignments, wrappers and env's options). */
  runs: boolean;
  /** Every segment's command words, read for a renamed CLI only beside a state change. */
  words: Word[];
};

/** A command word, and whether the shell builds it (`"$(command -v workit)"`, `$W`). */
type Word = { word: string; built: boolean };

/** One command: a prefix or `env` assignment changes only its environment. */
type Seg = { identity: string | null; scoped: string | null; runs: boolean; words: Word[] };

const newSeg = (): Seg => ({ identity: null, scoped: null, runs: false, words: [] });

const UNREADABLE = "env/unset arguments Workit cannot read";

/**
 * Note `word` (`NAME`, `NAME=value`, `NAME+=value`) when it names an identity or a
 * state-location variable: for the segment `seg` only, or (null) the whole command line.
 */
const note = (scan: Scan, seg: Seg | null, word: string | undefined): void => {
  if (scan.identity && named(word)) {
    if (seg) seg.identity ??= nameOf(word);
    else scan.hit ??= nameOf(word);
  }
  // A host's own variable reaches the CLI as a state variable does: only through a workit run.
  if (!stateNamed(word) && !(scan.identity && HOST_VARIABLE.test(nameOf(word)))) return;
  if (seg) seg.scoped ??= nameOf(word);
  else scan.shell ??= nameOf(word);
};

/** Whether a command word may be the CLI under a name Workit cannot read: built by the shell, or a link to it. */
const mayBeWorkit = (words: readonly Word[], cwd: string | undefined): boolean =>
  words.some(({ word, built }) => built || linksToWorkit(word, cwd));

/** `env`'s arguments from `at`: its options by arity, assignments, then the command it runs. */
const scanEnv = (
  words: readonly string[],
  at: number,
  expands: ReadonlySet<number>,
  scan: Scan,
  seg: Seg,
  depth: number,
): void => {
  const risky = (what: string) => void (scan.risky ??= what);
  const unset = (name: string | undefined) => note(scan, seg, name);
  /** `-S line`: the line is more of env's arguments (a `$` or backtick in it is never read). */
  const split = (line: string | undefined, rest: number, built: boolean) => {
    if (line === undefined || depth >= 4) return risky(UNREADABLE);
    if (built || /[$`]/u.test(line)) risky(UNREADABLE);
    const tokens: string[] = [];
    const expanded = new Set<number>();
    try {
      for (const segment of segmentsOf(line)) {
        for (const index of segment.expands ?? []) expanded.add(tokens.length + index);
        tokens.push(...segment.words);
      }
    } catch {
      return risky(UNREADABLE);
    }
    scanEnv([...tokens, ...words.slice(rest)], 0, expanded, scan, seg, depth + 1);
  };
  // Past `--` only assignments and the command follow.
  let options = true;
  for (let index = at; index < words.length; index += 1) {
    const word = words[index] ?? "";
    // An argument the shell builds may be any option, assignment or the command.
    if (expands.has(index)) {
      risky(UNREADABLE);
      // A built `--split-string=…` or glued `-S…` still names what it runs.
      const built = options ? /^(?:--split-string=|-[\w]*S)(.+)$/su.exec(word) : null;
      if (built) return split(built[1], index + 1, true);
      continue;
    }
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word === "-") {
      risky("env -i");
      continue;
    }
    if (options && word.startsWith("--")) {
      const [name = "", value] = word.split(/=(.*)/su);
      if (name === "--ignore-environment") risky("env -i");
      else if (name === "--unset") unset(value ?? words[(index += 1)]);
      else if (name === "--split-string")
        return split(
          value ?? words[index + 1],
          index + (value === undefined ? 2 : 1),
          expands.has(index + (value === undefined ? 1 : 0)),
        );
      else if (ENV_LONG_VALUED.has(name)) index += value === undefined ? 1 : 0;
      else if (!ENV_LONG_FLAGS.test(word)) risky(UNREADABLE);
      continue;
    }
    if (options && word.startsWith("-") && word.length > 1) {
      for (let at2 = 1; at2 < word.length; at2 += 1) {
        const letter = word[at2] ?? "";
        if (letter === "i") risky("env -i");
        else if (ENV_FLAGS.has(letter)) continue;
        else if (ENV_VALUED.has(letter)) {
          const glued = word.slice(at2 + 1);
          if (!glued) index += 1;
          const value = glued || words[index];
          if (letter === "u") unset(value);
          if (letter === "S") return split(value, index + 1, expands.has(index));
          break;
        } else {
          risky(UNREADABLE);
          break;
        }
      }
      continue;
    }
    if (ASSIGN.test(word)) {
      unset(word);
      continue;
    }
    return commandAt(
      words.slice(index),
      scan,
      seg,
      new Set([...expands].filter((at2) => at2 >= index).map((at2) => at2 - index)),
    );
  }
};

/** The command word of `words` (past wrappers and their assignments), and `env`'s arguments when it is env. */
const commandAt = (
  words: readonly string[],
  scan: Scan,
  seg: Seg,
  expands: ReadonlySet<number> = new Set(),
  from = 0,
): void => {
  let index = from;
  while (index < words.length) {
    while (ASSIGN.test(words[index] ?? "")) {
      note(scan, seg, words[index]);
      index += 1;
    }
    const name = base(words[index]).toLowerCase();
    if (name === "env") return scanEnv(words, index + 1, expands, scan, seg, 0);
    if (OPAQUE.has(name)) return opaque(words.slice(index + 1), scan, seg, true);
    // `busybox env`, `toybox env`: the applet is the command.
    if (name === "busybox" || name === "toybox") {
      index += 1;
      continue;
    }
    const takes = WRAPPERS[name];
    if (takes === undefined) break;
    index = pastOptions(words, index + 1, takes);
  }
  const word = words[index];
  if (word === undefined) return;
  seg.words.push({ word, built: expands.has(index) });
  const rest = words.slice(index + 1);
  // The CLI by name, or a command that runs it later in its words (`xargs workit`, `npx @workit-dev/cli`).
  if (isWorkit(word) || rest.some(isWorkit)) seg.runs = true;
  // A command Workit does not know may run an `env` later in its words (`unshare`, `pkexec`,
  // `docker run x env …`): read like a wrapper it does not follow.
  if (!isWorkit(word) && rest.some((next) => base(next).toLowerCase() === "env"))
    opaque(rest, scan, seg, false);
  const program = base(word).toLowerCase();
  const shell = program === "pwsh" || program === "powershell";
  // `cmd /c "set NAME=…&& workit …"`, `pwsh -c '$env:NAME=…; workit …'`.
  if (program === "cmd" || shell) {
    const at = rest.findIndex((next) =>
      shell ? /^-(?:c|command)$/iu.test(next) : /^\/[ck]$/iu.test(next),
    );
    if (at >= 0) {
      const script = rest.slice(at + 1).join(" ");
      const change = shell ? powershellChange(script, scan.identity) : cmdChange(script, scan);
      if (change) scan.hit ??= change;
    }
  }
};

/**
 * The words a wrapper Workit does not follow runs: when they run `workit`, any env change
 * in them (an `env`, a declare builtin, an assignment) is one it cannot read.
 */
const opaque = (rest: readonly string[], scan: Scan, seg: Seg, assigns: boolean): void => {
  if (!rest.some(isWorkit)) return;
  seg.runs = true;
  const changes = (word: string) =>
    base(word).toLowerCase() === "env" || DECLARES.has(word) || (assigns && ASSIGN.test(word));
  if (rest.some(changes)) scan.risky ??= UNREADABLE;
  if (rest.some((word) => base(word).toLowerCase() === "env"))
    for (const word of rest) note(scan, seg, word);
};

/** Short options of `su`, `runuser` and util-linux `script` that take a value, `c` among them. */
const LOGIN_VALUED: Record<string, RegExp> = {
  su: /[sgGwc]/u,
  runuser: /[sgGwuc]/u,
  script: /[cEIOBTmot]/u,
};

/**
 * The script `su -c "…"`, `runuser -lc "…"` or `script -qc "…"` runs, read like a `bash -c`
 * script. A short-option cluster reads as getopt reads it: its first option that takes a value
 * ends it, and when that option is `c`, the rest of the cluster or else the next word is the script.
 */
const loginScript = (words: readonly string[]): string | null => {
  const at = words.findIndex((word) => /^(?:su|runuser|script)$/u.test(base(word)));
  if (at < 0) return null;
  const valued = LOGIN_VALUED[base(words[at])] ?? /c/u;
  for (let index = at + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--command") return words[index + 1] ?? null;
    if (word.startsWith("--command=")) return word.slice("--command=".length);
    if (!/^-[^-]/u.test(word)) continue;
    const ends = word.slice(1).search(valued) + 1;
    if (ends > 0 && word[ends] === "c") return word.slice(ends + 1) || (words[index + 1] ?? null);
  }
  return null;
};

const scanCommand = (command: string, dialect: ShellDialect, depth: number, scan: Scan): void => {
  let segments;
  try {
    segments = segmentsOf(command, dialect);
  } catch {
    return;
  }
  for (const { words, expands = [] } of segments) {
    const expanded = new Set(expands);
    const seg = newSeg();
    let at = 0;
    while (ASSIGN.test(words[at] ?? "")) at += 1;
    // `HOME=/x` alone sets a variable the shell already exports: the rest of the line sees it.
    for (const word of words.slice(0, at)) note(scan, at === words.length ? null : seg, word);
    let declare = at;
    if (["builtin", "command"].includes(words[declare] ?? "")) declare += 1;
    if (DECLARES.has(words[declare] ?? "")) {
      for (let index = declare + 1; index < words.length; index += 1) {
        note(scan, null, words[index]);
        if (expanded.has(index)) scan.risky ??= UNREADABLE;
      }
      continue;
    }
    commandAt(words, scan, seg, expanded, at);
    const script = depth < 4 ? (shellScript(words) ?? loginScript(words)) : null;
    if (script) {
      // A script this command runs sees its prefix assignments.
      const before = scan.runs;
      scan.runs = false;
      scanCommand(script, dialect, depth + 1, scan);
      seg.runs ||= scan.runs;
      scan.runs ||= before;
    }
    scan.words.push(...seg.words);
    // A prefix or `env` assignment reaches only this command: it counts when that command may run workit.
    const reaches = () => seg.runs || mayBeWorkit(seg.words, scan.cwd);
    if (seg.identity && reaches()) scan.hit ??= seg.identity;
    if (seg.scoped && reaches()) scan.state ??= seg.scoped;
    scan.runs ||= seg.runs;
  }
};

/** cmd's `set NAME=` of an identity variable (always) or a state variable (beside a workit run). */
const cmdChange = (script: string, scan: Pick<Scan, "identity">): string | null =>
  (scan.identity ? CMD_IDENTITY.exec(script)?.[1] : null) ??
  (RUNS_TEXT.test(script)
    ? (CMD_STATE.exec(script)?.[1] ?? (scan.identity ? CMD_HOST.exec(script)?.[1] : null) ?? null)
    : null);

/**
 * What PowerShell `command` changes: an identity variable (on a stamping host), a
 * state variable beside a workit run, or what Workit cannot read there. Reads
 * (`Write-Host $env:HOME`, `cd $env:USERPROFILE\proj`) never count.
 */
const powershellChange = (command: string, identity: boolean): string | null => {
  const hit = identity ? POWERSHELL.exec(command)?.[0] : null;
  if (hit) return hit;
  // The CLI by name, or a call operator on a built command (`& $w`, `& (Get-Command x)`).
  if (!RUNS_TEXT.test(command) && !/&\s*[$(]/u.test(command)) return null;
  const state =
    POWERSHELL_STATE.exec(command)?.[0] ??
    (identity ? POWERSHELL_HOST.exec(command)?.[0] : null) ??
    cmdChange(command, { identity });
  if (state) return state;
  return POWERSHELL_OPAQUE.test(command) ? UNREADABLE : null;
};

/**
 * The identity variable `command` changes, the state-location variable a
 * command that runs `workit` changes, or what it does there Workit cannot
 * read; null when none. `identity: false` (a host whose hooks stamp no agent)
 * reads only the state-location variables.
 */
export const identityEnvChange = (
  command: string,
  dialect: ShellDialect = "posix",
  options: { identity?: boolean; cwd?: string } = {},
): string | null => {
  const identity = options.identity ?? true;
  // PowerShell is read by regexes alone: a dot-sourced profile names no variable.
  if (dialect === "powershell") return powershellChange(command, identity);
  if (
    !/WORKIT_|XDG_|HOME|USERPROFILE|APPDATA|OPENCODE_SESSION_ID|PI_SESSION_ID|CODEX_THREAD_ID|CLAUDE|EnvironmentVariable|\b(?:env|unset|export|declare|typeset|local|readonly)\b/iu.test(
      command,
    )
  )
    return null;
  const scan: Scan = {
    identity,
    cwd: options.cwd,
    hit: null,
    state: null,
    shell: null,
    risky: null,
    runs: false,
    words: [],
  };
  scanCommand(command, dialect, 0, scan);
  if (scan.hit) return scan.hit;
  if (scan.state) return scan.state;
  // An `export`/`unset` reaches every later command: any workit run, or a command word that may be one.
  if (scan.shell && (scan.runs || mayBeWorkit(scan.words, scan.cwd))) return scan.shell;
  // A cleared environment or an unreadable argument matters only to a workit call it runs.
  return scan.runs ? scan.risky : null;
};

export const identityEnvDeny = (change: string): string => {
  if (change === UNREADABLE || IDENTITY_ANY.test(change) || !STATE_ANY.test(change))
    return `workit identity: ${change === UNREADABLE ? `this command runs workit with ${UNREADABLE}` : `this command changes ${change}`}. The host sets WORKIT_HOST, WORKIT_SESSION_ID, WORKIT_AGENT_ID and its own session variables, and Workit acts as who they name; run it without changing them (a verifier or reviewer passes the --session and --token its start text names).`;
  return `workit identity: this command runs workit with ${change} changed. Workit reads issued sessions, grants and its ledger trust from the state and config dirs the host's environment names, so a workit call may not move them (#980); run it without setting, unsetting or emptying ${change}.`;
};
