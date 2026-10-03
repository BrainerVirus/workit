// Which forge, which repo, and which account (D16, design §0 #6, §2.0
// Identity). The push remote host decides GitHub vs GitLab; the workspace
// config only supplies the expected account and enterprise hosts. A workspace
// provider that disagrees with the push remote is `blocked`, never silently
// overridden. Config is read, never written.
import { readVcsConfig } from "../core/vcs-config";
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import { forgeConflict, pushForge, type DerivedForge, type ForgeHosts } from "../git/rev";
import { systemRunner, type ForgeRunner } from "./exec";
import { createGitHubForge } from "./github";
import { createGitLabForge } from "./gitlab";
import { failure, success, type Forge, type ForgeResult, type Identity } from "./types";

export type ResolvedForge = {
  forge: Forge;
  /** Push remote name. */
  remote: string;
  /** Redacted push URL. */
  url: string;
  derived: DerivedForge;
  workspace: string | null;
  /** The workspace `vcs.account`, when configured. */
  expectedAccount: string | null;
};

export type ResolveOptions = {
  branch?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Replaces the real gh/glab (tests replay recorded API fixtures). */
  runner?: ForgeRunner;
};

const configuredHosts = (): ForgeHosts => {
  const vcs = readVcsConfig();
  if (vcs.status !== "valid") return {};
  const host = (kind: "github" | "gitlab"): string[] => {
    const value = (vcs.config[kind] as { host?: unknown } | undefined)?.host;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  };
  return { github: host("github"), gitlab: host("gitlab") };
};

export function resolveForge(
  cwd: string,
  options: ResolveOptions = {},
): ForgeResult<ResolvedForge> {
  let workspace: ReturnType<typeof resolveRuntimeWorkspaceVcs>;
  try {
    workspace = resolveRuntimeWorkspaceVcs(cwd);
  } catch (error) {
    return failure(
      "blocked",
      error instanceof Error ? error.message : String(error),
      "fix ~/.config/workit/workspaces.json (workit init → Workspaces)",
    );
  }
  const pushed = pushForge(cwd, { branch: options.branch, hosts: configuredHosts() });
  if (!pushed.ok) return failure(pushed.code, pushed.error, pushed.unblock);
  const conflict = forgeConflict(pushed.forge, workspace?.vcs?.provider);
  if (conflict) return failure("blocked", conflict.error, conflict.unblock);
  const { kind, apiHost, repo } = pushed.forge;
  const runner = options.runner ?? systemRunner(kind, apiHost, options.env ?? process.env);
  const forge =
    kind === "github"
      ? createGitHubForge({ apiHost, repo, runner })
      : createGitLabForge({ apiHost, repo, runner });
  return success({
    forge,
    remote: pushed.remote,
    url: pushed.url,
    derived: pushed.forge,
    workspace: workspace?.name ?? null,
    expectedAccount: workspace?.vcs?.account ?? null,
  });
}

/**
 * The credential gh/glab actually uses must be the workspace account. A
 * mismatch is `blocked` with the exact switch command; no configured account
 * passes (read verbs).
 */
export function checkIdentity(resolved: ResolvedForge): ForgeResult<Identity> {
  const { forge, expectedAccount } = resolved;
  const identity = forge.identity(expectedAccount);
  if (!identity.ok) return identity;
  if (identity.data.matches === false) {
    const bin = forge.kind === "github" ? "gh" : "glab";
    return failure(
      "blocked",
      `identity_mismatch: ${bin} is authenticated as ${identity.data.login} but workspace ${resolved.workspace ?? "?"} expects ${expectedAccount}`,
      forge.kind === "github"
        ? `gh auth switch --hostname ${forge.apiHost} --user ${expectedAccount}`
        : `glab auth login --hostname ${forge.apiHost}  # as ${expectedAccount}`,
    );
  }
  return identity;
}
