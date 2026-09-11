#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKIT_METHOD_SKILLS } from "../../workit-core/src/core/skill-manifests";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.resolve(packageDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : packageDir;
const dist = path.join(target, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const [entry, output] of [
  ["hooks/workit-hook.ts", "workit-hook.js"],
  ["scripts/launch-mcp.ts", "launch-mcp.js"],
] as const) {
  const result = spawnSync(
    process.execPath,
    [
      "build",
      path.join(packageDir, entry),
      "--outfile",
      path.join(dist, output),
      "--target",
      "node",
      "--format",
      "esm",
      "--banner",
      "#!/usr/bin/env node",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(1);
  }
}

const skills = path.join(target, "skills");
rmSync(skills, { recursive: true, force: true });
mkdirSync(skills, { recursive: true });
for (const name of WORKIT_METHOD_SKILLS)
  cpSync(path.join(coreDir, "skills", name), path.join(skills, name), { recursive: true });

console.log(
  `codex: built Node entries and ${WORKIT_METHOD_SKILLS.length} method skills (${target})`,
);
