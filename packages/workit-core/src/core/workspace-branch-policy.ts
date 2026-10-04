import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { detectBranchPolicy } from "./branch-policy";
import { configDir } from "./config";
import {
  readWorkspacesResult,
  resolveWorkspaceFrom,
  validateWorkspaceGlob,
  validateWorkspacesDocument,
  workspacesRevision,
  type WorkspaceConfig,
} from "./workspaces";

const readFileSafe = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

// The one proposal→write path for a workspace branch policy, shared by the
// OpenCode `workit_init_apply` branch_policy action (init.ts) and the CLI
// wizard, so both produce byte-identical workspaces.json writes.
export function applyWorkspaceBranchPolicy(opts: {
  workspace_root: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, any> {
  const { workspace_root, env = process.env } = opts;
  const dir = path.join(env.WORKFLOW_TOOLKIT_CONFIG ?? configDir());
  const {
    status,
    path: wsPath,
    entries,
    document,
    revision,
    error: workspacesError,
  } = readWorkspacesResult(dir);
  if (status === "malformed" || status === "invalid")
    return { ok: false, error: workspacesError ?? `invalid workspaces.json: ${wsPath}` };
  const detection = detectBranchPolicy(workspace_root);
  const name = String(env.WORKFLOW_BP_NAME ?? path.basename(workspace_root));
  const integration = (env.WORKFLOW_BP_INTEGRATION ?? detection.integration) as "pr" | "merge";
  const policy = {
    preset: detection.preset,
    developBranch: env.WORKFLOW_BP_DEVELOP ?? detection.developBranch ?? undefined,
    prefixes: detection.prefixes,
    allowed: detection.allowed,
    protected: detection.protected,
    integration,
  };
  const glob = `${workspace_root.replace(/[\\/]+$/, "")}/**`;
  if (!validateWorkspaceGlob(glob).ok)
    return { ok: false, error: `invalid workspace glob: ${glob}` };
  let existing: WorkspaceConfig | null;
  try {
    existing = resolveWorkspaceFrom(workspace_root, dir);
  } catch (error) {
    const selectedName = env.WORKFLOW_BP_NAME?.trim();
    if (!selectedName)
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    try {
      existing = resolveWorkspaceFrom(workspace_root, dir, selectedName);
    } catch (selectionError) {
      return {
        ok: false,
        error: selectionError instanceof Error ? selectionError.message : String(selectionError),
      };
    }
  }
  if (existing?.branchPolicy && isDeepStrictEqual(existing.branchPolicy, policy)) {
    return {
      ok: true,
      status: "already-configured",
      workspace: existing,
      policy,
      config_path: wsPath,
    };
  }
  const next = existing
    ? entries.map((w) => (w.name === existing?.name ? { ...w, branchPolicy: policy } : w))
    : [...entries, { name, glob, branchPolicy: policy }];
  if (!existing && entries.some((entry) => entry.name === name))
    return { ok: false, error: `workspace name ${JSON.stringify(name)} is already configured` };
  const proposed = validateWorkspacesDocument({ ...document, workspaces: next }, wsPath);
  if (proposed.status !== "valid") return { ok: false, error: proposed.error };
  if (workspacesRevision(readFileSafe(wsPath)) !== revision)
    return {
      ok: false,
      error: `workspaces.json changed while applying the branch policy: ${wsPath}`,
    };
  mkdirSync(path.dirname(wsPath), { recursive: true });
  const tmp = `${wsPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...document, workspaces: next }, null, 2) + "\n", "utf8");
    if (workspacesRevision(readFileSafe(wsPath)) !== revision) {
      rmSync(tmp, { force: true });
      return {
        ok: false,
        error: `workspaces.json changed while applying the branch policy: ${wsPath}`,
      };
    }
    renameSync(tmp, wsPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return {
      ok: false,
      error: `failed to write ${wsPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    status: existing ? "updated" : "configured",
    workspace: existing
      ? { ...existing, branchPolicy: policy }
      : { name, glob, branchPolicy: policy },
    policy,
    config_path: wsPath,
  };
}
