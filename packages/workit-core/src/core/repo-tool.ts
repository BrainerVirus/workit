import { resolveWorkspaceRoot } from "./scripts";

/** Attach the resolved repository root to each repository tool response. */
export function withWorkspace(
  workspaceRoot: string,
  data: Record<string, any> = {},
): Record<string, any> {
  return {
    workspace_root: resolveWorkspaceRoot(workspaceRoot),
    ...data,
  };
}
