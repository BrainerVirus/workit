import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WORKIT_METHOD_SKILLS,
  renderSkillText,
} from "@/packages/workit-core/src/core/skill-manifests";

// A skill named only in prose does not reliably load, so each host build
// rewrites a canonical `(workit-<skill>)` reference into that host's own way
// of loading a skill.

const SKILLS = path.join(import.meta.dir, "../../packages/workit-core/skills");
const skillMd = (name: string) => readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");

test("Given a canonical skill reference, When rendered for each host, Then it names that host's load mechanism", () => {
  const text = "see a test fail first (workit-bdd).";
  expect(renderSkillText(text, "claude-code")).toBe(
    "see a test fail first (call the Skill tool with `workit:bdd`).",
  );
  expect(renderSkillText(text, "opencode")).toBe(
    "see a test fail first (call the skill tool with `workit-bdd`).",
  );
  for (const host of ["cursor", "codex", "pi"] as const)
    expect(renderSkillText(text, host), host).toBe(
      "see a test fail first (read the `workit-bdd` skill's SKILL.md and follow it).",
    );
});

test("Given a parenthesis that names no method skill, When rendered, Then it is left alone", () => {
  expect(renderSkillText("mark it (workit-test-audit-ignore)", "claude-code")).toBe(
    "mark it (workit-test-audit-ignore)",
  );
  expect(renderSkillText("(workit-unknown)", "claude-code")).toBe("(workit-unknown)");
});

test("Given the canonical skills, When rendered for Claude Code, Then every parenthesized skill reference becomes a Skill tool call", () => {
  const rendered = WORKIT_METHOD_SKILLS.map((name) =>
    renderSkillText(skillMd(name), "claude-code"),
  );
  for (const text of rendered)
    for (const name of WORKIT_METHOD_SKILLS) expect(text).not.toContain(`(${name})`);
  expect(renderSkillText(skillMd("workit-implement"), "claude-code")).toContain(
    "(call the Skill tool with `workit:bdd`)",
  );
});
