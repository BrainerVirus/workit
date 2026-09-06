import { runStdioServer } from "@brainervirus/workit-mcp";
import type { OperationContext } from "@brainervirus/workit-core/src/core";
import { codexCapabilities, detectCodexSurface, type CodexHost } from "../hooks/workit-hook";

export const codexQualification = (host: CodexHost) =>
  host === "codex_cli"
    ? { surface: host, cli: "0.153.4" }
    : { surface: host, desktopPackage: "26.901.20858", bundledCodexCli: "0.153.0-alpha.5" };

export const codexContextProvider = (
  host: CodexHost = detectCodexSurface(process.env),
  root = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
): { current: () => Promise<OperationContext> } => ({
  current: async () => ({
    root,
    caller: { host, actor: "" },
    callerAttested: false,
    capabilities: codexCapabilities(),
    constraints: [],
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }),
});

if (import.meta.main)
  await runStdioServer(
    detectCodexSurface(process.env),
    codexContextProvider() as Parameters<typeof runStdioServer>[1],
  );
