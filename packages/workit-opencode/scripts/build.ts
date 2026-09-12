#!/usr/bin/env bun
// Build the self-contained OpenCode plugin entry (dist/plugin.js) and copy the
// deterministic assets root containing the canonical method skills.
// Runs from the repo (where workspace deps resolve); target dir defaults to the
// package dir and can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKIT_METHOD_SKILLS,
  skillManifestNames,
  validateSkillManifests,
} from "../../workit-core/src/core/skill-manifests";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : pkgDir;
const sourceNames = skillManifestNames(path.join(coreDir, "skills"));
const missingSource = WORKIT_METHOD_SKILLS.filter((name) => !sourceNames.includes(name));
if (missingSource.length)
  throw new Error(`missing Workit method skills: ${missingSource.join(", ")}`);

const dist = path.join(target, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const build = spawnSync(
  "bun",
  [
    "build",
    path.join(pkgDir, "src/plugin.ts"),
    "--outfile",
    path.join(dist, "plugin.js"),
    "--target",
    "node",
    "--format",
    "esm",
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  console.error(build.stderr);
  process.exit(1);
}

// Deterministic assets: only the policy-selected method skills.
const assets = path.join(target, "assets");
rmSync(assets, { recursive: true, force: true });
const skills = path.join(assets, "skills");
mkdirSync(skills, { recursive: true });
for (const name of WORKIT_METHOD_SKILLS) {
  const source = path.join(coreDir, "skills", name);
  if (!existsSync(source)) throw new Error(`missing Workit method skill: ${source}`);
  cpSync(source, path.join(skills, name), { recursive: true });
}
const packagedWorkitError = validateSkillManifests(
  skills,
  WORKIT_METHOD_SKILLS,
  "opencode Workit packaged skills",
);
if (packagedWorkitError) throw new Error(packagedWorkitError);
console.log(
  `opencode: built dist/plugin.js + ${WORKIT_METHOD_SKILLS.length} method skills (${target})`,
);
