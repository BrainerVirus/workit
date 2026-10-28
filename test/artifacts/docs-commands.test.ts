import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkFlags, usageLines } from "@/packages/workit-cli/src/help";
import { findSubcommand, findVerb } from "@/packages/workit-cli/src/verbs/registry";

// Docs drift gate (#489): every `workit <verb> [<sub>]` the user-facing docs
// show, in a fenced block or inline code, names a registered verb (and a
// registered subcommand where the verb requires one), and every --flag it
// shows passes the same check the router runs before a verb loads.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

const markdownUnder = (dir: string): string[] =>
  readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(rel);
    return entry.name.endsWith(".md") ? [rel] : [];
  });

// Mentions of commands that do not exist, on purpose: removed verbs in the
// migration notes, the wrong spelling a hint corrects, hook message prefixes.
const INTENTIONAL = new Set([
  "workit cutover", // removed in 3.0 (migration notes)
  "workit action", // removed in 6.0 (migration notes)
  "workit status", // the wrong form whose unblock names `workit task status`
  "workit migration pending", // a hook message
  "workit context skipped", // a hook message
]);

const DOCS = (): string[] => [
  "README.md",
  "CONTRIBUTING.md",
  ...markdownUnder("docs/guides"),
  ...markdownUnder("docs/agents"),
  ...readdirSync(path.join(REPO_ROOT, "packages")).map((name) =>
    path.join("packages", name, "README.md"),
  ),
];

/** Code spans and fenced-block lines of a Markdown document, with their line numbers. */
function codeSnippets(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  markdown.split("\n").forEach((raw, index) => {
    if (/^\s*(```|~~~)/u.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      out.push({ line: index + 1, text: raw });
      return;
    }
    for (const match of raw.matchAll(/(`+)([^`]+?)\1/gu))
      out.push({ line: index + 1, text: match[2] });
  });
  return out;
}

// Where a command ends: a pipe, a chain, a redirect, a comment, prose after a dash.
const COMMAND_END = /\s(?:\||&&|\|\||;|>|2>|#|—|–)\s?|[;)]$/u;

/** Shell-like words, quotes kept as one word. */
const words = (command: string): string[] =>
  [...command.matchAll(/"[^"]*"|'[^']*'|\S+/gu)].map((match) => match[0]);

const PLACEHOLDER = /^[<[{(…]|^\.\.\.|^\$|…$/u;

/** Every `workit …` invocation in one snippet, from the verb on. */
function invocations(text: string): string[][] {
  const found: string[][] = [];
  for (const match of text.matchAll(/(?<![\w./@"'-])workit\s+(?=[-a-z])/gu)) {
    let rest = text.slice((match.index ?? 0) + match[0].length);
    const end = COMMAND_END.exec(rest);
    if (end) rest = rest.slice(0, end.index);
    const argv = words(rest.trim()).map((word) => word.replace(/[,.:]$/u, ""));
    // Global options the router consumes before the verb.
    while (argv.length > 0) {
      if (argv[0] === "--json") argv.shift();
      else if (argv[0] === "--cwd" || argv[0] === "--session") argv.splice(0, 2);
      else if (/^--(cwd|session)=/u.test(argv[0])) argv.shift();
      else break;
    }
    if (argv.length > 0) found.push(argv);
  }
  return found;
}

const BUILTINS = new Set(["help", "--help", "-h", "--version", "-v", "version"]);

/** What is wrong with one invocation, or null. */
function problem(argv: string[]): string | null {
  const [verb, ...args] = argv;
  if (PLACEHOLDER.test(verb)) return null;
  if (BUILTINS.has(verb)) {
    const [topic, sub] = args;
    if (verb !== "help" || topic === undefined || PLACEHOLDER.test(topic)) return null;
    const entry = findVerb(topic);
    if (!entry) return `unknown verb "${topic}"`;
    if (sub !== undefined && !PLACEHOLDER.test(sub) && !findSubcommand(entry, sub))
      return `unknown ${topic} subcommand "${sub}"`;
    return null;
  }
  if (!/^[a-z][a-z-]*$/u.test(verb)) return null;
  const entry = findVerb(verb);
  if (!entry) return `unknown verb "${verb}"`;
  const next = args[0];
  // A verb whose subcommand is optional may still not take a positional there.
  const positionalFirst = usageLines(entry).some((line) => line.startsWith(`workit ${verb} <`));
  if (
    entry.subcommands?.length &&
    !entry.passthrough &&
    !positionalFirst &&
    next !== undefined &&
    /^[a-z][a-z-]*$/u.test(next) &&
    !findSubcommand(entry, next)
  )
    return `unknown ${verb} subcommand "${next}"`;
  const flags = args.map((word) => word.replace(/^\[|\]$/gu, ""));
  const checked = checkFlags(entry, flags);
  return "error" in checked ? `${checked.error} (${checked.unblock})` : null;
}

function findings(file: string, markdown: string): string[] {
  return codeSnippets(markdown).flatMap(({ line, text }) =>
    invocations(text).flatMap((argv) => {
      const shown = `workit ${argv.join(" ")}`;
      if ([...INTENTIONAL].some((mention) => shown === mention || shown.startsWith(`${mention} `)))
        return [];
      const why = problem(argv);
      return why ? [`${file}:${line}: ${shown}\n    ${why}`] : [];
    }),
  );
}

test("the gate catches a seeded fake verb, subcommand and flag", () => {
  const seeded = [
    "Run `workit frobnicate` first.",
    "```bash",
    "workit workspace frobnicate work",
    "workit check lint --no-such-flag",
    "workit upgrade --preview   # fine",
    "```",
  ].join("\n");
  const found = findings("seeded.md", seeded);
  expect(found).toHaveLength(3);
  expect(found[0]).toContain('unknown verb "frobnicate"');
  expect(found[1]).toContain('unknown workspace subcommand "frobnicate"');
  expect(found[2]).toContain("unknown option --no-such-flag");
});

test("every workit command the docs show exists, with flags its verb accepts", () => {
  const all = DOCS().flatMap((rel) => {
    let text: string;
    try {
      text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      return [];
    }
    return findings(rel, text);
  });
  expect(all.join("\n")).toBe("");
});
