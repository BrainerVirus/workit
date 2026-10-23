// `cd <dir> && workit <args>` → `workit <verb> --cwd <dir> <rest>` (issue #388).
// On Claude Code the compound does not match a `Bash(workit …)` allow rule
// (every subcommand must match, and a `cd` outside the working dirs breaks
// it), so the auto-mode classifier judged it. The rewrite is exact and
// conservative: one literal directory, one workit call, and only read-only
// filters after it. Anything else is left alone. Pure string work.
//
// The verb goes first (issue #297): Workit's enumerated host rules, such as
// `Bash(workit git *)`, cannot match a variable directory before the verb.
// `--cwd` and `--json` mean the same anywhere before `--` (main.ts
// parseGlobals), so moving them never changes what runs.
import { WORKIT_ALLOWED_VERBS } from "./delivery-verbs";
import { segmentsOf } from "./shell-words";

// A directory spelled as one literal word: bare, '…' or "…" with no expansion.
const DIR = String.raw`[A-Za-z0-9_./@%+:,=-]+|'[^'$${"`"}\\\n]*'|"[^"$${"`"}\\!\n]*"`;
const COMPOUND = new RegExp(String.raw`^\s*cd\s+(${DIR})\s*&&\s*(workit(?:\s[\s\S]*)?)$`, "u");
// `workit` then `--json` / `--cwd <dir>` globals, then the verb.
const GLOBALS_FIRST = new RegExp(
  String.raw`^(\s*workit)((?:\s+(?:--json|--cwd(?:=|\s+)(?:${DIR})))+)\s+([a-z][a-z-]*)(?=\s|$)`,
  "u",
);
const VERB_FIRST = /^((?:--json\s+)*)([a-z][a-z-]*)(?=\s|$)/u;
const VERBS = new Set<string>(WORKIT_ALLOWED_VERBS);
const FILTERS = new Set(["tail", "head", "grep"]);

// A filter that reads only stdin, so moving the cwd cannot change what it
// reads: flags and counts for tail/head, one pattern for grep (no -r/-R/-f).
const stdinOnly = (words: readonly string[]): boolean => {
  const [name, ...args] = words;
  const operands = args.filter((w) => !w.startsWith("-"));
  if (name === "grep")
    return operands.length <= 1 && !args.some((w) => /^-[^-]*[rRf]|^--(recursive|file)/u.test(w));
  return operands.every((w) => /^\d+$/u.test(w)) && !args.some((w) => w.startsWith("--output"));
};

/**
 * The command rewritten to `workit <verb> --cwd <dir> …` (`workit --cwd <dir>
 * …` for a verb no host rule lists), or null when it is not exactly
 * `cd <literal dir> && workit … [2>&1] [| tail|head|grep …]*`.
 */
export const cwdRewrite = (command: string): string | null => {
  const match = COMPOUND.exec(command);
  const dir = match?.[1];
  const rest = match?.[2];
  if (!dir || !rest || dir.startsWith("-")) return null;
  // `2>&1` is the only redirect, `|` the only operator: no `&`, `;`, `<`, `>`, backtick or newline.
  if (/[&;<>`\n]/u.test(rest.replaceAll("2>&1", ""))) return null;
  const segments = segmentsOf(rest);
  const [head, ...filters] = segments;
  if (!head || head.words[0] !== "workit") return null;
  if (head.words.some((w) => w === "--cwd" || w.startsWith("--cwd="))) return null;
  const clean = (s: (typeof segments)[number]) =>
    !s.unanalyzable && !s.group && !s.subs?.length && !s.stdin?.length && !s.redirects.length;
  if (!segments.every(clean)) return null;
  if (!segments.slice(0, -1).every((s) => s.pipe)) return null;
  if (!filters.every((s) => FILTERS.has(s.words[0] ?? "") && stdinOnly(s.words))) return null;
  const args = rest.slice("workit".length).trimStart();
  const verb = VERB_FIRST.exec(args);
  if (!verb?.[2] || !VERBS.has(verb[2])) return `workit --cwd ${dir} ${args}`.trimEnd();
  const json = verb[1] ? " --json" : "";
  return `workit ${verb[2]} --cwd ${dir}${json}${args.slice(verb[0].length)}`.trimEnd();
};

/**
 * `workit --cwd <dir> <verb> …` (with any `--json` there) rewritten with the
 * verb first, for a verb the host rules list; null otherwise. Only the words
 * before the first verb move.
 */
export const verbFirst = (command: string): string | null => {
  const match = GLOBALS_FIRST.exec(command);
  const [whole, lead, globals, verb] = match ?? [];
  if (!whole || !verb || !VERBS.has(verb) || !globals?.includes("--cwd")) return null;
  return `${lead} ${verb}${globals}${command.slice(whole.length)}`;
};
