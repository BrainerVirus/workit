// D5 drift test 1 (decision first-try 2026-11-18): every `workit …` call an
// agent is taught must parse against the CLI registry (verb, subcommand,
// flags), so a skill, agent file, the SessionStart contract, a guide, the
// README or an unblock text never hands a model a call that fails on the
// first try. A call the registry refuses today sits in
// command-drift.baseline.json (`<file>: <call>`), which only shrinks.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkFlags } from "@/packages/workit-cli/src/help";
import { findSubcommand, findVerb } from "@/packages/workit-cli/src/verbs/registry";

const REPO = path.resolve(import.meta.dir, "..", "..");
const BASELINE = path.join(import.meta.dir, "command-drift.baseline.json");

/** Where agents read Workit calls: skills, agent files, the contract, guides, README, unblock texts. */
const SOURCES = [
  "packages/workit-core/skills",
  "packages/workit-claude-code/agents",
  "docs/guides",
  "README.md",
  "packages/workit-core/src",
  "packages/workit-cli/src",
];

const walk = (rel: string): string[] => {
  const full = path.join(REPO, rel);
  if (!statSync(full, { throwIfNoEntry: false })) return [];
  if (statSync(full).isFile()) return [rel];
  return readdirSync(full, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? entry.name === "node_modules"
          ? []
          : walk(path.join(rel, entry.name))
        : /\.(md|ts)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")
          ? [path.join(rel, entry.name)]
          : [],
    );
};

/** A placeholder word: `<x>`, `${x}`, `x|y`, `[…]` or an elision; it stands for any value. */
const PLACEHOLDER = /[<>{}$…|*]|^\.\.\.$|^x$/u;

/** Shell words of one call, quotes removed; the call ends at a pipe, chain, redirect or comment. */
const words = (call: string): string[] => {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of call.matchAll(re)) {
    const word = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[3] !== undefined && /^(?:\||&&|\|\||;|#|>|>>|2>.*|<|\$\()/u.test(word)) break;
    out.push(word.replaceAll(/^\[+|\]+$/gu, ""));
  }
  return out;
};

/** Why the registry refuses `call` (a `workit …` string), or null when it parses or is a placeholder. */
export const refusal = (call: string): string | null => {
  // A quoted message (`workit context skipped: host under load`), not a call.
  if (/: |\s—\s|\(/u.test(call)) return null;
  const argv = words(call.replaceAll("\\", "")).slice(1);
  // The global flags, wherever they stand.
  for (let at = argv.indexOf("--cwd"); at >= 0; at = argv.indexOf("--cwd")) argv.splice(at, 2);
  while (argv[0] === "--json") argv.shift();
  const [verb, ...rest] = argv;
  if (verb === undefined || verb.startsWith("-") || verb === "help" || PLACEHOLDER.test(verb))
    return null;
  const entry = findVerb(verb);
  if (!entry) return `unknown verb ${verb}`;
  if (entry.planned) return `verb ${verb} is planned, not implemented`;
  const sub = rest.find((word) => !word.startsWith("-"));
  if (
    entry.subcommands &&
    !entry.optionalSubcommand &&
    !entry.passthrough &&
    sub !== undefined &&
    !PLACEHOLDER.test(sub) &&
    sub !== "help" &&
    !findSubcommand(entry, sub)
  )
    return `unknown ${verb} subcommand ${sub}`;
  const args = rest.map((word) => (PLACEHOLDER.test(word) && !word.startsWith("-") ? "x" : word));
  const checked = checkFlags(entry, args);
  return "error" in checked ? checked.error : null;
};

const UNBLOCK = /(?:unblock|Retry as):?\s*[`"](workit [^`"\\]+)[`"]/gu;

/**
 * The `workit …` calls in a file's text. Markdown: inline code spans and
 * command lines. Source: a code span inside a string (`"run `workit x`"` or
 * an escaped one in a template) and an `unblock`/`Retry as` string; a
 * template literal that only opens with a gate's name is a message, not a call.
 */
export const callsIn = (text: string, source = false): { line: number; call: string }[] =>
  text.split("\n").flatMap((row, index) => {
    const found = source
      ? [
          ...[...row.matchAll(/\\`(workit [^`\\]+)\\`/gu)].map((match) => match[1]),
          ...[...row.matchAll(/"[^"`]*`(workit [^`"]+)`[^"]*"/gu)].map((match) => match[1]),
          ...[...row.matchAll(UNBLOCK)].map((match) => match[1]),
        ]
      : [
          ...[...row.matchAll(/`(workit [^`]+)`/gu)].map((match) => match[1]),
          ...(/^\s*(?:\$ )?workit \S/u.test(row) ? [row.trim().replace(/^\$ /u, "")] : []),
        ];
    return [...new Set(found)].map((call) => ({ line: index + 1, call: call.trim() }));
  });

/** `<file>:<line>: <call>: <why>` for every call in `text` the registry refuses. */
export const scan = (file: string, text: string): { key: string; shown: string }[] =>
  callsIn(text, file.endsWith(".ts")).flatMap(({ line, call }) => {
    const why = refusal(call);
    return why === null
      ? []
      : [{ key: `${file}: ${call}`, shown: `${file}:${line}: ${call}: ${why}` }];
  });

test("Given a skill text naming `workit fanout worktree create x --plan y`, When command-drift scans it, Then it fails naming the file and line", () => {
  const text = "# Fan out\n\nMake the worktree:\n\n`workit fanout worktree create x --plan y`\n";
  expect(
    scan("packages/workit-core/skills/workit-fanout/SKILL.md", text).map((hit) => hit.shown),
  ).toEqual([
    "packages/workit-core/skills/workit-fanout/SKILL.md:5: workit fanout worktree create x --plan y: unknown option --plan",
  ]);
});

test("Given calls the registry takes, placeholders and help, When scanned, Then nothing is reported", () => {
  const text = [
    "`workit check --cwd <worktree> <name>`",
    '`workit git --cwd <worktree> commit -m "<msg>" -- <paths>`',
    "`workit <verb> --cwd <worktree> …`",
    "`workit help fanout`",
    'unblock: "workit fanout plan <plan.json>"',
  ].join("\n");
  expect(scan("doc.md", text)).toEqual([]);
  expect(scan("doc.md", "`workit nosuchverb run`")[0]?.shown).toContain("unknown verb nosuchverb");
});

test("Given every source agents read Workit calls from, When each call parses against the registry, Then only the baselined ones fail (the baseline only shrinks)", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
  const hits = SOURCES.flatMap(walk).flatMap((file) =>
    scan(file, readFileSync(path.join(REPO, file), "utf8")),
  );
  const keys = new Set(hits.map((hit) => hit.key));
  const fresh = hits.filter((hit) => !baseline.includes(hit.key)).map((hit) => hit.shown);
  const fixed = baseline.filter((key) => !keys.has(key));
  expect(fresh, "a Workit call agents are taught does not parse").toEqual([]);
  expect(fixed, `fixed: drop these lines from ${path.basename(BASELINE)}`).toEqual([]);
});
