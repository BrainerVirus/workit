#!/usr/bin/env node
// Claude Code hook launcher (hooks/hooks.json runs `node <this file>`, exec
// form, so no shell is involved on any OS). Two layouts:
//   - local pin (`claude --plugin-dir <checkout>/packages/workit-claude-code`):
//     the monorepo sources sit next to this package, so the TypeScript entry
//     runs from source with bun: edits apply without a rebuild;
//   - installed package (npm/marketplace): dist/workit-hook.js is imported.
// WORKIT_CLAUDE_RUNTIME=source|dist forces one. A launcher failure fails open
// (an empty decision plus a stderr diagnostic): a broken hook must never
// brick the host.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "run.ts");
const dist = path.join(root, "dist", "workit-hook.js");
const mode = process.env.WORKIT_CLAUDE_RUNTIME;
const fromSource =
  mode === "source" ||
  (mode !== "dist" &&
    existsSync(source) &&
    existsSync(path.join(root, "..", "workit-core", "src", "hooks", "index.ts")));

const failOpen = (reason) => {
  process.stderr.write(`[workit] Claude Code hook unavailable: ${reason}\n`);
  process.stdout.write("{}\n");
};

if (fromSource) {
  const run = spawnSync(process.env.WORKIT_BUN ?? "bun", [source], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (run.error) failOpen(`bun is required for the local pin (${run.error.message})`);
  else process.exitCode = run.status ?? 0;
} else if (existsSync(dist)) {
  const { runClaudeHook } = await import(pathToFileURL(dist).href);
  process.exitCode = await runClaudeHook(process.stdin, process.stdout);
} else {
  failOpen(`${dist} is missing; run \`bun scripts/build.ts\` in ${root}`);
}
