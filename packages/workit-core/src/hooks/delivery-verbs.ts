// The Workit verbs a host may run without asking (issue #297, decision
// mvk5q3io): delivery and state verbs whose own gates (grants, non-author
// verdicts, branch policy) decide. One list for every host's permission
// block: Claude Code `Bash(workit <verb> *)`, Codex `prefix_rule`, Cursor
// `Shell(workit <verb>)`, and the OpenCode plugin's ask-to-allow.
//
// Never listed: verbs that run an arbitrary command (`check -- <cmd>`,
// `lock run -- <cmd>`, `test-audit`, `fanout check`), change authority
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
] as const;

/**
 * Flags that override a Workit gate: a host never allows them unasked.
 * Workit has no `--admin` flag and refuses a bare `--force` push itself.
 */
export const WORKIT_BYPASS_FLAGS = ["--unverified", "--overwrite-unintegrated"] as const;

/**
 * Calls only the user runs (issue #615). The CLI's TTY and agent-marker check
 * deters a cooperating agent; the host's prompt is what stops a determined
 * one, so no host rule or hook allow may cover these. `release` is an allowed
 * verb and `release notes approve` is inside it, so each host also asks or
 * denies these words explicitly.
 */
export const WORKIT_USER_ONLY: readonly (readonly string[])[] = [
  ["release", "notes", "approve"],
  ["grant", "set"],
  ["grant", "raise"],
];

const ALLOWED = new Set<string>(WORKIT_ALLOWED_VERBS);

/** Do `needle`'s words appear in order in `words` (flags and values between them still match)? */
const hasWordsInOrder = (words: readonly string[], needle: readonly string[]): boolean => {
  let at = 0;
  for (const word of words) if (word === needle[at] && (at += 1) === needle.length) return true;
  return false;
};

const isBypass = (word: string): boolean =>
  WORKIT_BYPASS_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));

/** `workit`, `workit-cli`, or either by path. */
const isWorkitWord = (word: string): boolean => /^(?:.*[\\/])?workit(?:-cli)?$/u.test(word);

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
