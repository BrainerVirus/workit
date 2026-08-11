#!/usr/bin/env bun
// Build the self-contained CLI entry (nonsplitting dist/index.js with a portable
// Node shebang) and copy the deterministic assets root (templates incl. hygiene).
// Runs from the repo; target dir defaults to the package dir and can be
// overridden for the pack sandbox.
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
    path.join(pkgDir, "src/index.tsx"),
    "--outfile",
    path.join(dist, "index.js"),
    "--target",
    "node",
    "--format",
    "esm",
    "--banner",
    "#!/usr/bin/env node",
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  console.error(build.stderr);
  process.exit(1);
}

// Deterministic assets: templates (incl. hygiene) for the bundled core.
const assets = path.join(target, "assets");
rmSync(assets, { recursive: true, force: true });
const templatesSrc = path.join(coreDir, "templates");
if (existsSync(templatesSrc)) {
  cpSync(templatesSrc, path.join(assets, "templates"), { recursive: true });
}
console.log(`cli: built dist/index.js + assets/ (${target})`);
