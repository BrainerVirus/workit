#!/usr/bin/env bun
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? path.resolve(process.argv[2]) : packageDir;
const dist = path.join(target, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const build = spawnSync(
  process.execPath,
  [
    "build",
    path.join(packageDir, "src/index.ts"),
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
  process.stderr.write(build.stderr || build.stdout || "MCP build failed\n");
  process.exit(1);
}
console.log(`mcp: built dist/index.js (${target})`);
