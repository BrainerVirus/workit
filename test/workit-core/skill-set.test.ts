import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
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
const has = (text: string, word: string) =>
  new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`, "i").test(text);

// Resident text is what every session pays before any skill loads: the
// bootstrap plus each skill's name and description. Tokens are estimated as
// characters / 4 (a proxy; no tokenizer ships offline). The 3.0 set (16
// skills) measured ~2,040 by this proxy: bootstrap ~1,550, descriptions ~490.
const RESIDENT_TOKEN_BUDGET = 1_500;
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
