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
import { segmentsOf } from "./shell-words";

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

/** Flags that override a Workit gate: a host never allows them unasked. */
export const WORKIT_BYPASS_FLAGS = ["--unverified", "--overwrite-unintegrated"] as const;

const ALLOWED = new Set<string>(WORKIT_ALLOWED_VERBS);

/**
 * Is `words` one Workit call of an allowed verb? Global `--json` and
 * `--cwd <dir>` may come first (they mean the same anywhere before `--`);
 * `--session` may not (it changes the acting identity). A bypass flag before
 * `--` disqualifies it.
 */
export const isAllowedWorkitCall = (words: readonly string[]): boolean => {
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
  const flags = end < 0 ? words : words.slice(0, end);
  return !flags.some((word) =>
    WORKIT_BYPASS_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`)),
  );
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
        isAllowedWorkitCall(s.words),
    )
  );
};
