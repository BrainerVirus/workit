// Help for one verb or subcommand, from the registry (cold path: no verb module
// loads). `workit help <verb> [<sub>]` and `--help`/`-h` anywhere before a bare
// `--` both land here, so no verb ever sees a help flag.
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
      ...exampleBlock(examples),
      "",
      ...(sub.aliases?.length ? [`aliases: ${sub.aliases.join(", ")}`] : []),
      ESCAPE,
    ].join("\n"),
  };
}
