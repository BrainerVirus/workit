// The agents that record ledger verdicts follow a skill (workit-review,
// verify-<app>): a Claude Code `tools:` allowlist without Skill would forbid
// loading it (audit 2026-10-13 RC1).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const agents = path.resolve(import.meta.dir, "../../packages/workit-claude-code/agents");

const frontmatter = (file: string): Record<string, string> => {
  const text = readFileSync(path.join(agents, file), "utf8");
  const block = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .map((line) => /^([A-Za-z]+):\s*(.*)$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
};

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

for (const file of ["verifier.md", "reviewer.md"])
  test(`Given the Claude Code ${file} agent, When it lists its tools, Then Skill is allowed and never disallowed`, () => {
    const meta = frontmatter(file);
    // No allowlist inherits every tool, Skill included; an allowlist must name it.
    if (meta.tools !== undefined) expect(list(meta.tools)).toContain("Skill");
    expect(list(meta.disallowedTools)).not.toContain("Skill");
    // Still read-only.
    expect(list(meta.tools)).not.toContain("Write");
    expect(list(meta.tools)).not.toContain("Edit");
  });
