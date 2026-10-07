// Which forge, which repositories, and which credential (D16, design §0 #6,
// §2.0 Identity).
//
// - The push remote host decides GitHub vs GitLab. A workspace provider that
//   disagrees is `blocked` for the forge verbs, never silently overridden;
//   `git push` (checkPushIdentity) only needs git, so it pushes with a note.
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
import { FORGE_TIMEOUTS, isNetworkError, systemRunner, type ForgeRunner } from "./exec";
import { createGitHubForge } from "./github";
import { createGitLabForge } from "./gitlab";
import { redactText } from "./redact";
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
  /** Absolute deadline (`now()` clock) for every call, resolution included; null = none. */
  deadline?: number | null;
};

// Per-process memo of credential lookups and /user answers (a long-lived MCP
// server re-asks after the TTL). Scoped by runner, so an injected test runner
// never sees another's answers; only successes are kept.
const MEMO_TTL_MS = 5 * 60_000;
const SYSTEM_SCOPE = {};
const memoScopes = new WeakMap<object, Map<string, { at: number; value: unknown }>>();

function memo<T>(
  scope: object,
  key: string,
  compute: () => { keep: boolean; value: T },
  now = Date.now,
): T {
  let entries = memoScopes.get(scope);
  if (!entries) memoScopes.set(scope, (entries = new Map()));
  const hit = entries.get(key);
  if (hit && now() - hit.at < MEMO_TTL_MS) return hit.value as T;
  const { keep, value } = compute();
  if (keep) entries.set(key, { at: now(), value });
  return value;
}

/** A runner whose calls are clamped to `limits.deadline`, carrying `token`. */
function clampedRunner(
  base: ForgeRunner,
  limits: { deadline: number | null },
  now: () => number,
  token?: string,
): ForgeRunner {
  return (bin, args, callOptions) => {
    let timeoutMs = callOptions.timeoutMs;
    if (limits.deadline !== null) {
      const remaining = limits.deadline - now();
      if (remaining <= 0)
        return {
          status: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          missing: false,
          timeoutMs: 0,
        };
      timeoutMs = Math.min(timeoutMs, remaining);
    }
    const run = base(bin, args, { ...callOptions, timeoutMs, ...(token ? { token } : {}) });
    return run.timedOut && run.timeoutMs === undefined ? { ...run, timeoutMs } : run;
  };
}

/** `forge.identity` answered once per credential per TTL (push, then pr create, …). */
const memoizedIdentity = (forge: Forge, scope: object, credentialKey: string): Forge => {
  const identity = (expected: string | null) => forge.identity(expected);
  return {
    ...forge,
    identity: (expected: string | null) =>
      memo(
        scope,
        `identity ${forge.kind} ${forge.apiHost} ${credentialKey} ${expected ?? ""}`,
        () => {
          const value = identity(expected);
          return { keep: value.ok, value };
        },
      ),
  };
};

type Credential = { token: string | undefined; credential: CredentialSource };

/** The credential every API call carries (see the header). */
function resolveCredential(
  workspace: ReturnType<typeof resolveRuntimeWorkspaceVcs>,
  derived: DerivedForge,
  run: ForgeRunner,
  scope: object,
): ForgeResult<Credential> {
  const { kind, apiHost } = derived;
  const expectedAccount = workspace?.vcs?.account ?? null;
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
    let token = "";
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
    return success({ token, credential: "workspace_token_file" });
  }
  // glab keeps one login per host, so a GitLab account is checked, not selected.
  if (!expectedAccount || kind !== "github")
    return success({ token: undefined, credential: "cli_login" });
  return memo(scope, `token ${apiHost} ${expectedAccount}`, () => {
    const issued = run("gh", ["auth", "token", "--hostname", apiHost, "--user", expectedAccount], {
      timeoutMs: FORGE_TIMEOUTS.api,
    });
    const value = authTokenResult(issued, apiHost, expectedAccount, workspace?.name ?? "?");
    return { keep: value.ok, value };
  });
}

/**
 * `gh auth token --user`: a timeout or a transport error is `unavailable`
 * (exit 5, retry); only gh saying it has no such login is identity_unavailable.
 */
function authTokenResult(
  issued: ReturnType<ForgeRunner>,
  apiHost: string,
  account: string,
  workspace: string,
): ForgeResult<Credential> {
  if (issued.missing)
    return failure(
      "unavailable",
      "gh is not installed",
      "install the GitHub CLI (https://cli.github.com) and run: gh auth login",
    );
  if (issued.timedOut)
    return failure(
      "unavailable",
      `gh auth token ${issued.timeoutMs === 0 ? "not attempted: the time budget ran out" : `timed out after ${issued.timeoutMs ?? FORGE_TIMEOUTS.api} ms`} (looking up the ${account} login on ${apiHost})`,
      "gh auth status  # check gh and the network, then retry",
    );
  const token = issued.status === 0 ? issued.stdout.trim() : "";
  if (token) return success({ token, credential: "gh_account_token" });
  const stderr = redactText(issued.stderr).trim();
  const first = stderr.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  if (issued.status !== 0 && first && !/no oauth token|not logged in|no account/iu.test(stderr))
    return failure(
      "unavailable",
      `gh auth token failed${isNetworkError(stderr) ? " (network)" : ""}: ${first.slice(0, 200)}`,
      "gh auth status  # check gh and the network, then retry",
    );
  return failure(
    "blocked",
    `identity_unavailable: gh has no login for ${account} on ${apiHost} (workspace ${workspace})`,
    `gh auth login --hostname ${apiHost}  # sign in as ${account}; workit passes that account's token per call and never switches the active account`,
  );
}

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
  const scope = options.runner ?? SYSTEM_SCOPE;
  const now = options.now ?? Date.now;
  const expectedAccount = workspace?.vcs?.account ?? null;
  // The deadline covers resolution too, so a verb's --timeout bounds it all.
  const limits: { deadline: number | null } = { deadline: options.deadline ?? null };
  const credential = resolveCredential(workspace, derived, clampedRunner(base, limits, now), scope);
  if (!credential.ok) return credential;
  const runner = clampedRunner(base, limits, now, credential.data.token);
  const memoKey = `${credential.data.credential} ${credential.data.token ?? ""}`;

  // Base repository: an `upstream` remote on the same forge, else the fork parent.
  const headRepo = derived.repo;
  const probe = memoizedIdentity(createForge(derived, headRepo, runner), scope, memoKey);
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
    forge:
      baseRepo === headRepo
        ? probe
        : memoizedIdentity(createForge(derived, baseRepo, runner), scope, memoKey),
    remote: pushed.remote,
    url: pushed.url,
    derived,
    workspace: workspace?.name ?? null,
    expectedAccount,
    credential: credential.data.credential,
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
  if (identity.data.matches === false)
    return mismatch(resolved, identity.data.login ?? "?", resolved.workspace);
  return identity;
}

const mismatch = <T>(
  resolved: Pick<ResolvedForge, "forge" | "credential" | "expectedAccount">,
  login: string,
  workspace: string | null,
): ForgeResult<T> => {
  const { forge, expectedAccount } = resolved;
  const bin = forge.kind === "github" ? "gh" : "glab";
  const where = `workspace ${workspace ?? "?"}`;
  const fileFix = `put a token for ${expectedAccount} in the ${where} vcs.tokenFile`;
  return failure(
    "blocked",
    `identity_mismatch: the ${resolved.credential === "workspace_token_file" ? "vcs.tokenFile token" : `${bin} login`} is ${login} but ${where} expects ${expectedAccount}`,
    resolved.credential === "workspace_token_file"
      ? fileFix
      : forge.kind === "github"
        ? `gh auth login --hostname ${forge.apiHost}  # sign in as ${expectedAccount}`
        : // glab keeps one login per host; switching it would change every repo.
          `${fileFix} (glab keeps one login per host, so workit never switches it)`,
  );
};

/** Total budget for the identity check before a push (B1). */
export const PUSH_IDENTITY_BUDGET_MS = 5_000;

export type PushIdentity = {
  /**
   * verified: the forge says the credential is the workspace account.
   * no_account: the workspace names no vcs.account, so there is nothing to check.
   * skipped: the check could not run (forge down, slow, unknown, misconfigured);
   * git pushes anyway and `reason` says why.
   */
  status: "verified" | "no_account" | "skipped";
  forge: "github" | "gitlab" | null;
  account: string | null;
  login: string | null;
  reason?: string;
  unblock?: string;
};

/**
 * The best-effort identity check before `git push`: git decides the transport,
 * so only a forge that positively reports another account blocks (S10, B1).
 * Every other outcome pushes with `status: "skipped"` and the reason. All
 * calls share one `budgetMs` and are memoized per credential.
 */
export function checkPushIdentity(
  cwd: string,
  options: Omit<ResolveOptions, "deadline"> & { budgetMs?: number } = {},
): ForgeResult<PushIdentity> {
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
  const account = workspace?.vcs?.account ?? null;
  const skipped = (forge: PushIdentity["forge"], reason: string, unblock?: string) =>
    success<PushIdentity>({
      status: "skipped",
      forge,
      account,
      login: null,
      reason,
      ...(unblock ? { unblock } : {}),
    });
  const pushed = pushForge(cwd, {
    branch: options.branch,
    hosts: configuredHosts(),
    sshConfig: options.sshConfig,
  });
  if (!pushed.ok) {
    const host = /^unsupported_forge: .*?"([^"]+)"/u.exec(pushed.error)?.[1];
    return skipped(
      null,
      host
        ? `unsupported_forge: ${host} is not a GitHub or GitLab host workit knows; pushed with git only (no identity check, no PR or CI verbs)`
        : pushed.error,
      pushed.unblock,
    );
  }
  const derived = pushed.forge;
  const conflict = forgeConflict(derived, workspace?.vcs?.provider);
  if (conflict) return skipped(derived.kind, conflict.error, conflict.unblock);
  if (!account) return success({ status: "no_account", forge: derived.kind, account, login: null });

  const base =
    options.runner ?? systemRunner(derived.kind, derived.apiHost, options.env ?? process.env);
  const scope = options.runner ?? SYSTEM_SCOPE;
  const now = options.now ?? Date.now;
  const limits = { deadline: now() + (options.budgetMs ?? PUSH_IDENTITY_BUDGET_MS) };
  const credential = resolveCredential(workspace, derived, clampedRunner(base, limits, now), scope);
  if (!credential.ok) return skipped(derived.kind, credential.error, credential.unblock);
  const forge = memoizedIdentity(
    createForge(derived, derived.repo, clampedRunner(base, limits, now, credential.data.token)),
    scope,
    `${credential.data.credential} ${credential.data.token ?? ""}`,
  );
  const identity = forge.identity(account);
  if (!identity.ok) return skipped(derived.kind, identity.error, identity.unblock);
  if (identity.data.matches === false)
    return mismatch(
      { forge, credential: credential.data.credential, expectedAccount: account },
      identity.data.login ?? "?",
      workspace?.name ?? null,
    );
  if (identity.data.matches === null)
    return skipped(derived.kind, identity.data.note ?? "the credential cannot read /user");
  return success({ status: "verified", forge: derived.kind, account, login: identity.data.login });
}
