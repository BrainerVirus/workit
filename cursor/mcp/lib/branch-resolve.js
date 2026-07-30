import path from "node:path";
import { runScriptJson } from "./run-script.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";
import { gitContext } from "./git-context.js";

export function resolveBranch({ spec_path, plan_path, workspace_root }) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const spec = path.isAbsolute(spec_path)
    ? spec_path
    : path.join(cwd, spec_path);
  const plan = path.isAbsolute(plan_path)
    ? plan_path
    : path.join(cwd, plan_path);
  const out = runScriptJson(
    "lib/resolve-handoff-branch.sh",
    [spec, plan, "--format=json"],
    cwd,
  );
  if (out.error) return { error: out.error };
  const git = gitContext(cwd);
  return {
    ...out.data,
    current_branch: git.branch,
    dirty: Boolean(git.status_short?.trim()),
    needs_checkout: git.branch !== out.data.branch,
  };
}

export function branchSetup({
  action,
  sdd_dir,
  target_branch,
  stash,
  workspace_root,
}) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const args = [
    action ?? "setup",
    sdd_dir ?? "docs/superpowers/sdd",
    target_branch ?? "",
    stash ?? "no",
  ];
  const out = runScriptJson("branch/setup-branch.sh", args, cwd);
  if (out.error) return { error: out.error };
  return out.data;
}
