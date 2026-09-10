/** Cursor compatibility entry; all MCP schemas and handlers live in the shared transport. */
export {
  runStdioServer,
  createMcpServer,
  assertMcpHost,
  sanitizeTransportText,
} from "@brainervirus/workit-mcp";
export { cursorContextProvider, cursorCapabilities } from "./run-server";
