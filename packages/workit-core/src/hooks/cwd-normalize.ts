// `cd <dir> && workit <args>` → `workit --cwd <dir> <args>` (issue #388).
// On Claude Code the compound does not match a `Bash(workit:*)` allow rule
// (every subcommand must match, and a `cd` outside the working dirs breaks
// it), so the auto-mode classifier judged it. The rewrite is exact and
// conservative: one literal directory, one workit call, and only read-only
// filters after it. Anything else is left alone. Pure string work.
import { segmentsOf } from "./shell-words";

// A directory spelled as one literal word: bare, '…' or "…" with no expansion.
const COMPOUND =
  /^\s*cd\s+([A-Za-z0-9_./@%+:,=-]+|'[^'$`\\\n]*'|"[^"$`\\!\n]*")\s*&&\s*(workit(?:\s[\s\S]*)?)$/u;
const FILTERS = new Set(["tail", "head", "grep"]);

/**
 * The command rewritten to `workit --cwd <dir> …`, or null when it is not
 * exactly `cd <literal dir> && workit … [2>&1] [| tail|head|grep …]*`.
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
  if (!head || head.words[0] !== "workit" || head.words.includes("--cwd")) return null;
  const clean = (s: (typeof segments)[number]) =>
    !s.unanalyzable && !s.group && !s.subs?.length && !s.stdin?.length && !s.redirects.length;
  if (!segments.every(clean)) return null;
  if (!segments.slice(0, -1).every((s) => s.pipe)) return null;
  if (!filters.every((s) => FILTERS.has(s.words[0] ?? ""))) return null;
  return `workit --cwd ${dir} ${rest.slice("workit".length).trimStart()}`.trimEnd();
};
