// A Workit verb whose exit code is its answer (`ci wait`, `check`, `pr merge`,
// `release …`, `verify-delivery`) piped into `tail` or `head` (#912): the
// pipeline's status is the filter's, so a refused or red call reads as exit 0
// ("CI finished"). Denied with the unpiped call, never rewritten: Claude Code
// auto mode refuses a hook-changed call (#908), and every host can deny.
import type { HookDecision } from "./protocol";
import { segmentsOf, type Segment, type ShellDialect } from "./shell-words";

/** Verb paths whose exit code an agent acts on. */
const EXIT_VERBS: readonly (readonly string[])[] = [
  ["ci", "wait"],
  ["check"],
  ["pr", "merge"],
  ["release"],
  ["verify-delivery"],
];

const base = (word = "") => word.split(/[\\/]/u).at(-1) ?? "";

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The words after `workit`, global `--json`/`--cwd <dir>` skipped, as the verb path. */
const verbPath = (words: readonly string[]): string[] => {
  const path: string[] = [];
  for (let at = 0; at < words.length && path.length < 2; at += 1) {
    const word = words[at];
    if (word === "--") break;
    if (word === "--cwd") at += 1;
    else if (!word.startsWith("-")) path.push(word);
  }
  return path;
};

const exitVerb = (words: readonly string[]): boolean => {
  const path = verbPath(words);
  return EXIT_VERBS.some((verb) => verb.every((word, at) => path[at] === word));
};

/** The `workit` call in `segment` (env assignments before it skipped), or null. */
const workitCall = (segment: Segment): string[] | null => {
  let at = 0;
  while (at < segment.words.length && /^[A-Za-z_]\w*=/u.test(segment.words[at])) at += 1;
  return /^workit(?:-cli)?$/u.test(base(segment.words[at])) ? segment.words.slice(at) : null;
};

/**
 * The deny for an exit-code-bearing Workit call piped into `tail`/`head`,
 * naming that call alone (with `--cwd <dir>` for a literal `cd <dir> &&`
 * before it), or null.
 */
export function exitPipeGate(
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision | null {
  if (!/\bworkit/u.test(command) || !/\b(?:tail|head)\b/u.test(command)) return null;
  const segments = segmentsOf(command, dialect);
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.pipe) continue;
    const call = workitCall(segment);
    if (!call || !exitVerb(call.slice(1))) continue;
    const filter = base(segments[index + 1].words[0]);
    if (filter !== "tail" && filter !== "head") continue;
    const before = segments[index - 1];
    const dir =
      before?.words.length === 2 && before.words[0] === "cd" && !before.expands?.length
        ? before.words[1]
        : null;
    // Verb first, so the host's `workit <verb>` allow rules match (#297).
    const at = call[1]?.startsWith("-") ? 1 : 2;
    const words =
      dir && !call.includes("--cwd")
        ? [...call.slice(0, at), "--cwd", dir, ...call.slice(at)]
        : call;
    const retry = ["workit", ...words.slice(1)].map(quote).join(" ");
    return {
      kind: "deny",
      reason: `workit exit-pipe: piping \`workit ${verbPath(call.slice(1)).join(" ")}\` into ${filter} hides its exit code.\nRetry as: ${retry}\nWhy: the exit code is the result; Workit already bounds its output.`,
      unblock: retry,
    };
  }
  return null;
}
