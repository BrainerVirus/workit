// The forge provider and target branch with their source, shared by
// `workit config show` and `workit grant show` (W2.8).
import { readVcsConfig, vcsConfig } from "@brainervirus/workit-core/src/core/vcs-config";
import {
  resolveRuntimeWorkspaceVcs,
  workspacesPath,
} from "@brainervirus/workit-core/src/core/workspaces";

/** A value and where it came from: a file and key, a remote, or `default`. */
export type Sourced<T> = { value: T; source: string };

type VcsView = {
  provider: Sourced<string | null>;
  defaultTargetBranch: Sourced<string | null>;
};

/**
 * The forge provider and default target branch with their source, in the
 * order vcsConfig resolves them: the workspace's vcs block, then the origin
 * remote (github.com or gitlab.com), then vcs.json.
 */
export function vcsView(cwd: string): VcsView {
  const resolved = vcsConfig("resolve", cwd);
  const workspace = resolveRuntimeWorkspaceVcs(cwd);
  const own = (workspace?.vcs ?? {}) as {
    provider?: unknown;
    defaultTargetBranch?: unknown;
  };
  const global = readVcsConfig();
  const where = `workspace ${workspace?.name ?? "?"} in ${workspacesPath()}`;
  const provider = resolved.ok === false ? null : ((resolved.provider as string | null) ?? null);
  const providerSource =
    provider === null
      ? resolved.ok === false
        ? `unresolved: ${String(resolved.error)}`
        : "none (no workspace vcs.provider, recognized origin remote or vcs.json provider)"
      : typeof own.provider === "string"
        ? `vcs.provider in ${where}`
        : String(global.config.provider ?? "").toLowerCase() === provider
          ? `provider in ${global.path}`
          : "the origin remote";
  const target =
    resolved.ok === false ? null : ((resolved.defaultTargetBranch as string | null) ?? null);
  const track = resolved.ok === false ? null : (resolved.releaseTrack?.name as string | null);
  const targetSource =
    target === null
      ? "none"
      : track
        ? `release track ${track} in ${where}`
        : typeof own.defaultTargetBranch === "string"
          ? `vcs.defaultTargetBranch in ${where}`
          : global.config.defaultTargetBranch === target && !workspace?.branchPolicy
            ? `defaultTargetBranch in ${global.path}`
            : "the branch policy preset's default";
  return {
    provider: { value: provider, source: providerSource },
    defaultTargetBranch: { value: target, source: targetSource },
  };
}
