// Docs drift gate, part two (#489): README's CLI reference table names every
// registered verb and every one of its subcommands, and nothing the registry
// does not have. test/artifacts/docs-commands.test.ts parses each `workit …`
// line the docs show; this one catches the table falling behind a new verb
// or subcommand, which no parse check sees.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  findSubcommand,
  findVerb,
  TASK_FAMILY_NAMES,
  VERBS,
} from "@/packages/workit-cli/src/verbs/registry";

const README = path.resolve(import.meta.dir, "..", "..", "README.md");
const HEADING = "## CLI reference";

type Row = { line: number; verb: string; subcommands: string[]; families: string[] };

const SUBCOMMANDS = /^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/u;

/** The `| \`workit …\` | … |` rows under the CLI reference heading, with their line numbers. */
function tableRows(markdown: string): Row[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(HEADING);
  if (start < 0) return [];
  const rows: Row[] = [];
  for (let index = start + 1; index < lines.length && !lines[index].startsWith("## "); index += 1) {
    const cells = lines[index].split(/(?<!\\)\|/u).map((cell) => cell.trim());
    const command = /^`(workit [^`]+)`/u.exec(cells[1] ?? "")?.[1];
    if (command === undefined) continue;
    const [, verb = "", next = ""] = command.replaceAll("\\|", "|").split(/\s+/u);
    rows.push({
      line: index + 1,
      verb,
      subcommands: SUBCOMMANDS.test(next) ? next.split("|") : [],
      // The task-family row names its families in the purpose cell.
      families:
        verb === "<family>"
          ? [...(cells[2] ?? "").matchAll(/`([a-z]+)`/gu)].map((match) => match[1])
          : [],
    });
  }
  return rows;
}

/** What the table gets wrong against the registry, one line each. */
function tableDrift(markdown: string): string[] {
  const rows = tableRows(markdown);
  if (rows.length === 0) return [`README.md: no command table under "${HEADING}"`];
  const out: string[] = [];
  const named = new Map<string, Set<string>>();
  const families = new Set(rows.flatMap((row) => row.families));
  for (const row of rows) {
    if (row.verb === "<family>") continue;
    const entry = findVerb(row.verb);
    if (!entry) {
      out.push(`README.md:${row.line}: unknown verb "${row.verb}"`);
      continue;
    }
    const seen = named.get(entry.name) ?? new Set<string>();
    // A verb without subcommands takes a positional there (`completion zsh|bash`).
    for (const sub of entry.subcommands ? row.subcommands : []) {
      const found = findSubcommand(entry, sub);
      if (found) seen.add(found.name);
      else out.push(`README.md:${row.line}: unknown ${entry.name} subcommand "${sub}"`);
    }
    named.set(entry.name, seen);
  }
  const family = new Set<string>(TASK_FAMILY_NAMES);
  for (const name of families)
    if (!family.has(name)) out.push(`README.md: the <family> row names "${name}", not a family`);
  for (const entry of VERBS) {
    if (entry.planned) continue;
    if (family.has(entry.name)) {
      if (!families.has(entry.name) && !named.has(entry.name))
        out.push(`README.md: no row for the "${entry.name}" family`);
      continue;
    }
    const seen = named.get(entry.name);
    if (!seen) {
      out.push(`README.md: no row for \`workit ${entry.name}\``);
      continue;
    }
    for (const sub of entry.subcommands ?? [])
      if (!seen.has(sub.name))
        out.push(`README.md: no row names \`workit ${entry.name} ${sub.name}\``);
  }
  return out;
}

test("Given a table with a made-up verb, a made-up subcommand and a missing verb, Then each is named with its line", () => {
  const table = [
    "# Workit",
    "",
    HEADING,
    "",
    "| Command | Purpose |",
    "| --- | --- |",
    "| `workit frobnicate` | Not a verb |",
    "| `workit pr status\\|frob` | One real, one made up |",
  ].join("\n");
  const drift = tableDrift(table);
  expect(drift).toContain('README.md:7: unknown verb "frobnicate"');
  expect(drift).toContain('README.md:8: unknown pr subcommand "frob"');
  expect(drift).toContain("README.md: no row names `workit pr create`");
  expect(drift).toContain("README.md: no row for `workit init`");
  expect(drift).toContain('README.md: no row for the "policy" family');
});

test("Given README's CLI reference table, Then it names every registered verb and subcommand and nothing else", () => {
  expect(tableDrift(readFileSync(README, "utf8")).join("\n")).toBe("");
});
