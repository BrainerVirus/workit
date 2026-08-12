import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const CANONICAL_SKILLS = {
  superpowers: [
    "brainstorming",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
    "writing-skills",
  ],
  workit: [
    "wk-changelog",
    "wk-commit",
    "wk-docs-refresh",
    "wk-handoff",
    "wk-implement",
    "wk-init",
    "wk-issue-update",
    "wk-meetings",
    "wk-pr",
    "wk-release-notes",
    "wk-status",
    "wk-verify",
  ],
} as const;

export const skillManifestNames = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root)
        .filter((name) => existsSync(path.join(root, name, "SKILL.md")))
        .sort()
    : [];

export const validateSkillManifests = (
  root: string,
  expected: readonly string[],
  label: string,
): string | null => {
  const actual = skillManifestNames(root);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  return missing.length === 0 && extra.length === 0
    ? null
    : `${label} mismatch at ${root} (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`;
};

export const validateCursorSkills = (pluginDir: string): string | null => {
  const workit = validateSkillManifests(
    path.join(pluginDir, "skills"),
    CANONICAL_SKILLS.workit,
    "Cursor Workit skills",
  );
  if (workit) return workit;
  const vendor = path.join(pluginDir, "vendor/superpowers/skills");
  const superpowers = validateSkillManifests(
    vendor,
    CANONICAL_SKILLS.superpowers,
    "Cursor Superpowers skills",
  );
  if (superpowers) return superpowers;

  const pending = [vendor];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (
        (statSync(file).mode & 0o111) !== 0 ||
        readFileSync(file).subarray(0, 2).toString("latin1") === "#!"
      ) {
        return `Cursor vendor contains active file: ${file}`;
      }
    }
  }
  return null;
};

if (import.meta.main) {
  const error = validateCursorSkills(process.argv[2] ?? "");
  if (error) {
    process.stderr.write(`${error}\n`);
    process.exit(1);
  }
}
