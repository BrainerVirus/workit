import { runStdioServer } from "@brainervirus/workit-mcp";
import { cursorCapabilities } from "../hooks/workit-hook";
import type { OperationContext } from "@brainervirus/workit-core/src/core";

export { cursorCapabilities } from "../hooks/workit-hook";

/** Cursor MCP has no documented per-request session identity. Keep the actor
 * empty and mark it unattested; the shared transport blocks authority writes. */
export const cursorContextProvider = (
  workspaceRoot = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
): { current: () => Promise<OperationContext> } => ({
  current: async (): Promise<OperationContext> => ({
    root: workspaceRoot,
    caller: {
      host: "cursor",
      actor: "",
    },
    callerAttested: false,
    capabilities: cursorCapabilities(),
    constraints: [],
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }),
});

if (import.meta.main) {
  const workspaceRoot = process.argv[2];
  if (workspaceRoot) process.env.WORKFLOW_WORKSPACE_ROOT = workspaceRoot;
  await runStdioServer("cursor", cursorContextProvider() as Parameters<typeof runStdioServer>[1]);
}
