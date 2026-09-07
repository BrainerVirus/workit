#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  WORKIT_METHOD_SKILLS,
  validateSkillManifests,
} from "../../workit-core/src/core/skill-manifests";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.resolve(packageDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : packageDir;
const dist = path.join(target, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const build = spawnSync(
  process.execPath,
  [
    "build",
    path.join(packageDir, "extensions/workit.ts"),
    "--outfile",
    path.join(dist, "workit.js"),
    "--target",
    "node",
    "--format",
    "esm",
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
const workerBuild = spawnSync(
  process.execPath,
  [
    "build",
    path.join(packageDir, "src/worker.ts"),
    "--outfile",
    path.join(dist, "worker.js"),
    "--target",
    "node",
    "--format",
    "esm",
  ],
  { encoding: "utf8" },
);
if (workerBuild.status !== 0) throw new Error(workerBuild.stderr || workerBuild.stdout);
const skills = path.join(target, "skills");
rmSync(skills, { recursive: true, force: true });
mkdirSync(skills, { recursive: true });
for (const name of WORKIT_METHOD_SKILLS)
  cpSync(path.join(coreDir, "skills", name), path.join(skills, name), { recursive: true });
const error = validateSkillManifests(skills, WORKIT_METHOD_SKILLS, "Pi Workit skills");
if (error) throw new Error(error);
console.log(`pi: built extension and seven method skills (${target})`);
