// The calls a host asks about on the action itself (#864, decisions
// mwf752f2 and mwf752sv): one prompt on the call, showing its full text, and
// a yes runs it in that same call. Today: the `workit youtrack` writes.
// Release-notes approval plugs in here as another entry of ASKS.
//
// A host acts only on one plain call: anything around it (a chain, a pipe, a
// redirect, a substitution, a variable, a leading cd) could change what runs
// or repeat it, so the hook denies it and names the plain form.
import { youTrackWritesMode } from "../autonomy";
import { segmentsOf, type ShellDialect } from "../hooks/shell-words";
import type { ApprovalKind } from "./store";
import { isYouTrackWriteVerb, youTrackAsk, youTrackAskText } from "./youtrack-ask";

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

type Entry = {
  /** Whether `words` (past `workit`) is a call this entry asks about. */
  matches: (words: readonly string[]) => boolean;
  /** The ask for a plain call in `cwd`, or null when the verb refuses it before acting. */
  ask: (words: readonly string[], cwd: string) => InlineAsk | null;
};

const ASKS: readonly Entry[] = [
  {
    matches: (words) => words[0] === "youtrack" && isYouTrackWriteVerb(words[1]),
    // `youtrack.writes: auto` keeps the WORKIT_YT_WRITE gate instead: nothing asks.
    ask: (words, cwd) => {
      if (youTrackWritesMode(cwd) === "auto") return null;
      const found = youTrackAsk(words.slice(1), cwd);
      return found ? { ...found, text: youTrackAskText(found) } : null;
    },
  },
];

const isWorkitWord = (word: string): boolean => /^(?:.*[\\/])?workit(?:-cli)?$/u.test(word);

const quote = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** Global options the CLI reads before its verb. */
const verbIndex = (words: readonly string[], start: number): number => {
  let at = start;
  for (;;) {
    const word = words[at];
    if (word === "--json") at += 1;
    else if (word === "--cwd" || word === "--session") at += 2;
    else if (word?.startsWith("--cwd=")) at += 1;
    else return at;
  }
};

const SHELLS = /^(?:.*\/)?(?:sh|bash|zsh|dash|ksh|fish)$/u;

/** The script a `bash -c '…'` or `eval …` segment runs, or null. */
const scriptOf = (words: readonly string[]): string | null => {
  if (words[0] === "eval") return words.slice(1).join(" ");
  if (!SHELLS.test(words[0] ?? "")) return null;
  const flag = words.findIndex((word, at) => at > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(word));
  return flag > 0 ? (words[flag + 1] ?? null) : null;
};

/** The inline-asked Workit call `command` runs, or null when it runs none. */
export const inlineCallIn = (
  command: string,
  dialect: ShellDialect = "posix",
  depth = 0,
): InlineCall | null => {
  if (!/\bworkit\b/u.test(command) || depth > 3) return null;
  const segments = segmentsOf(command, dialect);
  for (const segment of segments) {
    if (segment.unanalyzable) continue;
    // A shell's script: never plain, whatever runs inside it.
    const script = scriptOf(segment.words);
    const inner = script === null ? null : inlineCallIn(script, "posix", depth + 1);
    if (inner)
      return {
        plain: false,
        fix: inner.plain ? `workit ${inner.words.map(quote).join(" ")}` : inner.fix,
      };
    const start = segment.words.findIndex(isWorkitWord);
    if (start < 0) continue;
    const at = verbIndex(segment.words, start + 1);
    const words = segment.words.slice(at);
    if (!ASKS.some((entry) => entry.matches(words))) continue;
    const plain =
      segments.length === 1 &&
      start === 0 &&
      segment.words[0] === "workit" &&
      at === 1 &&
      !segment.redirects.length &&
      !segment.subs?.length &&
      !segment.stdin?.length &&
      !segment.expands?.length &&
      !segment.group;
    if (plain) return { plain: true, words };
    return {
      plain: false,
      fix: segment.expands?.length
        ? `workit ${words.slice(0, 3).map(quote).join(" ")} … with every value written out (text in a file, passed with --file)`
        : `workit ${words.map(quote).join(" ")}`,
    };
  }
  return null;
};

/** The ask for a plain call's words, or null when nothing asks (the verb refuses it itself). */
export const inlineAskFor = (words: readonly string[], cwd: string): InlineAsk | null => {
  const entry = ASKS.find((one) => one.matches(words));
  return entry ? entry.ask(words, cwd) : null;
};

/** The deny reason for an inline-asked call inside something else. */
export const inlineCallDeny = (fix: string): string =>
  `Run \`${fix}\` as its own call: no chain, pipe, redirect, substitution, variable or leading cd around it, so the host can show the user its full text and ask once; a yes runs it in that call.`;
