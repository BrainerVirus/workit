import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANONICAL_SKILLS } from "../../packages/workit-core/src/core/skill-manifests";
import { listTarball, packWorkspacePackages, REPO_ROOT } from "../shared/helpers/packages";

const OPENCODE = "@brainervirus/workit-opencode";
const SUPERPOWERS = [...CANONICAL_SKILLS.superpowers].sort();
const WORKIT = [...CANONICAL_SKILLS.workit].sort();

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((pack) => pack.packageName === name)!;

// Skill dirs directly under a tarball prefix, e.g. assets/skills/<name>/SKILL.md.
const tarballSkillNames = (tarball: string, prefix: string): string[] =>
  listTarball(tarball)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith("/SKILL.md"))
    .map((entry) => entry.slice(prefix.length).split("/")[0])
    .sort();

test("opencode packed tarball ships exactly the canonical Workit and Superpowers skills", () => {
  expect(WORKIT).toHaveLength(12);
  expect(SUPERPOWERS).toHaveLength(14);
  const tarball = byName(packWorkspacePackages(), OPENCODE).tarball;
  expect(tarballSkillNames(tarball, "assets/skills/")).toEqual(WORKIT);
  expect(tarballSkillNames(tarball, "assets/vendor/superpowers/skills/")).toEqual(SUPERPOWERS);
});

const copyFixture = (root: string): string => {
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "packages"), { recursive: true });
  for (const pkg of ["workit-core", "workit-opencode"]) {
    cpSync(path.join(REPO_ROOT, "packages", pkg), path.join(repo, "packages", pkg), {
      recursive: true,
    });
  }
  writeFileSync(path.join(repo, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(repo, "node_modules"), "junction");
  return repo;
};

test("opencode build fails loudly on damaged canonical skill source before copying (finding)", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "wk-opencode-skill-gate-"));
  try {
    const buildDamaged = (name: string, damage: (repo: string) => void) => {
      const repo = copyFixture(path.join(fixture, name));
      damage(repo);
      return spawnSync(
        process.execPath,
        [
          path.join(repo, "packages/workit-opencode/scripts/build.ts"),
          path.join(fixture, `${name}-output`),
        ],
        { encoding: "utf8" },
      );
    };

    const vendorSkills = (repo: string) =>
      path.join(repo, "packages/workit-core/vendor/superpowers/skills");
    const workitSkills = (repo: string) => path.join(repo, "packages/workit-core/skills");
    const addRogue = (root: string) => {
      const rogue = path.join(root, "not-canonical");
      mkdirSync(rogue, { recursive: true });
      writeFileSync(path.join(rogue, "SKILL.md"), "# rogue\n");
    };

    const cases: { name: string; damage: (repo: string) => void; names: string[] }[] = [
      {
        name: "vendor-missing",
        damage: (repo) =>
          rmSync(path.join(vendorSkills(repo), "brainstorming"), { recursive: true }),
        names: ["brainstorming"],
      },
      {
        name: "vendor-extra",
        damage: (repo) => addRogue(vendorSkills(repo)),
        names: ["not-canonical"],
      },
      {
        name: "workit-missing",
        damage: (repo) => rmSync(path.join(workitSkills(repo), "wk-init"), { recursive: true }),
        names: ["wk-init"],
      },
      {
        name: "workit-extra",
        damage: (repo) => addRogue(workitSkills(repo)),
        names: ["not-canonical"],
      },
    ];

    for (const { name, damage, names } of cases) {
      const result = buildDamaged(name, damage);
      expect(result.status, `${name}: ${result.stdout}`).not.toBe(0);
      for (const skill of names) {
        expect(result.stderr, name).toContain(skill);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
