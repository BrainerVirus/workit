// `workit __complete <words…>`: the candidates for the last word (the one being
// typed, "" after a space), one per line and nothing else, ever. Local reads
// only: the registry, .workit/checks.json, workspaces.json and the fanout
// store; no network and no fetch. Any failure prints nothing.
import fs from "node:fs";
import path from "node:path";
import { findSubcommand, findVerb, type SubcommandEntry, type VerbEntry } from "../verbs/registry";
import { valueFlags, flagLines } from "../help";
import { GLOBAL_VALUE_FLAGS, flagsFor, positionalSlots, verbNames, type Slot } from "./spec";

/** Where dynamic values come from (a test seam; the defaults read the real files). */
export type CompleteSources = {
  checks: (cwd: string) => Promise<string[]>;
  workspaces: () => Promise<string[]>;
  slices: (cwd: string) => Promise<string[]>;
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const names = (list: unknown, key: "name" | "id"): string[] =>
  Array.isArray(list)
    ? list.flatMap((item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>)[key] === "string"
          ? [(item as Record<string, string>)[key]]
          : [],
      )
    : [];

const defaultSources: CompleteSources = {
  // Imported on use so the cold path (help, --version) never loads core.
  checks: async (cwd) => {
    const { loadCheckConfig } = await import("@brainervirus/workit-core/src/check-config");
    const config = loadCheckConfig(cwd);
    return [...config.checks.map((check) => check.name), ...Object.keys(config.groups)];
  },
  workspaces: async () => {
    const { configFilePath } = await import("@brainervirus/workit-core/src/core/config");
    const file = readJson(configFilePath("workspaces.json")) as { workspaces?: unknown } | null;
    return names(file?.workspaces, "name");
  },
  slices: async (cwd) => {
    const { fanoutsDir } = await import("@brainervirus/workit-core/src/fanout");
    const dir = fanoutsDir(cwd);
    if (!dir.ok) return [];
    let files: string[];
    try {
      files = fs.readdirSync(dir.data).filter((file) => file.endsWith(".json"));
    } catch {
      return [];
    }
    return files.flatMap((file) => {
      const plan = readJson(path.join(dir.data, file)) as { slices?: unknown } | null;
      return names(plan?.slices, "id");
    });
  },
};

type Context = { entry?: VerbEntry; sub?: SubcommandEntry; positionals: string[]; verb?: string };

/** Walk the typed words: the verb, its subcommand, and the positionals after them. */
function context(typed: readonly string[]): Context & { cwd?: string; afterValueFlag: boolean } {
  let verb: string | undefined;
  let entry: VerbEntry | undefined;
  let sub: SubcommandEntry | undefined;
  let cwd: string | undefined;
  const positionals: string[] = [];
  let takes = new Map<string, string>();
  let afterValueFlag = false;
  for (let index = 0; index < typed.length; index += 1) {
    const word = typed[index];
    afterValueFlag = false;
    if (word === "--cwd" && index + 1 < typed.length) cwd = typed[index + 1];
    if (GLOBAL_VALUE_FLAGS.has(word) || takes.has(word)) {
      if (index + 1 === typed.length) afterValueFlag = true;
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    if (verb === undefined) {
      verb = word;
      entry = findVerb(word);
      if (entry) takes = valueFlags(flagLines(entry));
    } else if (entry?.subcommands?.length && sub === undefined && positionals.length === 0) {
      sub = findSubcommand(entry, word);
      if (sub) takes = valueFlags(flagLines(entry, sub));
      else positionals.push(word);
    } else positionals.push(word);
  }
  return { verb, entry, sub, positionals, cwd, afterValueFlag };
}

const slotAt = (slots: readonly Slot[], index: number): Slot | undefined => {
  if (index < slots.length) return slots[index];
  const last = slots.at(-1);
  return last && "placeholder" in last && last.repeats ? last : undefined;
};

/** The candidates for the last of `words` (before the prefix filter). */
async function candidates(
  words: readonly string[],
  cwd: string,
  sources: CompleteSources,
): Promise<string[]> {
  const typed = words.slice(0, -1);
  const current = words.at(-1) ?? "";
  const ctx = context(typed);
  const here = ctx.cwd ? path.resolve(cwd, ctx.cwd) : cwd;
  if (ctx.afterValueFlag) return [];
  if (current.startsWith("-")) return flagsFor(ctx.entry, ctx.sub);
  if (ctx.verb === undefined) return verbNames();
  if (ctx.verb === "help") {
    if (ctx.positionals.length === 0) return verbNames().filter((name) => name !== "help");
    const topic = findVerb(ctx.positionals[0]);
    return ctx.positionals.length === 1 && topic
      ? (topic.subcommands ?? []).map((sub) => sub.name)
      : [];
  }
  const entry = ctx.entry;
  if (!entry) return [];
  if (entry.subcommands?.length && !ctx.sub && ctx.positionals.length === 0)
    return [...new Set(entry.subcommands.map((sub) => sub.name))];
  const lead = ctx.sub ? 3 : 2;
  const slot = slotAt(positionalSlots((ctx.sub ?? entry).usage, lead), ctx.positionals.length);
  if (!slot) return [];
  if ("words" in slot) return slot.words;
  const placeholder = slot.placeholder;
  if (placeholder === "slice") return sources.slices(here);
  if (placeholder === "workspace") return sources.workspaces();
  if (placeholder === "name" && entry.name === "check") return sources.checks(here);
  if (placeholder === "name" && entry.name === "workspace" && ctx.sub?.name !== "add")
    return sources.workspaces();
  if (placeholder === "verb") return verbNames();
  return [];
}

/** The completion lines for `words`; never throws. */
export async function complete(
  words: readonly string[],
  cwd: string,
  sources: CompleteSources = defaultSources,
): Promise<string[]> {
  const current = words.at(-1) ?? "";
  try {
    return [...new Set(await candidates(words, cwd, sources))].filter(
      (word) => word.startsWith(current) && !/[\s]/u.test(word),
    );
  } catch {
    return [];
  }
}
