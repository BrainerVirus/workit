import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, PRESETS } from "./config";
import { resolveRuntimeWorkspaceVcs } from "./workspaces";
import { resolveBranchPolicyFor } from "./branch";
import { resolveTrackFor, type RuntimeReleaseTrack, type TrackResolution } from "./release-tracks";
// VCS resolution and CLI-backed identity/style reads.

export const vcsConfigPath = (): string =>
  process.env.WORKFLOW_VCS_CONFIG ?? path.join(configDir(), "vcs.json");

const workspacesPath = (): string => path.join(configDir(), "workspaces.json");

const vcsCwd = (cwd?: string): string =>
  cwd ?? process.env.WORKFLOW_WORKSPACE_ROOT ?? process.cwd();

// RL-03b: the origin remote is the ground truth for PR creation. A stale global
// provider (e.g. gitlab from another repo) must not drive glab on a
// github.com-hosted checkout. Recognized hosts only — custom/self-hosted
// remotes keep the configured provider, and a missing origin is untouched.
const remoteProvider = (cwd: string): string | null => {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const url = (r.stdout ?? "").trim();
  if (/github\.com[:/]/.test(url)) return "github";
  if (/gitlab\.com[:/]/.test(url)) return "gitlab";
  return null;
};

const remoteEndpoint = (
  remote: string,
): { host: string; path: string; protocol: string; port: string } | null => {
  const raw = remote.trim();
  if (!raw) return null;
  const scp = /^(?:[^@\s]+@)?([^:]+):(.+)$/u.exec(raw);
  if (scp && !raw.includes("://"))
    return {
      host: scp[1].toLowerCase(),
      path: scp[2].replace(/^\//u, "").replace(/\.git$/u, ""),
      protocol: "ssh:",
      port: "",
    };
  try {
    const url = new URL(raw);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname
        .replace(/^\//u, "")
        .replace(/\.git$/u, "")
        .replace(/\/$/u, ""),
      protocol: url.protocol,
      port: url.port,
    };
  } catch {
    return null;
  }
};

const configuredSshEndpoint = (host: string): { host: string; port: string } | null => {
  if (host.startsWith("-")) return null;
  const resolved = spawnSync("ssh", ["-G", host], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: process.env.PATH ?? "" },
  });
  if (resolved.status !== 0) return null;
  const output = resolved.stdout ?? "";
  const hostname = /^hostname\s+(\S+)/imu.exec(output)?.[1]?.toLowerCase();
  if (!hostname) return null;
  return { host: hostname, port: /^port\s+(\d+)/imu.exec(output)?.[1] ?? "22" };
};

const sshApiHostAliases: Record<string, Array<{ host: string; port: string }>> = {
  "github.com": [{ host: "ssh.github.com", port: "443" }],
  "gitlab.com": [{ host: "altssh.gitlab.com", port: "443" }],
};

/** Confirm that Git transport and authenticated provider API calls target the same host. */
export const hostingApiHostMatches = (
  remote: string,
  apiHost: string,
  resolveSshEndpoint: (
    host: string,
  ) => { host: string; port: string } | null = configuredSshEndpoint,
): boolean => {
  const endpoint = remoteEndpoint(remote);
  if (!endpoint) return false;
  let expected: { host: string; port: string };
  try {
    const url = new URL(`https://${apiHost}`);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      return false;
    expected = {
      host: url.hostname.toLowerCase().replace(/\.$/u, ""),
      port: url.port,
    };
  } catch {
    return false;
  }
  if (endpoint.protocol !== "ssh:") {
    return endpoint.host.replace(/\.$/u, "") === expected.host && endpoint.port === expected.port;
  }
  const resolved = resolveSshEndpoint(endpoint.host);
  if (!resolved) return false;
  const hostname = resolved.host.toLowerCase().replace(/\.$/u, "");
  const port = endpoint.port || resolved.port;
  if (hostname === expected.host) return port === (expected.port || "22");
  return Boolean(
    sshApiHostAliases[expected.host]?.some(
      (alias) =>
        alias.host === hostname &&
        alias.port === port &&
        (!expected.port || expected.port === port),
    ),
  );
};

// RL-01: typed vcs.json reader. Missing is a legitimate unconfigured state;
// malformed (parse failure or a non-object) is reported with the exact path so
// risky consumers stop instead of silently reading defaults.
export type VcsConfigResult = {
  status: "missing" | "valid" | "malformed";
  path: string;
  config: Record<string, any>;
  error?: string;
};

export const readVcsConfig = (): VcsConfigResult => {
  const file = vcsConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { status: "missing", path: file, config: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", path: file, config: {}, error: `${file} is not valid JSON` };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { status: "valid", path: file, config: parsed as Record<string, any> };
  }
  return { status: "malformed", path: file, config: {}, error: `${file} is not a JSON object` };
};

/** The release track a vcsConfig call resolved (null: the workspace has no tracks). */
export type ResolvedReleaseTrack = {
  name: string | null;
  source: string;
  detail: string;
  warnings: string[];
  track: RuntimeReleaseTrack | null;
  /** Every configured track, for displays and the branch policy. */
  tracks: RuntimeReleaseTrack[];
};

export type VcsConfigOptions = {
  /** An explicit release track (`--track`); else WORKFLOW_RELEASE_TRACK. */
  track?: string | null;
  /** Resolve the track for this branch instead of the checked-out one. */
  branch?: string | null;
};

const trackSummary = (resolution: TrackResolution): ResolvedReleaseTrack | null =>
  resolution.status === "resolved"
    ? {
        name: resolution.track?.name ?? null,
        source: resolution.source,
        detail: resolution.detail,
        warnings: resolution.warnings,
        track: resolution.track,
        tracks: resolution.tracks,
      }
    : null;

/** Port of scripts/vcs/config.sh — mode: load | summary | resolve. */
export function vcsConfig(
  mode: "load" | "summary" | "resolve",
  cwd?: string,
  options: VcsConfigOptions = {},
): Record<string, any> {
  const ws = resolveRuntimeWorkspaceVcs(vcsCwd(cwd));
  const wsVcs = (ws?.vcs ?? {}) as Record<string, any>;
  const wsYt = (ws?.youtrack ?? {}) as Record<string, any>;
  const wsIssues = (ws?.issues ?? {}) as Record<string, any>;
  const { status: cfgStatus, path: cfgPath, config: cfg, error: cfgError } = readVcsConfig();

  // Explicit workspace vcs.provider is the user's per-repo intent and wins;
  // otherwise, with a determinate repo root (explicit cwd or host-provided
  // WORKFLOW_WORKSPACE_ROOT), the origin remote is authoritative over the
  // global default (RL-03b). Ambient process.cwd() callers keep the legacy
  // config-only contract (CA-06 parity), so a stale global default cannot
  // contaminate host-agnostic reads.
  const root = vcsCwd(cwd);
  const determinateRoot = cwd !== undefined || process.env.WORKFLOW_WORKSPACE_ROOT !== undefined;
  // No silent default: a provider resolves from the workspace, the origin
  // remote, or the global config — otherwise it is null, explicitly. Branch
  // policy never needed a provider (preset defaults apply); credential and
  // PR flows fail closed on null instead of assuming a host.
  const rawProvider =
    wsVcs.provider ?? (determinateRoot ? remoteProvider(root) : null) ?? cfg.provider ?? null;
  const provider =
    rawProvider === null || rawProvider === undefined
      ? null
      : String(rawProvider).toLowerCase() || null;
  // CA-05: workspace/global explicit target wins; when unset the resolved
  // branch-policy preset supplies the default (gitflow->develop,
  // github-flow->main, trunk-based->master, custom->develop). Shared by load
  // and resolve so both surfaces stay consistent.
  // CA-09: the one resolver wrapper — same policy resolution every consumer
  // uses, so the tightened gate in branch-policy-resolver.test.ts stays green.
  // CA-02: a matched workspace's OWN branchPolicy default beats any global
  // vcs.json default (PR #43: global develop shadowed the personal github-flow
  // main). Explicit workspace vcs.defaultTargetBranch stays authoritative; a
  // workspace without a branchPolicy still falls back to the global vcs.json
  // default, and unmatched repos keep it too.
  const wp = (ws?.branchPolicy ?? {}) as Record<string, any>;
  const hasWorkspacePolicy = typeof wp.preset === "string" && Object.hasOwn(PRESETS, wp.preset);
  const policyDefault = resolveBranchPolicyFor(root).defaultTargetBranch;
  const workspaceDefault = String(
    wsVcs.defaultTargetBranch ??
      (hasWorkspacePolicy ? policyDefault : (cfg.defaultTargetBranch ?? policyDefault)) ??
      "develop",
  );
  // Release tracks (core/release-tracks.ts): the one place a branch's line is
  // decided. With tracks, the PR target and the base for new branches come
  // from the resolved track; without, the workspace default stays as is.
  const trackResolution = resolveTrackFor(root, {
    track: options.track,
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    defaultBranch: workspaceDefault,
  });
  if (trackResolution.status === "invalid")
    return { ok: false, error: trackResolution.error, configPath: workspacesPath() };
  const releaseTrack = trackSummary(trackResolution);
  const defaultTarget = releaseTrack?.track?.pullRequestTarget ?? workspaceDefault;
  const baseBranch = releaseTrack?.track?.baseBranch ?? defaultTarget;
  const linkIssues = typeof wsYt.link_issues === "boolean" ? wsYt.link_issues : null;
  const youtrackBaseUrl = typeof wsYt.baseUrl === "string" ? wsYt.baseUrl : null;
  // github issues path only when BOTH providers are github (mirrors WorkspaceConfig.issues).
  let issuesProvider: string | null = null;
  let linkOnPr: boolean | null = null;
  if (
    provider === "github" &&
    typeof wsIssues.provider === "string" &&
    wsIssues.provider.toLowerCase() === "github"
  ) {
    issuesProvider = "github";
    linkOnPr = typeof wsIssues.link_on_pr === "boolean" ? wsIssues.link_on_pr : null;
  }

  if (mode === "resolve") {
    // RL-01: malformed vcs.json blocks resolution with an exact-path diagnostic
    // instead of silently resolving defaults; a missing file is still a
    // legitimate unconfigured state that falls back to defaults.
    if (cfgStatus === "malformed") return { ok: false, error: cfgError, configPath: cfgPath };
    return {
      ok: true,
      workspace_name: ws?.name ?? null,
      provider,
      defaultTargetBranch: defaultTarget,
      /** The target before release tracks (vcs.defaultTargetBranch or the policy default). */
      workspaceDefaultTargetBranch: workspaceDefault,
      baseBranch,
      releaseTrack,
      link_issues: linkIssues,
      youtrack_base_url: youtrackBaseUrl,
      issues_provider: issuesProvider,
      link_on_pr: linkOnPr,
    };
  }

  if (cfgStatus === "malformed") {
    return { ok: false, error: cfgError, configPath: cfgPath };
  }
  if (cfgStatus === "missing" && provider === null)
    return { ok: false, error: `vcs.json is missing: ${cfgPath}`, configPath: cfgPath };
  // Hosting cannot resolve without a provider; branch policy still can.
  if (provider === null) {
    return {
      ok: false,
      error: `no vcs provider configured (set vcs.provider in ${cfgPath}, match a workspace entry, or run inside a checkout with a recognized origin remote)`,
      configPath: cfgPath,
    };
  }

  const prov = (cfg[provider] ?? {}) as Record<string, any>;
  const out: Record<string, any> = {
    ok: true,
    configPath: path.resolve(cfgPath),
    provider,
    defaultTargetBranch: defaultTarget,
    baseBranch,
    releaseTrack,
    pr: cfg.pr ?? {},
    workspace_name: ws?.name ?? null,
    link_issues: linkIssues,
    youtrack_base_url: youtrackBaseUrl,
    issues_provider: issuesProvider,
    link_on_pr: linkOnPr,
  };
  if (provider === "gitlab") {
    out.gitlab = {
      host: prov.host ?? "gitlab.com",
      apiUrl: prov.apiUrl ?? "https://gitlab.com/api/v4",
    };
  } else if (provider === "github") {
    out.github = { host: prov.host ?? "github.com" };
  }
  return out;
}

/** Probe the CLI credential actually used for this checkout, never a Workit token file. */
export function vcsCliIdentity(cwd?: string): Record<string, any> {
  const root = vcsCwd(cwd);
  const cfg = vcsConfig("load", root);
  if (!cfg.ok) return { ok: false, error: cfg.error ?? "vcs config not ready" };
  const provider = cfg.provider as string;
  if (provider !== "gitlab" && provider !== "github")
    return { ok: false, error: `unsupported provider: ${provider}` };
  const bin = provider === "gitlab" ? "glab" : "gh";
  const host = String(
    provider === "github" ? (cfg.github?.host ?? "github.com") : (cfg.gitlab?.host ?? "gitlab.com"),
  ).toLowerCase();
  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    ...(provider === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
  };
  const result = spawnSync(bin, ["api", "user"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0)
    return { ok: false, provider, error: `${bin} is missing or not authenticated` };
  try {
    const user = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
    const username = provider === "gitlab" ? user.username : user.login;
    if (typeof username !== "string" || !username)
      return { ok: false, provider, error: `invalid ${bin} identity response` };
    const expected = resolveRuntimeWorkspaceVcs(root)?.vcs?.account;
    if (expected && username.toLowerCase() !== expected.toLowerCase())
      return {
        ok: false,
        provider,
        error: `${bin} account ${username} does not match ${expected}`,
      };
    return { ok: true, provider, host, username, name: user.name };
  } catch {
    return { ok: false, provider, error: `invalid JSON from ${bin} api user` };
  }
}

/** Legacy command name, now verifies native CLI auth rather than a separate token. */
/** Port of scripts/vcs/merged-style.sh — recent merged MR/PR bodies for style reference. */
export function mergedPrStyle(limit = 6, cwd?: string): Record<string, any> {
  const cfg = vcsConfig("load", cwd);
  if (!cfg.ok) return { ok: false, error: "vcs not configured" };
  const provider = cfg.provider as string;
  const host = String(
    provider === "github" ? (cfg.github?.host ?? "github.com") : (cfg.gitlab?.host ?? "gitlab.com"),
  ).toLowerCase();
  const env = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    ...(provider === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
  };
  const examples: Array<Record<string, any>> = [];

  const descInfo = (desc: string, caseInsensitiveNotes = false): Record<string, any> => ({
    hasNotesSection: caseInsensitiveNotes ? /##\s*notes/i.test(desc) : /##\s*Notes/.test(desc),
    sections: desc
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.trim()),
    descriptionPreview: desc.slice(0, 600),
  });

  const remoteResult = spawnSync("git", ["remote", "get-url", "--push", "--all", "origin"], {
    cwd,
    encoding: "utf8",
  });
  const remotes = (remoteResult.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.length === 0) return { ok: false, error: "no origin remote" };
  if (remotes.length !== 1) return { ok: false, error: "origin has ambiguous push destinations" };
  const remote = remotes[0];
  const endpoint = remoteEndpoint(remote);
  if (!endpoint?.path) return { ok: false, error: "hosting repository could not be resolved" };
  if (!hostingApiHostMatches(remote, host))
    return { ok: false, error: "PR style target does not match the provider host" };

  if (provider === "gitlab") {
    const run = (args: string[]) =>
      spawnSync("glab", ["api", ...args], {
        cwd,
        encoding: "utf8",
        env,
      });
    let r = run([
      `projects/${endpoint.path.replaceAll("/", "%2F")}/merge_requests?state=merged&per_page=${limit}&order_by=updated_at&sort=desc`,
    ]);
    if (r.status !== 0) return { ok: false, error: "could not list merge requests" };
    for (const mr of JSON.parse(r.stdout ?? "[]") as Array<Record<string, any>>) {
      const desc = String(mr.description ?? "").trim();
      examples.push({
        title: mr.title,
        url: mr.web_url,
        squash: mr.squash,
        ...descInfo(desc, true),
      });
    }
  } else if (provider === "github") {
    const r = spawnSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        `${host}/${endpoint.path}`,
        "--state",
        "merged",
        "--limit",
        String(limit),
        "--json",
        "title,url,body",
      ],
      { cwd, encoding: "utf8", env },
    );
    if (r.status !== 0) return { ok: false, error: "could not list pull requests" };
    for (const pr of JSON.parse(r.stdout ?? "[]") as Array<Record<string, any>>) {
      const desc = String(pr.body ?? "").trim();
      examples.push({ title: pr.title, url: pr.url, ...descInfo(desc) });
    }
  }

  return {
    ok: true,
    provider,
    count: examples.length,
    styleHints: [
      "Prefer ## Summary bullets + ## Validation or ## Test plan only",
      "Do not add ## Notes with branch names, commit counts, or diff stats",
      "Do not paste commit log or diff stat into the body",
    ],
    examples,
  };
}

export const vcsWorkspacesPath = workspacesPath;
