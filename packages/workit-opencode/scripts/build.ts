#!/usr/bin/env bun
// Build the self-contained OpenCode plugin entry (dist/plugin.js) and copy the
// deterministic assets root (commands, skills, templates, filtered vendor).
// Runs from the repo (where workspace deps resolve); target dir defaults to the
// package dir and can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : pkgDir;

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
// Vendored upstream content ships inert: drop every executable AND every shell
// file (the extensionless bash tools and .sh launchers are active vendor code,
// not package runtime).
const vendorFilter = (s: string): boolean => {
  if (s.endsWith(".sh")) return false;
  const st = statSync(s);
  return st.isDirectory() || (st.mode & 0o111) === 0;
};
for (const sub of ["commands", "skills", "templates", "vendor/superpowers/skills"]) {
  const src = path.join(coreDir, sub);
  if (!existsSync(src)) continue;
  cpSync(src, path.join(assets, sub), {
    recursive: true,
    filter: vendorFilter,
  });
}
// The copied visual-companion.md still documents the filtered launcher scripts;
// strip those runtime sections so the shipped markdown references only files it
// ships with. ponytail: pinned to the frozen upstream headings; the
// package-contents gate fails on any surviving scripts/ reference.
const companion = path.join(assets, "vendor/superpowers/skills/brainstorming/visual-companion.md");
if (existsSync(companion)) {
  let md = readFileSync(companion, "utf8");
  const fromStart = md.indexOf("## Starting a Session");
  const toLoop = md.indexOf("## The Loop", fromStart);
  const fromCleanup = md.indexOf("## Cleaning Up");
  const toReference = md.indexOf("## Reference", fromCleanup);
  if (fromStart !== -1 && toLoop !== -1 && fromCleanup !== -1 && toReference !== -1) {
    md =
      md.slice(0, fromStart) +
      "The packaged browser-companion runtime is not shipped with this package; its\n" +
      "launcher scripts are excluded as vendored shell. Consult the upstream skill\n" +
      "source for launch instructions.\n\n" +
      md.slice(toLoop, fromCleanup) +
      md.slice(toReference);
  }
  md = md.replace(
    /If it has shut down, restart it with `start-server\.sh` using the \*\*same `--project-dir`\*\*[\s\S]*?you don't need to send a new URL\. /,
    "",
  );
  writeFileSync(companion, md);
}
console.log(`opencode: built dist/plugin.js + assets/ (${target})`);
