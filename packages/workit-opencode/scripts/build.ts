#!/usr/bin/env bun
// Build the self-contained OpenCode plugin entry (dist/plugin.js) and copy the
// deterministic assets root (commands, skills, templates, filtered vendor).
// Runs from the repo (where workspace deps resolve); target dir defaults to the
// package dir and can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : pkgDir;

const dist = path.join(target, "dist");
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
    "--external",
    "@opencode-ai/plugin",
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
for (const sub of ["commands", "skills", "templates", "vendor/superpowers/skills"]) {
  const src = path.join(coreDir, sub);
  if (!existsSync(src)) continue;
  // Filter active vendored shell executables out of the copy.
  cpSync(src, path.join(assets, sub), {
    recursive: true,
    filter: (s: string) => !s.endsWith(".sh"),
  });
}
console.log(`opencode: built dist/plugin.js + assets/ (${target})`);
