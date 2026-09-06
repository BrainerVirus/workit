#!/usr/bin/env bun
// Build the self-contained Cursor MCP + session-hook entries and copy the
// Cursor contract asset. Runs from the repo
// (where workspace deps resolve); target dir defaults to the package dir and
// can be overridden for the pack sandbox.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(scriptDir, "..");
const coreDir = path.resolve(pkgDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : pkgDir;
const dist = path.join(target, "dist");
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

const skills = path.join(target, "skills");
rmSync(skills, { recursive: true, force: true });
rmSync(path.join(target, "vendor"), { recursive: true, force: true });
mkdirSync(skills, { recursive: true });
for (const name of [
  "workit-challenge",
  "workit-behavioral-tdd",
  "workit-review",
  "workit-plan",
  "workit-implement",
  "workit-debug",
  "workit-handoff",
]) {
  cpSync(path.join(coreDir, "skills", name), path.join(skills, name), { recursive: true });
}
console.log(`cursor: built shared MCP, native hook, assets, and seven method skills (${target})`);
