import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const WORKIT_METHOD_SKILLS = [
  "workit-shape",
  "workit-implement",
  "workit-review",
  "workit-debug",
  "workit-ship",
  "workit-continue",
  "workit-bdd",
  "workit-test-audit",
  "workit-deslop",
  "workit-fanout",
  "workit-verify-app",
  "workit-retro",
] as const;

export type WorkitSkill = (typeof WORKIT_METHOD_SKILLS)[number];

/** wk- slash aliases (one per skill): alias → method skill. An alias routes
 * through policy to model skills; an alias never calls another alias. */
export const WORKIT_SKILL_ALIASES = {
  "wk-shape": "workit-shape",
  "wk-implement": "workit-implement",
  "wk-review": "workit-review",
  "wk-debug": "workit-debug",
  "wk-ship": "workit-ship",
  "wk-continue": "workit-continue",
  "wk-bdd": "workit-bdd",
  "wk-test-audit": "workit-test-audit",
  "wk-deslop": "workit-deslop",
  "wk-fanout": "workit-fanout",
  "wk-verify-app": "workit-verify-app",
  "wk-retro": "workit-retro",
} as const satisfies Record<string, WorkitSkill>;

/**
 * The words a user types that should load each skill. Each skill's
 * description and its bootstrap routing line carry every one of them, and no
 * two skills share one (checked by test), so a trigger routes to one skill.
 */
export const WORKIT_SKILL_TRIGGERS: Readonly<Record<WorkitSkill, readonly string[]>> = {
  "workit-shape": ["brainstorm", "plan", "spec", "grill", "should we"],
  "workit-implement": ["implement", "build", "add a feature"],
  "workit-review": ["review", "blast radius"],
  "workit-debug": ["bug", "broken", "flaky", "regression"],
  "workit-ship": ["ship", "babysit", "CI", "merge"],
  "workit-continue": ["resume", "pick up", "handoff", "interruption"],
  "workit-bdd": ["BDD", "TDD", "acceptance criteria", "Given/When/Then"],
  "workit-test-audit": ["test audit", "tautology", "weak tests"],
  "workit-deslop": ["deslop", "slop", "dead code"],
  "workit-fanout": ["fan out", "parallelize", "parallel agents", "swarm"],
  "workit-verify-app": ["verify the app", "smoke test", "prove it works"],
  "workit-retro": ["retro"],
};

/** The `description:` frontmatter value of a SKILL.md (one line, unquoted). */
export const skillDescription = (skillMd: string): string => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? "";
  const line = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? "";
  return line.trim().replace(/^(["'])(.*)\1$/, "$2");
};

/** A generated Cursor slash command for one alias; `commands/` is committed
 * because Cursor discovers the plugin from git, so the build writes these and
 * a drift test compares them to the committed copies. */
export const cursorCommandText = (alias: string, skill: string, description: string): string =>
  `# /${alias}\n\nLoad and apply the bundled \`${skill}\` skill. ${description}\n\nExtra context: $ARGUMENTS\n`;

export const skillManifestNames = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root)
        .filter((name) => existsSync(path.join(root, name, "SKILL.md")))
        .toSorted()
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
