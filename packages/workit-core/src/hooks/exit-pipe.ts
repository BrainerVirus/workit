// A Workit verb whose exit code is its answer (`ci wait`, `check`, `pr merge`,
// `release …`, `verify-delivery`) piped into `tail` or `head` (#912): the
// pipeline's status is the filter's, so a refused or red call reads as exit 0
// ("CI finished"). Denied with the unpiped call, never rewritten: Claude Code
// auto mode refuses a hook-changed call (#908), and every host can deny. The
// filter may sit anywhere later in the pipeline (`| tee log | tail`), the call
// inside a group (`(workit ci wait) | tail`); `set -o pipefail` first keeps
// the exit code, so it is left alone.
import type { HookDecision } from "./protocol";
import { segmentsOf, type ShellDialect } from "./shell-words";

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

/** The exit-code-bearing `workit` call in `words` (env assignments skipped), or null. */
const exitCall = (words: readonly string[]): string[] | null => {
  let at = 0;
  while (at < words.length && /^[A-Za-z_]\w*=/u.test(words[at])) at += 1;
  if (!/^workit(?:-cli)?$/u.test(base(words[at]))) return null;
  const path = verbPath(words.slice(at + 1));
  return EXIT_VERBS.some((verb) => verb.every((word, index) => path[index] === word))
    ? words.slice(at)
    : null;
};

const setsPipefail = (words: readonly string[]): boolean =>
  words[0] === "set" &&
  words.some((word, at) => word === "pipefail" && /^-[a-z]*o$/u.test(words[at - 1] ?? ""));

type Found = { call: string[]; dir: string | null };

/** The retry: the call alone, verb first, with `--cwd <dir>` for a literal `cd <dir>` before it. */
const retryOf = ({ call, dir }: Found): string => {
  const at = call[1]?.startsWith("-") ? 1 : 2;
  const words =
    dir && !call.includes("--cwd") ? [...call.slice(0, at), "--cwd", dir, ...call.slice(at)] : call;
  return ["workit", ...words.slice(1)].map(quote).join(" ");
};

/**
 * The deny for an exit-code-bearing Workit call piped into `tail`/`head`,
 * naming that call alone, or null.
 */
export function exitPipeGate(
  command: string,
  dialect: ShellDialect = "posix",
): HookDecision | null {
  if (!/\bworkit/u.test(command) || !/\b(?:tail|head)\b/u.test(command)) return null;
  const groups: (Found | null)[] = [];
  let carry: Found | null = null;
  let pipefail = false;
  let dir: string | null = null;
  for (const segment of segmentsOf(command, dialect)) {
    if (segment.unanalyzable) return null;
    let words = segment.words;
    let closes = segment.group === "close";
    if (segment.group === "open") {
      groups.push(null);
      continue;
    }
    if (words[0] === "{") {
      groups.push(null);
      words = words.slice(1);
    } else if (words[0] === "}") {
      closes = true;
      words = words.slice(1);
    }
    if (closes) {
      const inner = groups.pop() ?? null;
      // A call in a nested group is the enclosing group's call too: `( (workit …) ) | tail`.
      if (inner && groups.length) groups[groups.length - 1] = inner;
      carry = segment.pipe ? (inner ?? carry) : null;
      continue;
    }
    // Redirects alone after a group close (`( … ) 2>&1 | x`) leave its output flowing.
    if (!words.length && !segment.stdin && !segment.subs) continue;
    if (setsPipefail(words)) pipefail = true;
    const filter = base(words[0]);
    if (carry && !pipefail && (filter === "tail" || filter === "head")) {
      const retry = retryOf(carry);
      return {
        kind: "deny",
        reason: `workit exit-pipe: piping \`workit ${verbPath(carry.call.slice(1)).join(" ")}\` into ${filter} hides its exit code.\nRetry as: ${retry}`,
        unblock: retry,
      };
    }
    const call = exitCall(words);
    const found = call ? { call, dir } : null;
    if (found && groups.length) groups[groups.length - 1] = found;
    // The output flows on through `tee`, `grep` and the like.
    carry = segment.pipe ? (found ?? carry) : null;
    dir = words.length === 2 && words[0] === "cd" && !segment.expands?.length ? words[1] : null;
  }
  return null;
}
