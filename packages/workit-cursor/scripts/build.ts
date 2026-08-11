#!/usr/bin/env bun
// Build the self-contained Cursor MCP + session-hook entries and copy the
// deterministic assets root (templates incl. hygiene). Runs from the repo
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
] as const;
for (const [entry, out] of entries) {
  const build = spawnSync(
    "bun",
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

// Deterministic assets: templates (incl. hygiene) for session-start + bundled core.
const assets = path.join(target, "assets");
rmSync(assets, { recursive: true, force: true });
const templatesSrc = path.join(coreDir, "templates");
if (existsSync(templatesSrc)) {
  cpSync(templatesSrc, path.join(assets, "templates"), { recursive: true });
}
console.log(`cursor: built dist/mcp-server.js + dist/cursor-session-start.js + assets/ (${target})`);
