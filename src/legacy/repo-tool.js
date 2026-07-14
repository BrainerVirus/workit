import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

/** Attach the resolved repository root to each repository tool response. */
export function withWorkspace(workspaceRoot, data = {}) {
  return {
    workspace_root: resolveWorkspaceRoot(workspaceRoot),
    ...data,
  };
}
