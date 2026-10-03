#!/usr/bin/env bun
// Dead-file guard for @brainervirus/workit-core. knip cannot police core: its
// package.json `exports: { "./src/*": "./src/*.ts" }` makes every core source
// file a public entry. This bundles every real runtime entry point with a
// metafile and fails when a core source file is reachable from none of them
// (a module that only tests import is dead code).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const rel = (...parts: string[]) => path.join(root, ...parts);
const ts = (dir: string) =>
  readdirSync(rel(dir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(dir, name));

// Every file a host, bin, build or install path actually executes.
const ENTRIES = [
  "packages/workit-mcp/src/index.ts", // workit-mcp bin/main
  "packages/workit-opencode/src/index.ts", // OpenCode dist/plugin.js
  "packages/workit-opencode/src/plugin.ts", // root package.json main (local pin)
  "packages/workit-cursor/mcp/run-server.ts", // Cursor dist/mcp-server.js
  "packages/workit-cursor/hooks/workit-hook.ts",
  "packages/workit-cursor/hooks/session-start.ts",
  "packages/workit-codex/hooks/workit-hook.ts",
  "packages/workit-codex/scripts/launch-mcp.ts",
  "packages/workit-pi/extensions/workit.ts",
  "packages/workit-pi/src/worker.ts",
  "packages/workit-cli/src/main.ts", // workit-cli dist/index.js (wizards via dynamic import)
  ...ts("scripts"),
  ...ts("packages/workit-core/scripts"),
  ...readdirSync(rel("packages"))
    .map((pkg) => path.join("packages", pkg, "scripts/build.ts"))
    .filter((entry) => existsSync(rel(entry))),
].filter((entry) => !entry.endsWith("scripts/check-reachability.ts"));

// Core modules loaded at runtime by a shell script, which no bundle models.
// Each needs a live invocation; delete the line when that invocation goes away.
const SCRIPT_LOADED: Record<string, string> = {
  "packages/workit-core/src/core/rules.ts":
    "sync-runtime.sh imports writeCompiledCursorRules via `bun -e`",
};

// Seams a slice lands ahead of its first runtime consumer (design §5 waves).
// Each line names the slices that will import it; delete the line when the
// first of them merges, so the file is then policed like any other.
const AWAITING_CONSUMER: Record<string, string> = {};

const reached = new Set<string>([...Object.keys(SCRIPT_LOADED), ...Object.keys(AWAITING_CONSUMER)]);
const out = mkdtempSync(path.join(os.tmpdir(), "workit-reachability-"));
try {
  for (const [index, entry] of [...ENTRIES, ...Object.keys(SCRIPT_LOADED)].entries()) {
    const metafile = path.join(out, `meta-${index}.json`);
    const built = spawnSync(
      process.execPath,
      [
        "build",
        rel(entry),
        "--target",
        "node",
        "--outdir",
        path.join(out, `bundle-${index}`),
        `--metafile=${metafile}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (built.status !== 0) {
      console.error(`reachability: cannot bundle ${entry}\n${built.stderr || built.stdout}`);
      process.exit(1);
    }
    const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs ?? {});
    for (const input of inputs)
      reached.add(path.relative(root, path.resolve(root, input)).split(path.sep).join("/"));
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

const coreSrc = "packages/workit-core/src";
const coreFiles = readdirSync(rel(coreSrc), { recursive: true, encoding: "utf8" })
  .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => path.join(coreSrc, name).split(path.sep).join("/"));
const unreached = coreFiles.filter((file) => !reached.has(file));
if (unreached.length) {
  console.error("Core source files unreachable from every runtime entry (dead code):");
  for (const file of unreached) console.error(`  ${file}`);
  process.exit(1);
}
console.log(
  `reachability: ${coreFiles.length} core files reachable from ${ENTRIES.length} entries`,
);
