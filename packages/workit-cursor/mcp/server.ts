/** Cursor compatibility entry; all MCP schemas and handlers live in the shared transport. */
export {
  runStdioServer,
  createMcpServer,
  assertMcpHost,
  sanitizeTransportText,
} from "@brainervirus/workit-mcp";
export { cursorContextProvider, cursorCapabilities } from "./run-server";

if (import.meta.main) {
  const { runStdioServer } = await import("@brainervirus/workit-mcp");
  const { cursorContextProvider } = await import("./run-server");
  if (process.argv[2]) process.env.WORKFLOW_WORKSPACE_ROOT = process.argv[2];
  await runStdioServer("cursor", cursorContextProvider() as Parameters<typeof runStdioServer>[1]);
}
