#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKIT_METHOD_SKILLS, copySkillForHost } from "../../workit-core/src/core/skill-manifests";
import { renderCodexAgents } from "./agents";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.resolve(packageDir, "..", "workit-core");
const target = process.argv[2] ? path.resolve(process.argv[2]) : packageDir;
const dist = path.join(target, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// The hook entry is split: dist/workit-hook.js answers the calls that cannot
// matter without loading the Workit runtime chunk (hooks/launcher.ts).
for (const [entry, output, split] of [
  ["hooks/launcher.ts", "workit-hook.js", true],
  ["scripts/launch-mcp.ts", "launch-mcp.js", false],
] as const) {
  const result = spawnSync(
    process.execPath,
    [
      "build",
      path.join(packageDir, entry),
      ...(split
        ? [
            "--splitting",
            "--outdir",
            dist,
            "--entry-naming",
            output,
            "--chunk-naming",
            "workit-hook-[hash].js",
          ]
        : ["--outfile", path.join(dist, output)]),
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
  copySkillForHost(path.join(coreDir, "skills", name), path.join(skills, name), "codex");

// Codex custom agents, rendered from the canonical Claude Code agents.
const agents = path.join(target, "agents");
rmSync(agents, { recursive: true, force: true });
mkdirSync(agents, { recursive: true });
const rendered = renderCodexAgents(path.resolve(packageDir, "..", "workit-claude-code", "agents"));
for (const [file, text] of rendered) writeFileSync(path.join(agents, file), text);

console.log(
  `codex: built Node entries, ${WORKIT_METHOD_SKILLS.length} method skills and ${rendered.size} agents (${target})`,
);
