import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runStdioServer } from "@brainervirus/workit-mcp";
import type { OperationContext } from "@brainervirus/workit-core/src/core";
import { codexCapabilities, detectCodexSurface, type CodexHost } from "../hooks/workit-hook";

export const codexQualification = (host: CodexHost) =>
  host === "codex_cli"
    ? { surface: host, cli: "0.153.4" }
    : { surface: host, desktopPackage: "26.901.20858", bundledCodexCli: "0.153.0-alpha.5" };

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
    if (canonical === realpathSync(pluginRoot)) return null;
    return canonical;
  } catch {
    return null;
  }
};

const unavailableRoot = path.join(tmpdir(), "workit-codex-workspace-unavailable");

export const codexContextProvider = (
  host: CodexHost = detectCodexSurface(process.env),
  root?: string,
): { current: () => Promise<OperationContext> } => ({
  current: async () => ({
    root:
      (root === undefined
        ? resolveCodexWorkspaceRoot(process.cwd(), process.env)
        : resolveCodexWorkspaceRoot(process.cwd(), { WORKFLOW_WORKSPACE_ROOT: root })) ??
      unavailableRoot,
    caller: { host, actor: "" },
    callerAttested: false,
    capabilities: codexCapabilities(host),
    constraints: [],
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }),
});

if (import.meta.main)
  await runStdioServer(
    detectCodexSurface(process.env),
    codexContextProvider() as Parameters<typeof runStdioServer>[1],
  );
