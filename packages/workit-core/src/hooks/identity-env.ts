// A shell command that changes the variables Workit reads its acting identity
// from (#883). On Claude Code and Codex the host sets them (SessionStart's
// WORKIT_HOST and WORKIT_SESSION_ID, the agent stamp's WORKIT_AGENT_ID): an
// agent that sets, unsets or empties one could make the CLI read another
// actor, or no host at all, and take a forged agent id. A guard against
// careless changes, not a sandbox: it reads a prefix assignment, `env` (its
// options by arity, `-S` lines, `-i`), the declare builtins (`export`,
// `unset`, `declare`, `typeset`, `local`, `readonly`), `bash -c` scripts and
// PowerShell `$env:NAME`; in a command that runs `workit` it also refuses
// what it cannot read there (an unknown `env` option, an expanded argument,
// a cleared environment). It does not read `read`, `printf -v`, `${X:=}`,
// `for X in`, `source`, an interpreter or a script file (hosts.md#host-parity).
// Words, not text, so a `grep WORKIT_HOST` or a quoted mention passes.
import { shellScript } from "./delivery-verbs";
import { segmentsOf, type ShellDialect } from "./shell-words";

const NAMES = "WORKIT_(?:AGENT_ID|HOST|SESSION_ID|SESSION_TOKEN)";
const IDENTITY = new RegExp(`^${NAMES}$`, "u");
const POWERSHELL = new RegExp(
  `\\$env:${NAMES}\\b|env:[\\\\/]?${NAMES}\\b|EnvironmentVariable\\(\\s*['"]${NAMES}\\b`,
  "iu",
);
/** Builtins that export, unset or declare the names after them. */
const DECLARES = new Set(["export", "unset", "declare", "typeset", "local", "readonly"]);
/** Commands that run the rest of their words (their options skipped; `timeout` takes a duration). */
const WRAPPERS = new Set([
  "sudo",
  "nohup",
  "command",
  "builtin",
  "exec",
  "timeout",
  "nice",
  "time",
]);
/** `env` short options that take a value (GNU -u -C -S -a, BSD -P), and those that take none. */
const ENV_VALUED = new Set(["u", "C", "S", "a", "P"]);
const ENV_FLAGS = new Set(["i", "0", "v"]);
const ENV_LONG_VALUED = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);
const ENV_LONG_FLAGS =
  /^--(?:ignore-environment|null|debug|(?:block|default|ignore)-signal(?:=.*)?)$/u;

const base = (word: string | undefined): string => word?.split(/[\\/]/u).at(-1) ?? "";
const named = (word: string | undefined): boolean => IDENTITY.test(word?.split("=")[0] ?? "");
const isWorkit = (word: string | undefined): boolean => /^workit(?:-cli)?$/u.test(base(word));

/** What a command (and every script it nests) does to the identity variables. */
type Scan = {
  /** An identity name it sets, unsets or empties. */
  hit: string | null;
  /** What it does that only a `workit` run makes matter: a cleared env or an argument Workit cannot read. */
  risky: string | null;
  /** Whether a segment runs `workit` (a command word, past assignments, wrappers and env's options). */
  runs: boolean;
};

const UNREADABLE = "env/unset arguments Workit cannot read";

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
    if (named(name)) scan.hit ??= name ?? null;
  };
  /** `-S line`: the line is more of env's arguments (env expands `${…}` in it itself). */
  const split = (line: string | undefined, rest: number) => {
    if (line === undefined || line.includes("$") || depth >= 4) return risky(UNREADABLE);
    let tokens: string[] = [];
    try {
      tokens = segmentsOf(line).flatMap((segment) => segment.words);
    } catch {
      return risky(UNREADABLE);
    }
    scanEnv([...tokens, ...words.slice(rest)], 0, new Set(), scan, depth + 1);
  };
  for (let index = at; index < words.length; index += 1) {
    const word = words[index] ?? "";
    // An argument the shell builds may be any option, assignment or the command.
    if (expands.has(index)) {
      risky(UNREADABLE);
      continue;
    }
    if (word === "--") return commandAt(words.slice(index + 1), scan);
    if (word === "-") {
      risky("env -i");
      continue;
    }
    if (word.startsWith("--")) {
      const [name = "", value] = word.split(/=(.*)/su);
      if (name === "--ignore-environment") risky("env -i");
      else if (name === "--unset") unset(value ?? words[(index += 1)]);
      else if (name === "--split-string")
        return split(value ?? words[index + 1], index + (value === undefined ? 2 : 1));
      else if (ENV_LONG_VALUED.has(name)) index += value === undefined ? 1 : 0;
      else if (!ENV_LONG_FLAGS.test(word)) risky(UNREADABLE);
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at2 = 1; at2 < word.length; at2 += 1) {
        const letter = word[at2] ?? "";
        if (letter === "i") risky("env -i");
        else if (ENV_FLAGS.has(letter)) continue;
        else if (ENV_VALUED.has(letter)) {
          const glued = word.slice(at2 + 1);
          const value = glued || words[(index += 1)];
          if (letter === "u") unset(value);
          if (letter === "S") return split(value, index + 1);
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

/** The command word of `words` (past wrappers), and `env`'s arguments when it is env. */
const commandAt = (
  words: readonly string[],
  scan: Scan,
  expands: ReadonlySet<number> = new Set(),
  from = 0,
): void => {
  let index = from;
  while (index < words.length) {
    const name = base(words[index]);
    if (name === "env") return scanEnv(words, index + 1, expands, scan, 0);
    if (!WRAPPERS.has(name)) break;
    index += 1;
    while (words[index]?.startsWith("-")) index += 1;
    if (name === "timeout" && words[index] !== undefined) index += 1;
  }
  if (isWorkit(words[index])) scan.runs = true;
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
      if (named(words[at])) scan.hit ??= words[at]?.split("=")[0] ?? null;
      at += 1;
    }
    let declare = at;
    if (["builtin", "command"].includes(words[declare] ?? "")) declare += 1;
    if (DECLARES.has(words[declare] ?? "")) {
      for (let index = declare + 1; index < words.length; index += 1) {
        if (named(words[index])) scan.hit ??= words[index]?.split("=")[0] ?? null;
        if (expanded.has(index)) scan.risky ??= UNREADABLE;
      }
      continue;
    }
    commandAt(words, scan, expanded, at);
    const script = depth < 4 ? shellScript(words) : null;
    if (script) scanCommand(script, dialect, depth + 1, scan);
  }
};

/** The identity variable `command` changes, or what it does there Workit cannot read; null when neither. */
export const identityEnvChange = (
  command: string,
  dialect: ShellDialect = "posix",
): string | null => {
  if (!/WORKIT_|\b(?:env|unset|export|declare|typeset|local|readonly)\b/u.test(command))
    return null;
  if (dialect === "powershell") return POWERSHELL.exec(command)?.[0] ?? null;
  const scan: Scan = { hit: null, risky: null, runs: false };
  scanCommand(command, dialect, 0, scan);
  // A cleared environment or an unreadable argument matters only to a workit call it runs.
  return scan.hit ?? (scan.runs ? scan.risky : null);
};

export const identityEnvDeny = (change: string): string =>
  `workit identity: ${change === UNREADABLE ? `this command runs workit with ${UNREADABLE}` : `this command changes ${change}`}. The host sets WORKIT_HOST, WORKIT_SESSION_ID and WORKIT_AGENT_ID, and Workit acts as who they name; run it without changing them (a verifier or reviewer passes the --session and --token its start text names).`;
