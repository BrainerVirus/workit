// Which forge, which repositories, and which credential (D16, design §0 #6,
// §2.0 Identity).
//
// - The push remote host decides GitHub vs GitLab. A workspace provider that
//   disagrees is `blocked`, never silently overridden.
// - PRs/MRs live in the base repository: an `upstream` remote on the same
//   forge, else the push repo's fork parent, else the push repo itself.
// - Every API call carries the workspace's credential explicitly, so the
//   machine-wide active gh/glab account is never switched or relied on:
//   the workspace `vcs.tokenFile`, else (GitHub) `gh auth token --user
//   <vcs.account>`, else the CLI's default login. The token is never printed.
// Config is read, never written.
import fs from "node:fs";
import { readVcsConfig } from "../core/vcs-config";
import { resolveRuntimeWorkspaceVcs } from "../core/workspaces";
import {
  deriveForge,
  forgeConflict,
  pushForge,
  pushUrl,
  remoteNames,
  type DerivedForge,
  type ForgeHosts,
  type SshConfig,
} from "../git/rev";
import { FORGE_TIMEOUTS, systemRunner, type ForgeRunner } from "./exec";
import { createGitHubForge } from "./github";
import { createGitLabForge } from "./gitlab";
import { failure, success, type Forge, type ForgeResult, type Identity } from "./types";

export type CredentialSource = "workspace_token_file" | "gh_account_token" | "cli_login";

export type ResolvedForge = {
  /** Bound to the base repository (where the PR/MR lives). */
  forge: Forge;
  /** Push remote name. */
  remote: string;
  /** Redacted push URL. */
  url: string;
  derived: DerivedForge;
  workspace: string | null;
  /** The workspace `vcs.account`, when configured. */
  expectedAccount: string | null;
  credential: CredentialSource;
  /** The push (head) repository; differs from forge.repo for a fork. */
  headRepo: string;
  /** GitLab project id of the push repository (MR source project). */
  headProjectId: number | null;
  fork: boolean;
  /** Remote to fetch base commits from (the base repo's remote when one exists). */
  baseRemote: string;
  /** Absolute deadline (ms, `now()` clock) every API call is clamped to; null = none. */
  limits: { deadline: number | null };
};

export type ResolveOptions = {
  branch?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Replaces the real gh/glab (tests replay recorded API fixtures). */
  runner?: ForgeRunner;
  /** Clock for the deadline (tests use a virtual one). */
  now?: () => number;
  /** ssh_config for Host aliases (default: the user's ~/.ssh/config). */
  sshConfig?: string | SshConfig;
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

const createForge = (derived: DerivedForge, repo: string, runner: ForgeRunner): Forge =>
  derived.kind === "github"
    ? createGitHubForge({ apiHost: derived.apiHost, repo, runner })
    : createGitLabForge({ apiHost: derived.apiHost, repo, runner });

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
  const hosts = configuredHosts();
  const pushed = pushForge(cwd, { branch: options.branch, hosts, sshConfig: options.sshConfig });
  if (!pushed.ok) return failure(pushed.code, pushed.error, pushed.unblock);
  const conflict = forgeConflict(pushed.forge, workspace?.vcs?.provider);
  if (conflict) return failure("blocked", conflict.error, conflict.unblock);
  const derived = pushed.forge;
  const { kind, apiHost } = derived;
  const base = options.runner ?? systemRunner(kind, apiHost, options.env ?? process.env);
  const now = options.now ?? Date.now;
  const expectedAccount = workspace?.vcs?.account ?? null;

  // The credential for every call.
  let token: string | undefined;
  let credential: CredentialSource = "cli_login";
  const tokenFile = (workspace?.vcs as { tokenFile?: unknown } | undefined)?.tokenFile;
  if (typeof tokenFile === "string" && tokenFile.trim()) {
    // A stored token goes only to the host it is for: the public forge (also
    // reached through an ~/.ssh/config alias) or a host configured
    // explicitly (vcs.json github.host/gitlab.host, workspace vcs.host).
    // A host merely *named* like a forge (github.evil.com) never gets it.
    const workspaceHost = (workspace?.vcs as { host?: unknown } | undefined)?.host;
    const explicit =
      typeof workspaceHost === "string" &&
      workspaceHost
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//u, "")
        .replace(/\/.*$/u, "") === apiHost;
    if (derived.via === "host_name" && !explicit)
      return failure(
        "blocked",
        `token_host_unverified: push host ${derived.host} only looks like ${kind}; workspace ${workspace?.name ?? "?"} vcs.tokenFile is not sent to it`,
        `if ${apiHost} is your ${kind} server, set ${kind}.host in ~/.config/workit/vcs.json (or vcs.host for the workspace); otherwise fix the push remote`,
      );
    try {
      token = fs.readFileSync(tokenFile.trim(), "utf8").trim();
    } catch {
      return failure(
        "blocked",
        `workspace ${workspace?.name ?? "?"} vcs.tokenFile cannot be read`,
        "fix vcs.tokenFile in ~/.config/workit/workspaces.json",
      );
    }
    if (!token)
      return failure(
        "blocked",
        `workspace ${workspace?.name ?? "?"} vcs.tokenFile is empty`,
        "fix vcs.tokenFile in ~/.config/workit/workspaces.json",
      );
    credential = "workspace_token_file";
  } else if (expectedAccount && kind === "github") {
    const issued = base("gh", ["auth", "token", "--hostname", apiHost, "--user", expectedAccount], {
      timeoutMs: FORGE_TIMEOUTS.api,
    });
    if (issued.missing)
      return failure(
        "unavailable",
        "gh is not installed",
        "install the GitHub CLI (https://cli.github.com) and run: gh auth login",
      );
    token = issued.status === 0 ? issued.stdout.trim() : "";
    if (!token)
      return failure(
        "blocked",
        `identity_unavailable: gh has no login for ${expectedAccount} on ${apiHost} (workspace ${workspace?.name ?? "?"})`,
        `gh auth login --hostname ${apiHost}  # sign in as ${expectedAccount}; workit passes that account's token per call and never switches the active account`,
      );
    credential = "gh_account_token";
  }

  const limits: { deadline: number | null } = { deadline: null };
  const runner: ForgeRunner = (bin, args, callOptions) => {
    let timeoutMs = callOptions.timeoutMs;
    if (limits.deadline !== null) {
      const remaining = limits.deadline - now();
      if (remaining <= 0)
        return { status: null, stdout: "", stderr: "", timedOut: true, missing: false };
      timeoutMs = Math.min(timeoutMs, remaining);
    }
    return base(bin, args, { ...callOptions, timeoutMs, ...(token ? { token } : {}) });
  };

  // Base repository: an `upstream` remote on the same forge, else the fork parent.
  const headRepo = derived.repo;
  const probe = createForge(derived, headRepo, runner);
  const info = probe.repoInfo(headRepo);
  if (!info.ok && info.code !== "not_found") return info;
  const headProjectId = info.ok ? info.data.id : null;
  const remotes = remoteNames(cwd);
  const repoOfRemote = (name: string): string | null => {
    const url = pushUrl(cwd, name);
    const other = url ? deriveForge(url, { hosts, sshConfig: options.sshConfig }) : null;
    return other && other.kind === kind && other.apiHost === apiHost ? other.repo : null;
  };
  const upstream =
    pushed.remote !== "upstream" && remotes.includes("upstream") ? repoOfRemote("upstream") : null;
  const baseRepo =
    upstream && upstream !== headRepo
      ? upstream
      : info.ok && info.data.parent
        ? info.data.parent
        : headRepo;
  const baseRemote =
    baseRepo === headRepo
      ? pushed.remote
      : (remotes.find((name) => repoOfRemote(name) === baseRepo) ?? pushed.remote);

  return success({
    forge: baseRepo === headRepo ? probe : createForge(derived, baseRepo, runner),
    remote: pushed.remote,
    url: pushed.url,
    derived,
    workspace: workspace?.name ?? null,
    expectedAccount,
    credential,
    headRepo,
    headProjectId,
    fork: baseRepo !== headRepo,
    baseRemote,
    limits,
  });
}

/**
 * The credential in use must belong to the workspace account. A mismatch is
 * `blocked` with the fix (never a global account switch); no configured
 * account passes; a credential that cannot read /user passes with a note.
 */
export function checkIdentity(resolved: ResolvedForge): ForgeResult<Identity> {
  const { forge, expectedAccount } = resolved;
  const identity = forge.identity(expectedAccount);
  if (!identity.ok) return identity;
  if (identity.data.matches === false) {
    const bin = forge.kind === "github" ? "gh" : "glab";
    const where = `workspace ${resolved.workspace ?? "?"}`;
    return failure(
      "blocked",
      `identity_mismatch: the ${resolved.credential === "workspace_token_file" ? "vcs.tokenFile token" : `${bin} login`} is ${identity.data.login} but ${where} expects ${expectedAccount}`,
      resolved.credential === "workspace_token_file"
        ? `put a token for ${expectedAccount} in the ${where} vcs.tokenFile`
        : `${bin} auth login --hostname ${forge.apiHost}  # sign in as ${expectedAccount}`,
    );
  }
  return identity;
}
