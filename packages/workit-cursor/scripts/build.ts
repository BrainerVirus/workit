#!/usr/bin/env bun
// Build the self-contained Cursor MCP + session-hook entries and copy the
// Cursor contract asset. Runs from the repo
// (where workspace deps resolve); target dir defaults to the package dir and
// can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cursorCommandText,
  skillDescription,
  validateSkillManifests,
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
} from "../../workit-core/src/core/skill-manifests";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const args = process.argv.slice(2);
// `--skills-only` regenerates just the committed skills/ and commands/ (no
// bundles), safe in a checkout that a host loads as a local pin.
const skillsOnly = args.includes("--skills-only");
const targetArg = args.find((arg) => !arg.startsWith("--"));
const target = targetArg ? path.resolve(targetArg) : pkgDir;
const dist = path.join(target, "dist");

if (!skillsOnly) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const entries = [
    ["mcp/run-server.ts", "mcp-server.js"],
    ["hooks/session-start.ts", "cursor-session-start.js"],
    ["hooks/workit-hook.ts", "workit-hook.js"],
  ] as const;
  for (const [entry, out] of entries) {
    const build = spawnSync(
      process.execPath,
      [
        "build",
        path.join(pkgDir, entry),
        "--outfile",
        path.join(dist, out),
        "--target",
        "node",
        "--format",
        "esm",
        // The Cursor hooks manifest invokes the entry as a direct path; the
        // shebang documents/selects the Node runtime (RR-07/PT-10).
        "--banner",
        "#!/usr/bin/env node",
      ],
      { encoding: "utf8" },
    );
    if (build.status !== 0) {
      console.error(build.stderr);
      process.exit(1);
    }
  }

  // Keep only the Cursor-native contract asset. The old shared template bundle
  // describes retired wk-* and delegation-token flows and must not ship here.
  const assets = path.join(target, "assets");
  rmSync(path.join(assets, "templates"), { recursive: true, force: true });
  const templatesSrc = path.join(coreDir, "templates");
  const contractTemplate = path.join(templatesSrc, "workit-contract.md");
  if (existsSync(contractTemplate)) {
    mkdirSync(assets, { recursive: true });
    mkdirSync(path.join(assets, "templates"), { recursive: true });
    cpSync(contractTemplate, path.join(assets, "templates", "workit-contract.md"));
  }
}

const skills = path.join(target, "skills");
rmSync(skills, { recursive: true, force: true });
rmSync(path.join(target, "vendor"), { recursive: true, force: true });
mkdirSync(skills, { recursive: true });
for (const name of WORKIT_METHOD_SKILLS) {
  const srcSkill = path.join(coreDir, "skills", name);
  if (!existsSync(srcSkill)) {
    console.error(`missing canonical Workit method skill in core: ${name}`);
    process.exit(1);
  }
  cpSync(srcSkill, path.join(skills, name), { recursive: true });
}
const sourceSkills = path.join(pkgDir, "skills");
if (existsSync(sourceSkills)) {
  const extra = validateSkillManifests(sourceSkills, WORKIT_METHOD_SKILLS, "Cursor package skills");
  if (extra) {
    console.error(extra);
    process.exit(1);
  }
}
const built = validateSkillManifests(skills, WORKIT_METHOD_SKILLS, "Cursor built skills");
if (built) {
  console.error(built);
  process.exit(1);
}
// Bare slash aliases ship next to skills so installs match the repo. They are
// generated from each skill's description (committed, like skills/, because
// Cursor discovers the plugin from git; a drift test guards the copies).
const commands = path.join(target, "commands");
rmSync(commands, { recursive: true, force: true });
mkdirSync(commands, { recursive: true });
for (const [alias, skill] of Object.entries(WORKIT_SKILL_ALIASES)) {
  const description = skillDescription(
    readFileSync(path.join(coreDir, "skills", skill, "SKILL.md"), "utf8"),
  );
  if (!description) {
    console.error(`skill ${skill} has no description for /${alias}`);
    process.exit(1);
  }
  writeFileSync(path.join(commands, `${alias}.md`), cursorCommandText(alias, skill, description));
}
console.log(
  `cursor: built ${skillsOnly ? "" : "shared MCP, native hook, assets, "}${WORKIT_METHOD_SKILLS.length} method skills and ${Object.keys(WORKIT_SKILL_ALIASES).length} commands (${target})`,
);
