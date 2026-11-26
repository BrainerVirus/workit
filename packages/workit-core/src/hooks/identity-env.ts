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
// The hosts' own variables (OPENCODE_SESSION_ID, PI_SESSION_ID, CODEX_THREAD_ID,
// CLAUDECODE, CLAUDE_CODE_ENTRYPOINT) name the host the CLI reads (#981): a
// change to one counts only in a command that runs `workit`.
import { shellScript } from "./delivery-verbs";
import { segmentsOf, type ShellDialect } from "./shell-words";
import { pastOptions, WRAPPERS } from "./write-gate";

const NAMES = "WORKIT_(?:AGENT_ID|HOST|SESSION_ID|SESSION_TOKEN)";
const HOST_NAMES =
  "(?:OPENCODE_SESSION_ID|PI_SESSION_ID|CODEX_THREAD_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)";
const IDENTITY = new RegExp(`^${NAMES}$`, "u");
const HOST_VARIABLE = new RegExp(`^${HOST_NAMES}$`, "u");
const powershell = (names: string): RegExp =>
  new RegExp(
    `\\$env:${names}\\b|env:[\\\\/]?${names}\\b|EnvironmentVariable\\(\\s*['"]${names}\\b`,
    "iu",
  );
const POWERSHELL = powershell(NAMES);
const POWERSHELL_HOST = powershell(HOST_NAMES);
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
const nameOf = (word: string | undefined): string => word?.split("=")[0] ?? "";
const named = (word: string | undefined): boolean =>
  IDENTITY.test(nameOf(word)) || HOST_VARIABLE.test(nameOf(word));
const isWorkit = (word: string | undefined): boolean => /^workit(?:-cli)?$/u.test(base(word));

/** What a command (and every script it nests) does to the identity variables. */
type Scan = {
  /** An identity name it sets, unsets or empties. */
  hit: string | null;
  /** A host's own session variable it sets, unsets or empties: matters only to a `workit` run. */
  hostHit: string | null;
  /** What it does that only a `workit` run makes matter: a cleared env or an argument Workit cannot read. */
  risky: string | null;
  /** Whether a segment runs `workit` (a command word, past assignments, wrappers and env's options). */
  runs: boolean;
};

const UNREADABLE = "env/unset arguments Workit cannot read";

/** Notes `word` (`NAME` or `NAME=value`) when it names an identity or host variable. */
const mark = (scan: Scan, word: string | undefined): void => {
  const name = nameOf(word);
  if (IDENTITY.test(name)) scan.hit ??= name;
  else if (HOST_VARIABLE.test(name)) scan.hostHit ??= name;
};

/** `env`'s arguments from `at`: its options by arity, assignments, then the command it runs. */
const scanEnv = (
  words: readonly string[],
  at: number,
  expands: ReadonlySet<number>,
  scan: Scan,
  depth: number,
): void => {
  const risky = (what: string) => void (scan.risky ??= what);
  const unset = (name: string | undefined) => {
    mark(scan, name);
  };
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
    scanEnv([...tokens, ...words.slice(rest)], 0, expanded, scan, depth + 1);
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
    if (/^[A-Za-z_]\w*=/u.test(word)) {
      unset(word);
      continue;
    }
    return commandAt(words.slice(index), scan);
  }
};

/** The command word of `words` (past wrappers and their assignments), and `env`'s arguments when it is env. */
const commandAt = (
  words: readonly string[],
  scan: Scan,
  expands: ReadonlySet<number> = new Set(),
  from = 0,
): void => {
  let index = from;
  while (index < words.length) {
    while (/^[A-Za-z_]\w*=/u.test(words[index] ?? "")) {
      mark(scan, words[index]);
      index += 1;
    }
    const name = base(words[index]).toLowerCase();
    if (name === "env") return scanEnv(words, index + 1, expands, scan, 0);
    if (OPAQUE.has(name)) return opaque(words.slice(index + 1), scan, true);
    // `busybox env`, `toybox env`: the applet is the command.
    if (name === "busybox" || name === "toybox") {
      index += 1;
      continue;
    }
    const takes = WRAPPERS[name];
    if (takes === undefined) break;
    index = pastOptions(words, index + 1, takes);
  }
  if (isWorkit(words[index])) scan.runs = true;
  // A command Workit does not know may run an `env` later in its words (`unshare`, `pkexec`,
  // `docker run x env …`): read like a wrapper it does not follow.
  else if (words.slice(index + 1).some((word) => base(word).toLowerCase() === "env"))
    opaque(words.slice(index + 1), scan, false);
};

/**
 * The words a wrapper Workit does not follow runs: when they run `workit`, any env change
 * in them (an `env`, a declare builtin, an assignment) is one it cannot read.
 */
const opaque = (rest: readonly string[], scan: Scan, assigns: boolean): void => {
  if (!rest.some(isWorkit)) return;
  scan.runs = true;
  const changes = (word: string) =>
    base(word).toLowerCase() === "env" ||
    DECLARES.has(word) ||
    (assigns && /^[A-Za-z_]\w*=/u.test(word));
  if (rest.some(changes)) scan.risky ??= UNREADABLE;
  const hit = rest.find(named);
  if (hit && rest.some((word) => base(word).toLowerCase() === "env")) mark(scan, hit);
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
    let at = 0;
    while (/^[A-Za-z_]\w*=/u.test(words[at] ?? "")) {
      mark(scan, words[at]);
      at += 1;
    }
    let declare = at;
    if (["builtin", "command"].includes(words[declare] ?? "")) declare += 1;
    if (DECLARES.has(words[declare] ?? "")) {
      for (let index = declare + 1; index < words.length; index += 1) {
        mark(scan, words[index]);
        if (expanded.has(index)) scan.risky ??= UNREADABLE;
      }
      continue;
    }
    commandAt(words, scan, expanded, at);
    const script = depth < 4 ? (shellScript(words) ?? loginScript(words)) : null;
    if (script) scanCommand(script, dialect, depth + 1, scan);
  }
};

/** The identity variable `command` changes, or what it does there Workit cannot read; null when neither. */
export const identityEnvChange = (
  command: string,
  dialect: ShellDialect = "posix",
): string | null => {
  if (
    !/WORKIT_|OPENCODE_SESSION_ID|PI_SESSION_ID|CODEX_THREAD_ID|CLAUDE|\b(?:env|unset|export|declare|typeset|local|readonly)\b/u.test(
      command,
    )
  )
    return null;
  if (dialect === "powershell")
    return (
      POWERSHELL.exec(command)?.[0] ??
      (/\bworkit\b/iu.test(command) ? (POWERSHELL_HOST.exec(command)?.[0] ?? null) : null)
    );
  const scan: Scan = { hit: null, hostHit: null, risky: null, runs: false };
  scanCommand(command, dialect, 0, scan);
  // A host variable, a cleared environment or an unreadable argument matters only to a workit call it runs.
  return scan.hit ?? (scan.runs ? (scan.hostHit ?? scan.risky) : null);
};

export const identityEnvDeny = (change: string): string =>
  `workit identity: ${change === UNREADABLE ? `this command runs workit with ${UNREADABLE}` : `this command changes ${change}`}. The host sets WORKIT_HOST, WORKIT_SESSION_ID, WORKIT_AGENT_ID and its own session variables, and Workit acts as who they name; run it without changing them (a verifier or reviewer passes the --session and --token its start text names).`;
