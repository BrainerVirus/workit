import { runStdioServer } from "@brainervirus/workit-mcp";
import { cursorCapabilities } from "../hooks/workit-hook";
import type { OperationContext } from "@brainervirus/workit-core/src/core";

export { cursorCapabilities } from "../hooks/workit-hook";

/** Cursor MCP receives only host-provided process identity. AskQuestion and
 * hook observations are not bridged through a mutable side channel, so this
 * transport never claims caller attestation. */
export const cursorContextProvider = (
  workspaceRoot = process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd(),
): { current: () => Promise<OperationContext> } => ({
  current: async (): Promise<OperationContext> => ({
    root: workspaceRoot,
    caller: {
      host: "cursor",
      actor:
        process.env.CURSOR_CONVERSATION_ID ??
        process.env.WORKFLOW_SESSION_ID ??
        process.env.CURSOR_SESSION_ID ??
        "cursor-mcp",
    },
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
