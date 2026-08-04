import { runScriptJson } from "./run-script.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";
import { gitContext } from "./git-context.js";

export function docsBranch({ plan_path, kind, workspace_root }) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const args = [plan_path ?? "", kind ?? "feature"];
  const out = runScriptJson("lib/resolve-docs-branch.sh", args, cwd);
  if (out.error) return { error: out.error };
  if (out.data?.error) return { error: out.data.error };
  const git = gitContext(cwd);
  return { ...out.data, dirty: Boolean(git.status_short?.trim()) };
}
