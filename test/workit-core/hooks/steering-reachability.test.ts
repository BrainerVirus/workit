// Every `workit …` command a hook text suggests (a nudge, a denial's unblock,
// the start and stop texts, the bootstrap) names a real verb and subcommand
// in the CLI registry: a stale suggestion sends an agent to a dead end, and
// then to raw git (#428).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findSubcommand, findVerb } from "@/packages/workit-cli/src/verbs/registry";

const root = path.resolve(import.meta.dir, "../../..");
const SOURCES = [
  "packages/workit-core/src/hooks/raw-git.ts",
  "packages/workit-core/src/hooks/heavy-gate.ts",
  "packages/workit-core/src/hooks/stop.ts",
  "packages/workit-core/src/hooks/handle.ts",
  "packages/workit-core/src/hooks/steering.ts",
  "packages/workit-core/src/hooks/context.ts",
  "packages/workit-core/src/core/methods.ts",
];

/** Options that come before the verb (`workit --session <id> git …`). */
const GLOBAL = /^--(?:cwd|session|token|as)$/;

/** The `workit …` commands quoted in a source: backticks or quote("…"). */
const suggestions = (source: string): string[] => {
  const text = readFileSync(path.join(root, source), "utf8");
  const found = [
    ...text.matchAll(/\\?`(workit [^`\\]+)\\?`/g),
    ...text.matchAll(/quote\(\s*[`"](workit [^`"$]+)/g),
  ];
  return found.map((match) => match[1].replace(/\$\{[^}]*\}?/g, "<x>").trim());
};

/** Why a suggested command is not one the CLI runs, or null. */
const unreachable = (command: string): string | null => {
  const words = command.split(/\s+/).slice(1);
  while (words.length && GLOBAL.test(words[0])) words.splice(0, 2);
  const [verb, sub] = words;
  if (!verb || !/^[a-z][a-z-]*$/.test(verb)) return null;
  // `workit help <verb>` is the router's own; its operand is a verb.
  if (verb === "help") return !sub || findVerb(sub) ? null : `no verb ${sub}`;
  const entry = findVerb(verb);
  if (!entry) return `no verb ${verb}`;
  if (!entry.subcommands?.length || !sub || !/^[a-z][a-z-]*$/.test(sub)) return null;
  return findSubcommand(entry, sub) ? null : `no subcommand ${verb} ${sub}`;
};

test("G every hook and bootstrap text, W it suggests a workit command, T the CLI registry has that verb and subcommand", () => {
  const all = SOURCES.flatMap((source) =>
    suggestions(source).map((command) => ({ source, command })),
  );
  expect(all.length).toBeGreaterThan(20);
  const stale = all
    .map(({ source, command }) => ({ source, command, why: unreachable(command) }))
    .filter((entry) => entry.why);
  expect(stale).toEqual([]);
});

test("G a suggestion naming a verb the CLI lacks, W checked, T it is reported", () => {
  expect(unreachable("workit git status")).toBe("no subcommand git status");
  expect(unreachable("workit lock run -- x")).toBeNull();
  expect(unreachable("workit nope")).toBe("no verb nope");
  expect(unreachable("workit help nope")).toBe("no verb nope");
  expect(unreachable("workit --session s git commit -m x")).toBeNull();
});
