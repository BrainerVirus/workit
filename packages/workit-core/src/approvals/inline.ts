// The calls a host asks about on the action itself (#864, decisions
// mwf752f2 and mwf752sv): one prompt on the call, showing its full text, and
// a yes runs it in that same call. Today: the `workit youtrack` writes.
// Release-notes approval plugs in at `asked` and `inlineAskFor`.
//
// A host acts only on one plain call: anything around it (a chain, a pipe, a
// redirect, a substitution, a variable, a leading cd, a shell's -c script)
// could change what runs or repeat it, so the hook denies it and names the
// plain form.
import { youTrackWritesMode } from "../autonomy";
import { segmentsOf, type ShellDialect } from "../hooks/shell-words";
import { isWorkitWord, verbIndex } from "./call";
import type { ApprovalKind } from "./store";
import { isYouTrackWriteVerb, youTrackAsk } from "./youtrack-ask";

export type InlineCall =
  /** Exactly `workit <verb> …`: the words past `workit`. */
  | { plain: true; words: string[] }
  /** The call inside something else: the plain command to run instead. */
  | { plain: false; fix: string };

/** What the host shows and binds for one call. */
export type InlineAsk = {
  kind: ApprovalKind;
  action: string;
  text: string;
  argvHash: string;
  contentHash: string;
};

/** Whether `words` (past `workit`) is a call asked on itself; release notes joins here. */
const asked = (words: readonly string[]): boolean =>
  words[0] === "youtrack" && isYouTrackWriteVerb(words[1]);

const quote = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The inline-asked Workit call `command` runs, or null when it runs none. */
export const inlineCallIn = (
  command: string,
  dialect: ShellDialect = "posix",
): InlineCall | null => {
  if (!/\bworkit\b/u.test(command)) return null;
  const segments = segmentsOf(command, dialect);
  for (const segment of segments) {
    if (segment.unanalyzable) continue;
    const { words } = segment;
    // A shell's script word (`bash -c '…'`): never plain; its text is the fix.
    const script = (words[0] ?? "").endsWith("sh")
      ? words.find((word) => /\bworkit\s+youtrack\s/u.test(word))
      : undefined;
    if (script) return { plain: false, fix: script.trim() };
    const start = words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const at = verbIndex(words, start + 1);
    const call = words.slice(at);
    if (!asked(call)) continue;
    const plain =
      segments.length === 1 &&
      start === 0 &&
      words[0] === "workit" &&
      at === 1 &&
      !segment.redirects.length &&
      !segment.subs?.length &&
      !segment.stdin?.length &&
      !segment.expands?.length &&
      !segment.group;
    if (plain) return { plain: true, words: call };
    return {
      plain: false,
      fix: `workit ${call.map(quote).join(" ")}`,
    };
  }
  return null;
};

/**
 * The ask for a plain call's words, or null when nothing asks: the verb
 * refuses the call itself, or `youtrack.writes: auto` keeps the
 * WORKIT_YT_WRITE gate instead.
 */
export const inlineAskFor = (words: readonly string[], cwd: string): InlineAsk | null =>
  asked(words) && youTrackWritesMode(cwd) !== "auto" ? youTrackAsk(words.slice(1), cwd) : null;

/** The deny reason for an inline-asked call inside something else. */
export const inlineCallDeny = (fix: string): string =>
  `Run \`${fix}\` as its own call so the host can ask the user.`;
