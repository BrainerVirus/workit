/**
 * Cursor passes the opened workspace via mcp.json args → WORKFLOW_WORKSPACE_ROOT.
 * Explicit tool arg wins; else env; else Node cwd (MCP process — often wrong).
 */
export function resolveWorkspaceRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.WORKFLOW_WORKSPACE_ROOT) {
    return process.env.WORKFLOW_WORKSPACE_ROOT;
  }
  return process.cwd();
}
