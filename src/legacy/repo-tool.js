import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

/** Attach resolved repo root to every repo-scoped MCP tool response. */
export function withWorkspace(workspaceRoot, data = {}) {
  return {
    workspace_root: resolveWorkspaceRoot(workspaceRoot),
    ...data,
  };
}
