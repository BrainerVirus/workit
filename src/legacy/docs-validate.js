import { runScriptJson } from "./run-script.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

export function docsValidate({ spec_path, plan_path, workspace_root }) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const out = runScriptJson("lib/docs-validate.sh", [spec_path, plan_path], cwd);
  if (out.error) return { error: out.error };
  if (!out.data?.ok) {
    const errors = Array.isArray(out.data?.errors) ? out.data.errors : [];
    const message = errors.map((e) => e.message).filter(Boolean).join("; ")
      || "docs validation failed";
    return { ok: false, errors, error: message };
  }
  return out.data;
}
