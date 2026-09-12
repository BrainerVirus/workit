import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const WORKIT_METHOD_SKILLS = [
  "workit-challenge",
  "workit-behavioral-tdd",
  "workit-review",
  "workit-plan",
  "workit-implement",
  "workit-debug",
  "workit-handoff",
  "workit-babysit",
  "workit-blast-radius",
  "workit-deslop",
  "workit-diagram",
  "workit-mockup",
  "workit-green-run",
  "workit-steer",
] as const;

/** wk- slash aliases (one per skill): alias → method skill. An alias routes
 * through policy to model skills; an alias never calls another alias. */
export const WORKIT_SKILL_ALIASES = {
  "wk-challenge": "workit-challenge",
  "wk-babysit": "workit-babysit",
  "wk-implement": "workit-implement",
  "wk-plan": "workit-plan",
  "wk-debug": "workit-debug",
  "wk-review": "workit-review",
  "wk-handoff": "workit-handoff",
  "wk-tdd": "workit-behavioral-tdd",
  "wk-blast-radius": "workit-blast-radius",
  "wk-deslop": "workit-deslop",
  "wk-diagram": "workit-diagram",
  "wk-mockup": "workit-mockup",
  "wk-green-run": "workit-green-run",
  "wk-steer": "workit-steer",
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

export const validateCursorSkills = (
  pluginDir: string,
  expected: readonly string[] = WORKIT_METHOD_SKILLS,
): string | null => {
  const workit = validateSkillManifests(
    path.join(pluginDir, "skills"),
    expected,
    "Cursor Workit skills",
  );
  if (workit) return workit;
  const pending = [path.join(pluginDir, "skills")];
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
