#!/usr/bin/env bun
// Build the self-contained OpenCode plugin entry (dist/plugin.js) and copy the
// deterministic assets root (commands, skills, templates, filtered vendor).
// Runs from the repo (where workspace deps resolve); target dir defaults to the
// package dir and can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_SKILLS,
  validateSkillManifests,
} from "../../workit-core/src/core/skill-manifests";
import { copySanitizedVendor } from "../../workit-core/scripts/vendor-assets";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : pkgDir;
const vendorSkills = path.join(coreDir, "vendor/superpowers/skills");

const sourceWorkitError = validateSkillManifests(
  path.join(coreDir, "skills"),
  CANONICAL_SKILLS.workit,
  "opencode Workit source skills",
);
if (sourceWorkitError) throw new Error(sourceWorkitError);

const sourceVendorError = validateSkillManifests(
  vendorSkills,
  CANONICAL_SKILLS.superpowers,
  "core Superpowers vendor",
);
if (sourceVendorError) throw new Error(sourceVendorError);

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

// Deterministic assets: commands, skills, templates, filtered vendor content.
const assets = path.join(target, "assets");
rmSync(assets, { recursive: true, force: true });
for (const sub of ["commands", "skills", "templates"]) {
  const src = path.join(coreDir, sub);
  if (!existsSync(src)) continue;
  cpSync(src, path.join(assets, sub), { recursive: true });
}
copySanitizedVendor(
  vendorSkills,
  path.join(assets, "vendor/superpowers/skills"),
);
console.log(`opencode: built dist/plugin.js + assets/ (${target})`);
