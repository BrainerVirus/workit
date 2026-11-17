// The calls a host asks about on the action itself (#864, decisions
// mwf752f2 and mwf752sv): one prompt on the call, showing its full text, and
// a yes runs it in that same call: the `workit youtrack` writes and
// `workit release notes approve <v>`.
//
// A host acts only on one plain call: anything around it (a chain, a pipe, a
// redirect, a substitution, a variable, a leading cd, a shell's -c script)
// could change what runs or repeat it, so the hook denies it and names the
// plain form. Global options before the verb (`--json`, `--cwd`,
// `--session`) are the CLI's own and keep a call plain.
import path from "node:path";
import { youTrackWritesMode } from "../autonomy";
import { segmentsOf, type ShellDialect } from "../hooks/shell-words";
import { isWorkitWord, verbIndex } from "./call";
import { isReleaseNotesApprove, releaseNotesAskAt } from "./release-notes-ask";
import type { ApprovalKind } from "./store";
import { isYouTrackWriteVerb, youTrackAsk } from "./youtrack-ask";

export type InlineCall =
  /**
   * Exactly `workit [globals] <verb> …`: the words the verb's router passes
   * on (a leading `--json` moved after the verb, as the CLI does), and the
   * leading `--cwd` the CLI runs in.
   */
  | { plain: true; words: string[]; cwd: string | null }
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

/** `workit release notes approve …`: a user-only call whose host ask replaces the user-only one. */
export const isReleaseNotesCall = (words: readonly string[]): boolean =>
  words[0] === "release" && isReleaseNotesApprove(words.slice(1));

/** Whether `words` (past `workit`) is a call asked on itself. */
const asked = (words: readonly string[]): boolean =>
  (words[0] === "youtrack" && isYouTrackWriteVerb(words[1])) || isReleaseNotesCall(words);

const quote = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** `call` as the CLI's router hands it on: a leading `--json` goes after the verb, before any `--`. */
const routed = (call: string[], globals: readonly string[]): string[] => {
  if (!globals.includes("--json") || call.slice(1).includes("--json")) return call;
  const end = call.indexOf("--");
  return end < 0 ? [...call, "--json"] : [...call.slice(0, end), "--json", ...call.slice(end)];
};

/** The last leading `--cwd` value, which the CLI runs in. */
const cwdOf = (globals: readonly string[]): string | null => {
  let cwd: string | null = null;
  for (let index = 0; index < globals.length; index += 1) {
    const word = globals[index] ?? "";
    if (word === "--cwd") cwd = globals[++index] ?? null;
    else if (word.startsWith("--cwd=")) cwd = word.slice("--cwd=".length);
    else if (word === "--session") index += 1;
  }
  return cwd;
};

/** Where a plain call runs: its `--cwd` against the host's cwd. */
export const inlineCallCwd = (call: { cwd: string | null }, base: string): string =>
  call.cwd ? path.resolve(base, call.cwd) : base;

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
      ? words.find((word) => /\bworkit\s+(?:youtrack|release\s+notes\s+approve)\s/u.test(word))
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
      !segment.redirects.length &&
      !segment.subs?.length &&
      !segment.stdin?.length &&
      !segment.expands?.length &&
      !segment.group;
    if (plain)
      return {
        plain: true,
        words: routed(call, words.slice(1, at)),
        cwd: cwdOf(words.slice(1, at)),
      };
    return {
      plain: false,
      fix: `workit ${call.map(quote).join(" ")}`,
    };
  }
  return null;
};

/**
 * The ask for a plain call's words, or null when nothing asks: the verb
 * refuses the call itself (no draft to show), or `youtrack.writes: auto`
 * keeps the WORKIT_YT_WRITE gate instead.
 */
export const inlineAskFor = (words: readonly string[], cwd: string): InlineAsk | null => {
  if (isReleaseNotesCall(words)) return releaseNotesAskAt(words.slice(3), cwd);
  return asked(words) && youTrackWritesMode(cwd) !== "auto"
    ? youTrackAsk(words.slice(1), cwd)
    : null;
};

/** The deny reason for an inline-asked call inside something else. */
export const inlineCallDeny = (fix: string): string =>
  `Run \`${fix}\` as its own call so the host can ask the user.`;
