import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node-compatible TS MCP launcher (RR-03): resolves the package root for assets
// (install copy vs live monorepo) and starts server.ts. Package-local only: no
// personal development or share-clone paths. Replaces mcp/run-server.sh shell.

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(mcpDir, "..");
const marker = path.join(pluginDir, ".workit-root");

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
  // Packaged install or monorepo: assets resolve from the plugin package root.
  return pluginDir;
};

const root = resolveRoot();
process.env.WORKFLOW_TOOLKIT_ROOT = root;
if (process.argv[2]) process.env.WORKFLOW_WORKSPACE_ROOT = process.argv[2];

await import("./server.ts");
