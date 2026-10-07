#!/usr/bin/env node
// Cursor hook launcher. hooks-cursor.json runs
// `node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" <bin>` for every event. This
// file is committed plain JavaScript, so it runs from a Marketplace git checkout
// (no build, no dependencies) as well as from an installed plugin copy.
//
// Resolution order (first match wins; no step ever resolves `@latest`):
//   1. local: the plugin's own bundled hook, <plugin>/dist/<entry>.js;
//   2. local: `<bin>` on PATH (a global `@brainervirus/workit-cursor` install);
//   3. npx-pinned: `npx -y --prefer-offline --package=<pkg>@<plugin version>`,
//      the version read from this plugin's package.json;
//   4. missing: nothing runnable.
//
// Fail-open: a launcher or infrastructure failure (nothing to run, spawn
// failure, npx network error, timeout, a crash) prints `{}`, exits 0 and
// writes one `[workit] Cursor hook unavailable: …` line on stderr. Only a
// policy deny from the hook itself (exit 2 with Cursor's deny JSON) blocks.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCursorHookLaunch, runCursorHookLaunch } from "./launch-runtime.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `--probe <bin>` (for `workit doctor`): run one no-op preCompact through
// the candidate Cursor would use and print which one it was and how it went.
if (process.argv[2] === "--probe") {
  const candidates = resolveCursorHookLaunch({
    root: pluginRoot,
    bin: process.argv[3] ?? "",
    env: process.env,
  });
  const run = runCursorHookLaunch({
    candidates: candidates.slice(0, 1),
    payload: JSON.stringify({ hook_event_name: "preCompact", workspace_roots: [] }),
    env: process.env,
  });
  const first = candidates[0];
  process.stdout.write(
    `${JSON.stringify({ mode: first?.mode ?? "missing", source: first?.source ?? null, error: run.warning })}\n`,
  );
  process.exit(0);
}

const bin = process.argv[2] ?? "";
let payload = "";
for await (const chunk of process.stdin) payload += String(chunk);
let result;
try {
  result = runCursorHookLaunch({
    candidates: resolveCursorHookLaunch({ root: pluginRoot, bin, env: process.env }),
    payload,
    env: process.env,
  });
} catch (error) {
  result = {
    stdout: "{}\n",
    exitCode: 0,
    warning: `[workit] Cursor hook unavailable: ${error instanceof Error ? error.message : String(error)}`,
  };
}
if (result.warning) process.stderr.write(`${result.warning}\n`);
process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
