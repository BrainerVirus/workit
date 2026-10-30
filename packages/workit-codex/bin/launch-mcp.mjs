#!/usr/bin/env node
// Codex MCP entry (.mcp.json runs `node bin/launch-mcp.mjs`). Plain JavaScript on
// node: builtins so it starts on the old PATH node it may have to replace. Below
// the package's engines floor it re-runs dist/launch-mcp.js on a Node that meets
// it (bin/node-resolve.mjs: $WORKIT_NODE, the node `workit setup` recorded, a
// version-manager scan) with stdio inherited: MCP is stdio JSON-RPC, so nothing
// else reaches stdout. With none it writes one stderr line and exits 1.
// WORKIT_HOOK_NODE_VERSION stands in for process.versions.node (tests).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HOOK_NODE_REEXEC_ENV,
  floorMessage,
  floorOfRange,
  reexecOnNode,
  resolveHookNode,
} from "./node-resolve.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "launch-mcp.js");
const found = process.env.WORKIT_HOOK_NODE_VERSION || process.versions.node;
let range;
try {
  range = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).engines?.node;
} catch {
  range = undefined;
}
const floor = floorOfRange(range);
const tooOld = floor ? floorMessage(found, floor, range) : null;
if (tooOld && floor) {
  const hit = process.env[HOOK_NODE_REEXEC_ENV]
    ? null
    : resolveHookNode({ env: process.env, floor });
  const code = hit ? reexecOnNode(hit.path, entry, [], process.env) : null;
  if (code !== null) process.exit(code);
  process.stderr.write(
    `[workit] Codex MCP server unavailable: ${tooOld}; install Node 24 or run \`workit setup\` from a Node 24 shell\n`,
  );
  process.exit(1);
}
await import(pathToFileURL(entry).href);
