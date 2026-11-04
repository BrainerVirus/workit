// What shell completion offers, read from the verb registry (no verb module
// loads): the verbs, each verb's subcommands, the flags each usage line names
// and the positional slots after them. The generated scripts embed the static
// part; `workit __complete` serves the rest (completion/complete.ts).
import { flagLines, valueFlags } from "../help";
import { VERBS, type SubcommandEntry, type VerbEntry } from "../verbs/registry";

/** Flags the router reads before any verb (main.ts parseGlobals and help). */
export const GLOBAL_FLAGS = ["--json", "--cwd", "--help"] as const;

/** Flags the router reads before the command only. */
const LEADING_FLAGS = ["--session", "--version"] as const;

/** The global flags that take a value: the word after them is never a positional. */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--cwd", "--session"]);

/** Verbs `help` and completion offer: every registered one but the planned ones, plus help. */
export const verbNames = (): string[] => [
  ...VERBS.filter((entry) => !entry.planned).map((entry) => entry.name),
  "help",
];

const longFlags = (lines: readonly string[]): string[] => {
  const found = new Set<string>();
  for (const line of lines)
    for (const match of line.matchAll(/(?<![\w-])(--[a-zA-Z][\w-]*)/gu)) found.add(match[1]);
  return [...found];
};

/** The long flags a verb (every subcommand) or one subcommand names, globals last. */
export const flagsFor = (entry: VerbEntry | undefined, sub?: SubcommandEntry): string[] => {
  const own = entry ? longFlags(flagLines(entry, sub)) : [...LEADING_FLAGS];
  return [...new Set([...own, ...GLOBAL_FLAGS])];
};

/** One positional slot of a usage line: fixed words, or a placeholder `<name>`. */
export type Slot = { words: string[] } | { placeholder: string; repeats: boolean };

const WORD = /^[a-z][\w-]*$/u;

/**
 * The positional slots of a usage line after `workit <verb> [<sub>]`, from its
 * first form (`a | workit b …` keeps `a`): `<plans|retros>` and `create|release`
 * are fixed words, `<slice>…` a repeating placeholder; flags and their values
 * are skipped.
 */
export function positionalSlots(usage: string, lead: number): Slot[] {
  const first = usage.split(/ \| workit /u)[0];
  const takes = valueFlags([first]);
  const tokens = first
    .replace(/[[\]()]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(lead);
  const slots: Slot[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "|" || token === "--") continue;
    if (token.startsWith("-")) {
      if (takes.has(token) && !token.includes("=")) index += 1;
      continue;
    }
    const repeats = token.endsWith("…");
    const bare = token.replace(/…$/u, "");
    const inner = /^<([^>]*)>$/u.exec(bare)?.[1];
    const alternatives = (inner ?? bare).split("|");
    if (alternatives.length > 1 && alternatives.every((word) => WORD.test(word)))
      slots.push({ words: alternatives });
    else if (inner !== undefined) slots.push({ placeholder: inner, repeats });
  }
  return slots;
}

/**
 * The static table the scripts embed, keyed by the words typed so far:
 * `""` the verbs, `<verb>` its subcommands, and `-`, `-<verb>`, `-<verb> <sub>`
 * the flags there. A key with no words is left out.
 */
export function staticTable(): Map<string, string[]> {
  const table = new Map<string, string[]>([
    ["", verbNames()],
    ["-", flagsFor(undefined)],
  ]);
  for (const entry of VERBS) {
    if (entry.planned) continue;
    const subs = entry.subcommands ?? [];
    if (subs.length) table.set(entry.name, [...new Set(subs.map((sub) => sub.name))]);
    table.set(`-${entry.name}`, flagsFor(entry));
    // A name twice (task's implicit `start` and its family `start`): both forms' flags.
    for (const sub of subs) {
      const key = `-${entry.name} ${sub.name}`;
      table.set(key, [...new Set([...(table.get(key) ?? []), ...flagsFor(entry, sub)])]);
    }
  }
  return table;
}
