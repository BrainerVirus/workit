import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const VENDOR = path.resolve(import.meta.dir, "../packages/workit/vendor/superpowers");

const REQUIRED_SKILLS = [
  "brainstorming", "dispatching-parallel-agents", "executing-plans",
  "finishing-a-development-branch", "receiving-code-review", "requesting-code-review",
  "subagent-driven-development", "systematic-debugging", "test-driven-development",
  "using-git-worktrees", "using-superpowers", "verification-before-completion",
  "writing-plans", "writing-skills",
];

test("vendored skills dir contains all 14 upstream skills", () => {
  const dirs = readdirSync(path.join(VENDOR, "skills")).filter((d) =>
    existsSync(path.join(VENDOR, "skills", d, "SKILL.md")));
  for (const skill of REQUIRED_SKILLS) {
    expect(dirs).toContain(skill);
  }
});

test("each vendored SKILL.md has valid frontmatter with name + description", () => {
  for (const dir of readdirSync(path.join(VENDOR, "skills"))) {
    const file = path.join(VENDOR, "skills", dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fm, `${dir} missing frontmatter`).not.toBeNull();
    expect(fm![1]).toMatch(/^name:/m);
    expect(fm![1]).toMatch(/^description:/m);
  }
});

test("VERSION file exists and NOTICE.md documents provenance", () => {
  const version = readFileSync(path.join(VENDOR, "VERSION"), "utf8").trim();
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const notice = readFileSync(path.join(VENDOR, "NOTICE.md"), "utf8");
  expect(notice).toContain("obra/superpowers");
  expect(notice).toContain("MIT");
  expect(notice).toContain("update-superpowers.sh");
});
