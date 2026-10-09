import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore, type OperationContext } from "@brainervirus/workit-core/src/core";
import { SUPPORT_MATRIX } from "@brainervirus/workit-core/src/core/support-matrix.ts";
import { McpCapabilityUnavailableError, runStdioServer } from "@brainervirus/workit-mcp/src/server";
import { codexCapabilities, detectCodexSurface, type CodexHost } from "../hooks/workit-hook";
import { codexHomeFor, codexHomeOfInstall, installCodexAgents } from "./agents";

export const codexQualification = (host: CodexHost) =>
  host === "codex_cli"
    ? { surface: host, cli: SUPPORT_MATRIX.codex.cli }
    : {
        surface: host,
        desktopPackage: SUPPORT_MATRIX.codex.desktopPackage,
        bundledCodexCli: SUPPORT_MATRIX.codex.bundledCodexCli,
      };

export const resolveCodexWorkspaceRoot = (
  pluginRoot: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  const explicit = env.WORKFLOW_WORKSPACE_ROOT;
  const inherited = env.PWD;
  const candidate =
    explicit ??
    (inherited && path.resolve(inherited) !== path.resolve(pluginRoot) ? inherited : undefined);
  if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) return null;
  try {
    if (!statSync(candidate).isDirectory()) return null;
    const canonical = realpathSync(candidate);
    if (canonical === realpathSync(pluginRoot)) {
      // The shipped plugin dir must never initialize state: refuse unless the
      // operator explicitly named a live workspace here. `codex exec` spawns
      // the MCP server in the project directory (no plugin root exists), so
      // an explicit live root is operator intent, not a plugin-dir accident.
      // Recipe: run exec from the project and pass
      // -c 'mcp_servers.workit.env={WORKFLOW_WORKSPACE_ROOT="<project>"}'.
      if (!explicit) return null;
      const workspace = new TaskStore(canonical).readWorkspace();
      if (!workspace.ok || !workspace.data || workspace.data.root !== canonical) return null;
      return canonical;
    }
    const workspace = new TaskStore(canonical).readWorkspace();
    if (!workspace.ok) return null;
    // Fresh checkouts without state resolve so task.start can initialize them;
    // a present-but-moved workspace still refuses to avoid operating on a
    // directory the stored state no longer describes.
    if (workspace.data && workspace.data.root !== canonical) return null;
    return canonical;
  } catch {
    return null;
  }
};

export const codexContextProvider = (
  host: CodexHost = detectCodexSurface(process.env),
  root?: string,
): { current: () => Promise<OperationContext> } => ({
  current: async () => {
    const workspaceRoot =
      root === undefined
        ? resolveCodexWorkspaceRoot(process.cwd(), process.env)
        : resolveCodexWorkspaceRoot(process.cwd(), { WORKFLOW_WORKSPACE_ROOT: root });
    if (!workspaceRoot) throw new McpCapabilityUnavailableError("workspace");
    return {
      root: workspaceRoot,
      caller: { host, actor: "" },
      callerAttested: false,
      capabilities: codexCapabilities(host),
      constraints: [],
      now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  },
});

/** The plugin root: dist/launch-mcp.js (or scripts/launch-mcp.ts) is one level down. */
const pluginRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Codex plugins cannot ship custom agents, so each MCP start of an installed
 * plugin copies the bundled workit-* agents into the owning Codex home's
 * `agents/` (scripts/agents.ts). A checkout or unpacked tarball is not an
 * install and copies nothing. Never fatal: the MCP server must still start.
 */
export const syncCodexAgents = (root: string): void => {
  const codexHome = codexHomeOfInstall(root);
  if (!codexHome) return;
  try {
    installCodexAgents(root, codexHome);
  } catch {
    // Agents are a convenience; `workit doctor` reports a missing copy.
  }
};

if (import.meta.main) {
  if (process.argv.includes("--install-agents")) {
    // The fix `workit doctor` prints: copy the agents now and say what changed.
    const root = pluginRoot();
    const results = installCodexAgents(root, codexHomeFor(root, process.env));
    for (const r of results) process.stdout.write(`${r.action} ${r.file}\n`);
    if (results.length === 0) process.stdout.write(`no agents bundled in ${root}\n`);
    process.exit(0);
  }
  syncCodexAgents(pluginRoot());
  await runStdioServer(detectCodexSurface(process.env), codexContextProvider());
}
