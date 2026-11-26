// The Workit verbs a host may run without asking (issue #297, decision
// mvk5q3io): delivery and state verbs whose own gates (grants, non-author
// verdicts, branch policy) decide. One list for every host's permission
// block: Claude Code `Bash(workit <verb> *)`, Codex `prefix_rule`, Cursor
// `Shell(workit <verb>)`, and the OpenCode plugin's ask-to-allow.
//
// `ps` and `stop` (the process registry, #328) list and stop only the
// processes this session's family owns. Never listed: verbs that run an
// arbitrary command (`check -- <cmd>`, `lock run -- <cmd>`, `run --bg -- <cmd>`,
// `test-audit`, `fanout check`), change authority
// (`grant`), install or remove host config (`init`, `upgrade`, `setup`,
// `uninstall`, `launch`), delete data (`gc`), import state (`state`) or write
// outside the forge flow (`youtrack`, `changelog`, `knowledge`, `handoff`).
// Pure string work: the OpenCode plugin bundles it.
import { segmentsOf, type ShellDialect } from "./shell-words";

export const WORKIT_ALLOWED_VERBS = [
  "git",
  "pr",
  "ci",
  "stack",
  "release",
  "task",
  "ledger",
  "evidence",
  "finding",
  "decision",
  "worker",
  "verify-delivery",
  "policy",
  "doctor",
  "help",
  "ps",
  "stop",
] as const;

/**
 * Flags that override a Workit gate: a host never allows them unasked.
 * Workit has no `--admin` flag and refuses a bare `--force` push itself.
 */
export const WORKIT_BYPASS_FLAGS = ["--unverified", "--overwrite-unintegrated"] as const;

/**
 * Calls only the user runs (issue #615; `ledger void`, #759; `approve`, the host-approval
 * channel, where Claude Code's hook asks with the rendered request; `setup`, `uninstall`,
 * `install` and `workspace seal` as whole verbs, `--preview` and `--dry-run` included,
 * because they write host config, grants or seals). The CLI's TTY and agent-marker check
 * deters a cooperating agent; the host's prompt is what stops a determined
 * one, so no host rule or hook allow may cover these. `release` is an allowed
 * verb and `release notes approve` is inside it, so each host also asks or
 * denies these words explicitly.
 */
export const WORKIT_USER_ONLY: readonly (readonly string[])[] = [
  ["release", "notes", "approve"],
  ["grant", "set"],
  ["grant", "raise"],
  ["ledger", "void"],
  ["approve"],
  ["setup"],
  ["uninstall"],
  ["install"],
  ["workspace", "seal"],
];

/**
 * `workit feedback` (#777): a report to the Workit tracker the host always
 * asks about. Host rules match its plain spelling; the hook reads the others.
 */
export const WORKIT_ASKED_VERBS = ["feedback"] as const;

/** A user-only call's or an asked verb's first word, as a word anywhere in a text. */
export const USER_ONLY_WORD = new RegExp(
  `\\b(?:${[...new Set([...WORKIT_USER_ONLY.map((words) => words[0]), ...WORKIT_ASKED_VERBS])].join("|")})\\b`,
);

/**
 * Whether `text` may run a user-only Workit call: the word `workit` and a
 * user-only first word anywhere, read with quotes and backslashes removed
 * (and again with backticks removed), backslash-newlines joined first; a `$'…'` or
 * `$"…"` spelling counts as any word. The one test the gate starts with and
 * both launchers copy byte for byte (docs/agents/hosts.md): never a list of
 * positions, wrappers or global options.
 */
export const mayRunUserOnly = (text: string): boolean => {
  const joined = text.replace(/\\\r?\n/g, "");
  const bare = joined.replace(/['"\\]/g, "");
  return [bare, bare.replace(/`/g, "")].some(
    (all) => /\bworkit\b/.test(all) && (USER_ONLY_WORD.test(all) || /\$['"]/.test(joined)),
  );
};

const ALLOWED = new Set<string>(WORKIT_ALLOWED_VERBS);

/** Do `needle`'s words appear in order in `words` (flags and values between them still match)? */
const hasWordsInOrder = (words: readonly string[], needle: readonly string[]): boolean => {
  let at = 0;
  for (const word of words) if (word === needle[at] && (at += 1) === needle.length) return true;
  return false;
};

const isBypass = (word: string): boolean =>
  WORKIT_BYPASS_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));

/** `workit`, `workit-cli`, either by path, or the CLI package `npx`/`bunx` runs (`@workit-dev/cli[@v]`). */
const isWorkitWord = (word: string): boolean =>
  /^(?:(?:.*[\\/])?workit(?:-cli)?|@workit-dev\/cli(?:@[\w.-]+)?)$/u.test(word);

/** Where the verb starts in the words after `workit`: global `--json`, `--cwd`, `--session` skipped. */
const verbAt = (words: readonly string[]): number => {
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === "--json") at += 1;
    else if (word === "--cwd" || word === "--session") at += 2;
    else if (word?.startsWith("--cwd=") || word?.startsWith("--session=")) at += 1;
    else return at;
  }
};

/** Commands that run the rest of their words as a command. */
const WRAPPERS = new Set(["env", "sudo", "nohup", "command", "timeout", "nice", "exec"]);
/** Wrapper options that take a value (`env -u X`, `sudo -u root`, `timeout -s KILL`, `nice -n 5`). */
const VALUED = /^-(?:[ugnskCpD]|-user|-group|-signal|-kill-after|-unset|-chdir)$/u;

/** `words` past env assignments and wrappers (`env X=1`, `sudo -u u`, `timeout 9`, `nohup`). */
export const unwrapped = (words: readonly string[]): readonly string[] => {
  let at = 0;
  for (;;) {
    const word = words[at] ?? "";
    const name = word.split("/").at(-1) ?? "";
    if (/^[A-Za-z_]\w*=/u.test(word)) at += 1;
    else if (WRAPPERS.has(name)) {
      at += 1;
      while (words[at]?.startsWith("-")) at += VALUED.test(words[at] ?? "") ? 2 : 1;
      if (name === "timeout" && words[at] !== undefined) at += 1;
    } else return words.slice(at);
  }
};

/** The script a shell runs with `-c` (`bash -c "…"`, `sudo sh -lc -- '…'`) or `eval` runs, or null. */
const shellScript = (all: readonly string[]): string | null => {
  const words = unwrapped(all);
  const name = words[0]?.split("/").at(-1) ?? "";
  if (name === "eval") return words.slice(1).join(" ") || null;
  if (!/^(?:ba|z|da|k)?sh$/u.test(name)) return null;
  const flag = words.findIndex((word, at) => at > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
  if (flag < 0) return null;
  return words[words[flag + 1] === "--" ? flag + 2 : flag + 1] ?? null;
};

/** Shell scripts nest at most this deep before the reading stops. */
const SCRIPT_DEPTH = 4;

/**
 * Is `words` one Workit call of an allowed verb? Global `--json` and
 * `--cwd <dir>` may come first (they mean the same anywhere before `--`);
 * `--session` may not (it changes the acting identity). A bypass flag before
 * `--` disqualifies it, and so does a word the shell expands there (`expands`,
 * indexes into `words`): `${F:---unverified}` could become one.
 */
export const isAllowedWorkitCall = (
  words: readonly string[],
  expands: readonly number[] = [],
): boolean => {
  if (words[0] !== "workit") return false;
  let at = 1;
  for (;;) {
    const word = words[at];
    if (word === "--json") at += 1;
    else if (word === "--cwd") at += 2;
    else if (word?.startsWith("--cwd=")) at += 1;
    else break;
  }
  const verb = words[at];
  if (verb === undefined) return false;
  if (verb === "--version") return at === words.length - 1;
  if (!ALLOWED.has(verb)) return false;
  const end = words.indexOf("--");
  const limit = end < 0 ? words.length : end;
  const call = words.slice(at, limit);
  if (WORKIT_USER_ONLY.some((needle) => hasWordsInOrder(call, needle))) return false;
  return !words.slice(0, limit).some(isBypass) && !expands.some((index) => index < limit);
};

const bypassReason = (flag: string) =>
  `Workit: \`${flag}\` overrides a Workit gate, so the user decides this call (no allow rule covers it).`;

/**
 * The ask reason for a Workit call in `command` that carries a bypass flag
 * before its `--`, or null. A word the shell expands (`$F`, `${F:---unverified}`) is not read: its text is not what runs, and the
 * merge grant and `--reason` stay the gate. Words are read after shell quoting, so `"--unverified"`,
 * `--unverif''ied` or a tab-separated flag are found where a host's string
 * rule could miss them. A command the tokenizer cannot analyze is judged on
 * its text with quotes and backslashes removed.
 */
export const workitBypassFlag = (
  command: string,
  dialect: ShellDialect = "posix",
): string | null => {
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.unanalyzable) {
      const text = command.replaceAll(/['"\\`]/gu, "");
      if (!/\bworkit\b/u.test(text)) return null;
      const found = WORKIT_BYPASS_FLAGS.find((flag) => text.includes(flag));
      return found ? bypassReason(found) : null;
    }
    const start = segment.words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const words = segment.words.slice(start + 1);
    const end = words.indexOf("--");
    const flag = (end < 0 ? words : words.slice(0, end)).find(isBypass);
    if (flag) return bypassReason(flag.split("=")[0] ?? flag);
  }
  return null;
};

/**
 * `workit install --help`: the user-only words, then only help flags. The CLI
 * prints help and exits before the verb runs, so it reads like `workit help install`.
 */
const helpOnly = (call: readonly string[], needle: readonly string[]): boolean =>
  call.length > needle.length &&
  needle.every((word, index) => call[index] === word) &&
  call.slice(needle.length).every((word) => word === "--help" || word === "-h");

/**
 * The user-only words (`WORKIT_USER_ONLY`) a Workit call in `command` runs,
 * or null. Each shell segment is read like `workitBypassFlag` does, so global
 * `--json`, `--cwd <dir>`, `--cwd=<dir>` and `--session <id>` may come before
 * the verb, which stays anchored: `workit help grant set` is not a match.
 */
export const userOnlyWorkitCall = (
  command: string,
  dialect: ShellDialect = "posix",
): string[] | null => {
  if (!mayRunUserOnly(command)) return null;
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.unanalyzable) continue;
    const start = segment.words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const words = segment.words.slice(start + 1);
    const end = words.indexOf("--");
    const args = end < 0 ? words : words.slice(0, end);
    const call = args.slice(verbAt(args));
    const found = WORKIT_USER_ONLY.find(
      (needle) => call[0] === needle[0] && hasWordsInOrder(call, needle),
    );
    if (found && !helpOnly(call, found)) return [...found];
  }
  return null;
};

/**
 * The asked verb (`WORKIT_ASKED_VERBS`) a Workit call in `command` runs, with
 * `plain` true when nothing but the verb follows `workit` (the spelling host
 * rules match: no env assignment, wrapper or global option before it), or null.
 */
export const askedWorkitCall = (
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): { verb: string; plain: boolean } | null => {
  if (!mayRunUserOnly(command)) return null;
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.unanalyzable) continue;
    // A shell's `-c` script, an `eval` and a command substitution run their own calls (#916).
    const script = shellScript(segment.words);
    for (const inner of depth < SCRIPT_DEPTH
      ? [...(script ? [script] : []), ...(segment.subs ?? [])]
      : []) {
      const found = askedWorkitCall(inner, "posix", depth + 1);
      if (found) return { ...found, plain: false };
    }
    const start = segment.words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const words = segment.words.slice(start + 1);
    const at = verbAt(words);
    const verb = WORKIT_ASKED_VERBS.find((name) => words[at] === name);
    if (verb && !helpOnly(words.slice(at), [verb]))
      return {
        verb,
        plain: at === 0 && start === 0 && segment.words[0] === "workit",
      };
  }
  return null;
};

/**
 * Is the whole shell `command` allowed Workit calls only? Every segment must
 * be one, with no substitution, redirect, group or heredoc anywhere.
 */
export const isAllowedWorkitCommand = (command: string): boolean => {
  const segments = segmentsOf(command);
  return (
    segments.length > 0 &&
    segments.every(
      (s) =>
        !s.unanalyzable &&
        !s.group &&
        !s.subs?.length &&
        !s.stdin?.length &&
        !s.redirects.length &&
        isAllowedWorkitCall(s.words, s.expands),
    )
  );
};
