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
// characters / 4 (a proxy; no tokenizer ships offline). This is a regression
// guard against the 3.0 skill set (16 skills), measured by the same proxy.
const BASELINE_3_0_TOKENS = 2_036; // bootstrap ~1,547 + descriptions ~490
const RESIDENT_TOKEN_BUDGET = Math.min(1_700, Math.floor(BASELINE_3_0_TOKENS * 0.85));
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

test("Given the skill frontmatter, Then only workit-retro is user-invoked and its route says so", () => {
  const userInvoked = WORKIT_METHOD_SKILLS.filter((name) =>
    /^disable-model-invocation:\s*true\s*$/m.test(skillMd(name).split("\n---")[0]),
  );
  expect(userInvoked).toEqual(["workit-retro"]);
  const route = invariantBootstrap()
    .split("\n")
    .find((line) => line.endsWith(": workit-retro"));
  expect(route).toContain("user-invoked");
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
const SUBCOMMAND_VERBS = new Set([
  "git",
  "pr",
  "ci",
  "stack",
  "ledger",
  "verify-delivery",
  "grant",
  "knowledge",
]);
const GLOBAL_FLAGS = new Set(["--json", "--cwd", "--help"]);
// Verbs the skills already name ahead of their slice; drop each when it lands.
const PLANNED_VERBS = new Set<string>();

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

/**
 * The grammar a subcommand documents in its verb source: every usage line that
 * names `workit <verb> <sub>` (also inside `a|sub` lists) plus the comment
 * continuation lines under it. Verbs without per-subcommand usage fall back
 * to the whole source.
 */
const grammarFor = (verb: string, sub: string | undefined, fallback: string): string => {
  const file = path.join(VERB_SOURCES, `${verb}.ts`);
  if (!existsSync(file)) return fallback;
  const source = readFileSync(file, "utf8");
  if (!sub || !/^[a-z]/.test(sub)) return source;
  const lines = source.split("\n");
  const names = new RegExp(`workit ${escape(verb)} (?:[a-z-]+\\|)*${escape(sub)}(?![a-z-])`);
  const picked: string[] = [];
  lines.forEach((line, index) => {
    if (!names.test(line)) return;
    picked.push(line);
    for (let next = index + 1; /^\/\/\s+\[/.test(lines[next] ?? ""); next++)
      picked.push(lines[next]);
  });
  return picked.length ? picked.join("\n") : source;
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
      if (verb === "help" || verb === "verb" || PLANNED_VERBS.has(verb)) continue;
      const entry = verbs.get(verb);
      expect(entry, `${source}: unknown verb in "workit ${call}"`).toBeDefined();
      if (!entry) continue;
      checked++;
      if (SUBCOMMAND_VERBS.has(verb) && sub && /^[a-z]/.test(sub))
        expect(
          hasWord(entry.usage, sub),
          `${source}: "workit ${call}" (usage: ${entry.usage})`,
        ).toBe(true);
      const handled = grammarFor(verb, SUBCOMMAND_VERBS.has(verb) ? sub : undefined, entry.usage);
      for (const [flag] of call.matchAll(/--[a-z][a-z-]*/g))
        if (!GLOBAL_FLAGS.has(flag))
          expect(handled.includes(flag), `${source}: "workit ${call}" uses ${flag}`).toBe(true);
      if (verb === "git" && sub === "commit")
        expect(
          / --all\b| -- \S/.test(call),
          `${source}: "workit ${call}" names nothing to commit`,
        ).toBe(true);
    }
  expect(checked).toBeGreaterThan(40);
});
