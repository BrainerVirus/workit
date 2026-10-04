import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CLAUDE_ADDENDUM } from "@/packages/workit-claude-code/src/hook";
import { VERBS } from "@/packages/workit-cli/src/verbs/registry";
import { invariantBootstrap } from "@/packages/workit-core/src/core/methods";
import {
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_TRIGGERS,
  skillDescription,
} from "@/packages/workit-core/src/core/skill-manifests";

// Deterministic trigger and budget checks for the skill set (D12). Behavioral
// triggering is measured by the opt-in `claude plugin eval` suite
// (packages/workit-claude-code/evals); these keep the inputs to it honest.

const SKILLS = path.join(import.meta.dir, "../../packages/workit-core/skills");
const skillMd = (name: string) => readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
const body = (text: string) => text.slice(text.indexOf("\n---", 4) + 4);
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const has = (text: string, word: string) => new RegExp(`(^|[^a-z])${escape(word)}`, "i").test(text);
const hasWord = (text: string, word: string) =>
  new RegExp(`(^|[^a-z])${escape(word)}($|[^a-z])`, "i").test(text);

// Resident text is what every session pays before any skill loads: the
// bootstrap plus each skill's name and description. Tokens are estimated as
// characters / 4 (a proxy; no tokenizer ships offline). The 3.0 set (16
// skills) measured ~2,040 by this proxy: bootstrap ~1,550, descriptions ~490.
const RESIDENT_TOKEN_BUDGET = 1_600;
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

test("Given every skill, Then its description says what and when within 250 characters and carries all of its trigger words", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const text = skillMd(name);
    expect(text, name).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    const description = skillDescription(text);
    expect(description.length, name).toBeGreaterThan(80);
    expect(description.length, name).toBeLessThanOrEqual(250);
    // A plain YAML scalar cannot hold ": "; a stricter host parser would drop the skill.
    expect(description, name).not.toContain(": ");
    expect(description, name).toMatch(/\. Use (for|before|when) /);
    for (const word of WORKIT_SKILL_TRIGGERS[name])
      expect(has(description, word), `${name} description lacks "${word}"`).toBe(true);
  }
});

test("Given the trigger lists, Then no trigger word routes to two skills", () => {
  const owner = new Map<string, string>();
  for (const [skill, words] of Object.entries(WORKIT_SKILL_TRIGGERS))
    for (const word of words) {
      const key = word.toLowerCase();
      expect(owner.get(key), `"${word}" is claimed by ${owner.get(key)} and ${skill}`).toBe(
        undefined,
      );
      owner.set(key, skill);
    }
  expect(Object.keys(WORKIT_SKILL_TRIGGERS).toSorted()).toEqual(
    [...WORKIT_METHOD_SKILLS].toSorted(),
  );
});

test("Given the bootstrap routing table, Then each skill has one line naming all of its triggers", () => {
  const lines = invariantBootstrap().split("\n");
  for (const name of WORKIT_METHOD_SKILLS) {
    const routes = lines.filter((line) => line.startsWith("- ") && line.endsWith(`: ${name}`));
    expect(routes, name).toHaveLength(1);
    for (const word of WORKIT_SKILL_TRIGGERS[name])
      expect(has(routes[0], word), `${name} route lacks "${word}"`).toBe(true);
  }
});

test("Given every skill body, Then it is short, shows one good and bad example, and ends on a runnable check", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const text = body(skillMd(name));
    expect(text.trim().split("\n").length, name).toBeLessThanOrEqual(66);
    expect(text, name).toContain("## Example");
    expect(text, name).toMatch(/\nBad( fix| brief)?: /);
    expect(text, name).toMatch(/\nGood( fix| brief)?: /);
    const check = text.slice(text.lastIndexOf("\n## "));
    expect(check.startsWith("\n## Check"), `${name} must end with ## Check`).toBe(true);
    expect(check, name).toMatch(/```sh\n(workit|git) /);
  }
});

test("Given every reference a skill points to, Then the file exists beside it", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    for (const [, ref] of skillMd(name).matchAll(/`(references\/[a-z-]+\.md)`/g))
      expect(existsSync(path.join(SKILLS, name, ref)), `${name}: ${ref}`).toBe(true);
    const refs = path.join(SKILLS, name, "references");
    if (existsSync(refs))
      for (const file of readdirSync(refs))
        expect(skillMd(name), `${name} never points to references/${file}`).toContain(
          `references/${file}`,
        );
  }
});

test("Given the skills, Then none repeats the bootstrap's operation-family boilerplate", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const text = skillMd(name);
    expect(text, name).not.toMatch(
      /shared `?(task|evidence|policy|finding|writer|state)`? operations?/,
    );
    expect(text, name).not.toContain("second lifecycle");
    expect(text, name).not.toContain("metadata directly");
  }
});

test(`Given the resident text, Then bootstrap plus descriptions stay within ${RESIDENT_TOKEN_BUDGET} estimated tokens`, () => {
  const descriptions = WORKIT_METHOD_SKILLS.map(
    (name) => `${name}: ${skillDescription(skillMd(name))}`,
  ).join("\n");
  const resident = estimateTokens(`${invariantBootstrap()}\n${descriptions}`);
  expect(resident).toBeLessThanOrEqual(RESIDENT_TOKEN_BUDGET);
});

test("Given every description, Then it carries no other skill's trigger word", () => {
  for (const name of WORKIT_METHOD_SKILLS) {
    const description = skillDescription(skillMd(name));
    for (const [other, words] of Object.entries(WORKIT_SKILL_TRIGGERS))
      if (other !== name)
        for (const word of words)
          expect(
            hasWord(description, word),
            `${name} description contains ${other}'s "${word}"`,
          ).toBe(false);
  }
});

// Every `workit <verb> …` an agent is told to run must parse: the verb exists,
// a subcommand is one the verb's usage lists, and each flag is one the verb's
// source handles. Commit spans must name what to commit (`--all` or paths).
const REPO = path.join(import.meta.dir, "../..");
const VERB_SOURCES = path.join(REPO, "packages/workit-cli/src/verbs");
const SUBCOMMAND_VERBS = new Set(["git", "pr", "ci", "stack", "ledger", "verify-delivery"]);
const GLOBAL_FLAGS = new Set(["--json", "--cwd", "--help"]);

const agentFacingTexts = (): Array<[string, string]> => {
  const out: Array<[string, string]> = [
    ["bootstrap", invariantBootstrap()],
    ["claude addendum", CLAUDE_ADDENDUM],
  ];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".md"))
        out.push([path.relative(REPO, file), readFileSync(file, "utf8")]);
    }
  };
  walk(SKILLS);
  walk(path.join(REPO, "packages/workit-claude-code/agents"));
  return out;
};

/** `workit …` invocations inside code spans and sh blocks, cut at shell operators. */
const invocations = (text: string): string[] => {
  const code = [
    ...[...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]),
    ...[...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((match) => match[1].split("\n")),
  ];
  return code.flatMap((span) =>
    [...span.matchAll(/(?:^|[\s"(=])workit ([a-z][a-z-]*(?: [^|;&#)]*)?)/g)].map((match) =>
      match[1].trim(),
    ),
  );
};

test("Given every workit command in skills, references, agents and the bootstrap, Then it matches the real CLI grammar", () => {
  const verbs = new Map(VERBS.map((verb) => [verb.name, verb]));
  let checked = 0;
  for (const [source, text] of agentFacingTexts())
    for (const call of invocations(text)) {
      const [verb, sub] = call.split(/\s+/);
      if (verb === "help" || verb === "verb") continue;
      const entry = verbs.get(verb);
      expect(entry, `${source}: unknown verb in "workit ${call}"`).toBeDefined();
      if (!entry) continue;
      checked++;
      if (SUBCOMMAND_VERBS.has(verb) && sub && /^[a-z]/.test(sub))
        expect(
          hasWord(entry.usage, sub),
          `${source}: "workit ${call}" (usage: ${entry.usage})`,
        ).toBe(true);
      const file = path.join(VERB_SOURCES, `${verb}.ts`);
      const handled = existsSync(file)
        ? readFileSync(file, "utf8") +
          readFileSync(path.join(VERB_SOURCES, "forge-common.ts"), "utf8")
        : entry.usage;
      for (const [flag] of call.matchAll(/--[a-z][a-z-]*/g))
        if (!GLOBAL_FLAGS.has(flag))
          expect(
            handled.includes(flag) || handled.includes(`${flag.slice(2)}:`),
            `${source}: "workit ${call}" uses ${flag}`,
          ).toBe(true);
      if (verb === "git" && sub === "commit")
        expect(
          / --all\b| -- \S/.test(call),
          `${source}: "workit ${call}" names nothing to commit`,
        ).toBe(true);
    }
  expect(checked).toBeGreaterThan(40);
});
