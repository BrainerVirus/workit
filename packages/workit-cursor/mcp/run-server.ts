import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node-compatible TS MCP launcher (RR-03): resolves the core package root for
// Cursor MCP (install copy vs live monorepo) and starts server.ts. Package-local
// only: no personal development or share-clone paths. Replaces mcp/run-server.sh.

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(mcpDir, "..");
const marker = path.join(pluginDir, ".workflow-toolkit-root");

const resolveRoot = (): string => {
  if (
    process.env.WORKFLOW_TOOLKIT_ROOT &&
    existsSync(path.join(process.env.WORKFLOW_TOOLKIT_ROOT, "scripts"))
  ) {
    return process.env.WORKFLOW_TOOLKIT_ROOT;
  }
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").replace(/\n+$/, "");
  }
  if (existsSync(path.join(pluginDir, "node_modules/@brainervirus/workit-core"))) {
    // Installed plugin copy: core resolves through its own node_modules.
    return pluginDir;
  }
  // Live monorepo: workit-cursor/mcp → packages/workit-core (workspace sibling).
  return path.resolve(mcpDir, "../../workit-core");
};

const root = resolveRoot();
process.env.WORKFLOW_TOOLKIT_ROOT = root;
if (process.argv[2]) process.env.WORKFLOW_WORKSPACE_ROOT = process.argv[2];

await import(path.join(mcpDir, "server.ts"));
