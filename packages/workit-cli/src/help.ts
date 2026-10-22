// Help for one verb or subcommand, from the registry (cold path: no verb module
// loads). `workit help <verb> [<sub>]` and `--help`/`-h` anywhere before a bare
// `--` both land here, so no verb ever sees a help flag.
import { VERBS, findSubcommand } from "./verbs/registry";
import type { SubcommandEntry, VerbEntry, VerbGroup } from "./verbs/registry";

const HELP_FLAGS = new Set(["--help", "-h"]);

const ESCAPE = "A value that starts with - goes as --flag=value (or after a bare --).";

/** The arguments before a bare `--`; a help flag after it is a value. */
const options = (args: readonly string[]): readonly string[] => {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
};

export const wantsHelp = (args: readonly string[]): boolean =>
  options(args).some((arg) => HELP_FLAGS.has(arg));

/** The first word of `args` (before `--`), the subcommand when there is one. */
export const firstWord = (args: readonly string[]): string | undefined =>
  options(args).find((arg) => !arg.startsWith("-"));

/**
 * Flags that take a value, read from usage lines (`--why "<why>"`, `-m|--message
 * <msg>`, `--method squash|merge`), each mapped to its `--long` spelling.
 */
const valueFlags = (lines: readonly string[]): Map<string, string> => {
  const out = new Map<string, string>();
  const group = /(?<![\w-])(--?[a-zA-Z][\w-]*(?:\|--?[a-zA-Z][\w-]*)*) (?=[<"a-z0-9])/gu;
  for (const line of lines)
    for (const match of line.matchAll(group)) {
      const names = match[1].split("|");
      const long = names.find((name) => name.startsWith("--")) ?? names[0];
      for (const name of names) out.set(name, long);
    }
  return out;
};

/**
 * A help flag right after a flag that takes a value is that value, not a help
 * request (`git commit -m -h`): the usage error that says how to pass it.
 */
export function helpAsValue(args: readonly string[], lines: readonly string[]): string | null {
  const before = options(args);
  const takes = valueFlags(lines);
  for (let index = 1; index < before.length; index += 1) {
    const flag = before[index];
    const long = takes.get(before[index - 1]);
    if (HELP_FLAGS.has(flag) && long)
      return `\`${flag}\` looks like the value of ${before[index - 1]}; use ${long}=${flag} or put it after --`;
  }
  return null;
}

/**
 * Whether a usage line takes positional arguments: something other than a
 * flag and its value is left (`<name>`, `"<text>"`, `paths…`).
 */
export function takesPositionals(lines: readonly string[]): boolean {
  const flag =
    /(?<![\w-])--?[a-zA-Z][\w-]*(?:\|--?[a-zA-Z][\w-]*)*(?:[ =](?!-)(?:<[^>]*>|"[^"]*"|[\w.,@/|=-]+)…?)?/gu;
  return lines.some((line) => /<|"|\w…|\s…/u.test(line.replace(flag, "")));
}

export type HelpDoc = {
  name: string;
  group: VerbGroup;
  subcommand?: string;
  /** The first usage line (one string, as before subcommands had their own). */
  usage: string;
  usages: string[];
  summary: string;
  examples: string[];
  text: string;
};

/** Every usage line of a verb: one per subcommand, else its own. */
export const usageLines = (entry: VerbEntry): string[] =>
  entry.subcommands?.length ? entry.subcommands.map((sub) => sub.usage) : [entry.usage];

const examplesFor = (entry: VerbEntry, sub?: SubcommandEntry): string[] =>
  (entry.examples ?? []).filter((example) =>
    sub ? new RegExp(`^workit ${entry.name} ${sub.name}(?![\\w-])`, "u").test(example) : true,
  );

const exampleBlock = (examples: string[]): string[] =>
  examples.length ? ["", "examples:", ...examples.map((line) => `  ${line}`)] : [];

const noteBlock = (entry: VerbEntry): string[] => (entry.notes ?? []).flatMap((note) => ["", note]);

export function verbHelp(entry: VerbEntry): HelpDoc {
  const subs = entry.subcommands ?? [];
  const usages = usageLines(entry);
  const examples = examplesFor(entry);
  const text = [
    ...(subs.length
      ? [
          `workit ${entry.name}: ${entry.summary}`,
          "",
          ...subs.flatMap((sub) => [`usage: ${sub.usage}`, `    ${sub.summary}`]),
        ]
      : [`usage: ${entry.usage}`, "", entry.summary]),
    ...noteBlock(entry),
    ...exampleBlock(examples),
    "",
    ...(subs.length
      ? [`More: workit help ${entry.name} <${subs.map((sub) => sub.name).join("|")}>`]
      : []),
    ESCAPE,
  ].join("\n");
  return {
    name: entry.name,
    group: entry.group,
    usage: usages[0],
    usages,
    summary: entry.summary,
    examples,
    text,
  };
}

export function subcommandHelp(entry: VerbEntry, sub: SubcommandEntry): HelpDoc {
  const examples = examplesFor(entry, sub);
  return {
    name: entry.name,
    group: entry.group,
    subcommand: sub.name,
    usage: sub.usage,
    usages: [sub.usage],
    summary: sub.summary,
    examples,
    text: [
      `usage: ${sub.usage}`,
      "",
      sub.summary,
      ...noteBlock(entry),
      ...exampleBlock(examples),
      "",
      ...(sub.aliases?.length ? [`aliases: ${sub.aliases.join(", ")}`] : []),
      ESCAPE,
    ].join("\n"),
  };
}

const distance = (left: string, right: string): number => {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1)
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[right.length];
};

/** The candidate closest to `word`: a near spelling or a prefix, else null. */
export function closest(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const near = distance(word, candidate);
    const score =
      candidate.startsWith(word) || word.startsWith(candidate) ? Math.min(near, 1) : near;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

// Guesses at verbs that do not exist, each answered with the verb that does the job.
const COMMAND_HINTS: Record<string, string> = {
  status:
    "workit task status (this branch's task) or workit pr status (its PR); workit handoff prints the whole picture",
  context: "workit handoff prints the branch, HEAD, dirty state, verdict and next command",
};

/** The one-line unblock for an unknown command. */
export function commandUnblock(command: string): string {
  const near = closest(
    command,
    VERBS.filter((entry) => !entry.planned).map((entry) => entry.name),
  );
  return (
    COMMAND_HINTS[command] ?? (near ? `did you mean workit ${near}? (workit help)` : "workit help")
  );
}

const LONG_FLAG = /^--([a-zA-Z][\w-]*)(=|$)/u;
const GLOBAL_FLAGS = new Set(["json", "cwd", "help"]);

export type FlagCheck = { args: string[] } | { error: string; unblock: string };

/**
 * Before a verb loads: rewrite a flag spelled as a registered alias to the one
 * its parser reads, and refuse a `--flag` the command's usage does not name
 * with the closest valid flag (or the registered fix) as the unblock. A bare
 * `--` ends the options.
 */
export function checkFlags(entry: VerbEntry, args: readonly string[]): FlagCheck {
  const word = firstWord(args);
  const sub = word === undefined ? undefined : findSubcommand(entry, word);
  const lines =
    sub && !/ …/u.test(sub.usage) ? [sub.usage] : usageLines(entry).filter((line) => line !== "");
  const known = new Set<string>();
  for (const line of lines)
    for (const match of line.matchAll(/(?<![\w-])--([a-zA-Z][\w-]*)/gu)) known.add(match[1]);
  const aliases = { ...entry.flagAliases, ...sub?.flagAliases };
  const hints = { ...entry.flagHints, ...sub?.flagHints };
  const where = `workit help ${entry.name}${sub ? ` ${sub.name}` : ""}`;
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      out.push(...args.slice(index));
      break;
    }
    const match = LONG_FLAG.exec(arg);
    if (!match || GLOBAL_FLAGS.has(match[1]) || known.has(match[1])) {
      out.push(arg);
      continue;
    }
    const canonical = aliases[match[1]];
    if (canonical !== undefined) {
      out.push(`--${canonical}${arg.slice(match[0].length - match[2].length)}`);
      continue;
    }
    const near = closest(match[1], known);
    return {
      error: `unknown option --${match[1]}`,
      unblock: hints[match[1]] ?? (near ? `did you mean --${near}? (${where})` : where),
    };
  }
  return { args: out };
}
