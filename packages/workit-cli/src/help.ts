// Help for one verb or subcommand, from the registry (cold path: no verb module
// loads). `workit help <verb> [<sub>]` and `--help`/`-h` anywhere before a bare
// `--` both land here, so no verb ever sees a help flag.
import type { SubcommandEntry, VerbEntry } from "./verbs/registry";

const HELP_FLAGS = new Set(["--help", "-h"]);

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

export type HelpDoc = {
  name: string;
  subcommand?: string;
  usage: string[];
  summary: string;
  examples: string[];
  text: string;
};

const examplesFor = (entry: VerbEntry, sub?: SubcommandEntry): string[] =>
  (entry.examples ?? []).filter((example) =>
    sub ? new RegExp(`^workit ${entry.name} ${sub.name}(?![\\w-])`, "u").test(example) : true,
  );

const render = (usage: string[], summary: string, examples: string[], footer?: string): string =>
  [
    usage.map((line) => `usage: ${line}`).join("\n"),
    "",
    summary,
    ...(examples.length ? ["", "examples:", ...examples.map((line) => `  ${line}`)] : []),
    ...(footer ? ["", footer] : []),
  ].join("\n");

export function verbHelp(entry: VerbEntry): HelpDoc {
  const subs = entry.subcommands ?? [];
  const usage = subs.length ? subs.map((sub) => sub.usage) : [entry.usage];
  const examples = examplesFor(entry);
  const text = subs.length
    ? [
        `workit ${entry.name}: ${entry.summary}`,
        "",
        ...subs.flatMap((sub) => [`usage: ${sub.usage}`, `    ${sub.summary}`]),
        ...(examples.length ? ["", "examples:", ...examples.map((line) => `  ${line}`)] : []),
        "",
        `More: workit help ${entry.name} <${subs.map((sub) => sub.name).join("|")}>`,
      ].join("\n")
    : render(usage, entry.summary, examples);
  return { name: entry.name, usage, summary: entry.summary, examples, text };
}

export function subcommandHelp(entry: VerbEntry, sub: SubcommandEntry): HelpDoc {
  const examples = examplesFor(entry, sub);
  const aliases = sub.aliases?.length ? `aliases: ${sub.aliases.join(", ")}` : undefined;
  return {
    name: entry.name,
    subcommand: sub.name,
    usage: [sub.usage],
    summary: sub.summary,
    examples,
    text: render([sub.usage], sub.summary, examples, aliases),
  };
}
