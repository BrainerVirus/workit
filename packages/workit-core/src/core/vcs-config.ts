import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "./config";
import { resolveWorkspace } from "./workspaces";
// Ports of scripts/vcs/config.sh + verify-token.sh + token-create-urls.sh + merged-style.sh.
// Token never printed.

const TOKEN_PLACEHOLDER = "YOUR_TOKEN_HERE";

export const vcsConfigPath = (): string =>
  process.env.WORKFLOW_VCS_CONFIG ?? path.join(configDir(), "vcs.json");

const workspacesPath = (): string => path.join(configDir(), "workspaces.json");

const vcsCwd = (cwd?: string): string =>
  process.env.WORKFLOW_WORKSPACE_ROOT ?? cwd ?? process.cwd();

function readVcsJson(): { config: Record<string, any>; path: string; ok: boolean } {
  const cfgPath = vcsConfigPath();
  let config: Record<string, any> = {};
  let ok = false;
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        config = parsed as Record<string, any>;
        ok = true;
      }
    } catch {
      /* missing or invalid */
    }
  }
  return { config, path: cfgPath, ok };
}

/** Port of scripts/vcs/config.sh — mode: load | summary | resolve. */
export function vcsConfig(mode: "load" | "summary" | "resolve", cwd?: string): Record<string, any> {
  const ws = resolveWorkspace(vcsCwd(cwd));
  const wsVcs = (ws?.vcs ?? {}) as Record<string, any>;
  const wsYt = (ws?.youtrack ?? {}) as Record<string, any>;
  const wsIssues = (ws?.issues ?? {}) as Record<string, any>;
  const { config: cfg, path: cfgPath, ok: cfgOk } = readVcsJson();

  const provider = String(wsVcs.provider ?? cfg.provider ?? "gitlab").toLowerCase();
  const defaultTarget = String(wsVcs.defaultTargetBranch ?? cfg.defaultTargetBranch ?? "develop");
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
    return {
      ok: true,
      workspace_name: ws?.name ?? null,
      provider,
      defaultTargetBranch: defaultTarget,
      link_issues: linkIssues,
      youtrack_base_url: youtrackBaseUrl,
      issues_provider: issuesProvider,
      link_on_pr: linkOnPr,
    };
  }

  if (!cfgOk) return { ok: false, error: "missing or invalid vcs.json" };

  const prov = (cfg[provider] ?? {}) as Record<string, any>;
  const tokenFile = String(prov.tokenFile ?? path.join(configDir(), `${provider}.token`));
  const tokenPath = path.resolve(tokenFile);
  let tokenOk = false;
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const placeholder =
      !token || token === TOKEN_PLACEHOLDER || token.startsWith(TOKEN_PLACEHOLDER);
    tokenOk = !placeholder;
  }

  const out: Record<string, any> = {
    ok: true,
    configPath: path.resolve(cfgPath),
    provider,
    defaultTargetBranch: defaultTarget,
    pr: cfg.pr ?? {},
    tokenPath,
    tokenPresent: fs.existsSync(tokenPath),
    tokenReady: tokenOk,
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
  if (mode === "summary") delete out.tokenPath;
  return out;
}

/** Port of scripts/vcs/verify-token.sh — soft-fail JSON out, always exit 0. */
export async function vcsVerifyToken(): Promise<Record<string, any>> {
  const cfg = vcsConfig("load");
  if (!cfg.ok) return { ok: false, error: cfg.error ?? "vcs config not ready" };
  const provider = cfg.provider as string;
  if (!cfg.tokenReady) {
    return {
      ok: false,
      provider,
      error: "token file still placeholder YOUR_TOKEN_HERE — edit locally, then /wk-status",
      path: cfg.tokenPath,
    };
  }
  const token = fs.readFileSync(cfg.tokenPath as string, "utf8").trim();

  if (provider === "gitlab") {
    const host = (cfg.gitlab as Record<string, any>)?.host ?? "gitlab.com";
    const api = ((cfg.gitlab as Record<string, any>)?.apiUrl ?? `https://${host}/api/v4`).replace(
      /\/+$/,
      "",
    );
    let user: Record<string, any>;
    try {
      const res = await fetch(`${api}/user`, {
        headers: { "PRIVATE-TOKEN": token },
      });
      if (!res.ok) {
        return {
          ok: false,
          provider,
          error: "GitLab API rejected token",
          detail: (await res.text()).slice(0, 200),
        };
      }
      user = JSON.parse(await res.text()) as Record<string, any>;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { ok: false, provider, error: "invalid JSON from GitLab /user" };
      }
      return {
        ok: false,
        provider,
        error: "GitLab API rejected token",
        detail: (err instanceof Error ? err.message : "network error").slice(0, 200),
      };
    }
    return { ok: true, provider, username: user.username ?? user.login, name: user.name };
  }
  if (provider === "github") {
    const result = spawnSync("gh", ["api", "user"], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token },
    });
    if (result.status !== 0) {
      return {
        ok: false,
        provider,
        error: "GitHub API rejected token",
        detail: (result.stderr ?? result.stdout ?? "").slice(0, 200),
      };
    }
    try {
      const user = JSON.parse(result.stdout ?? "") as Record<string, any>;
      return { ok: true, provider, username: user.login, name: user.name };
    } catch {
      return { ok: false, provider, error: "invalid JSON from gh api user" };
    }
  }
  return { ok: false, error: `unsupported provider: ${provider}` };
}

/** Port of scripts/vcs/token-create-urls.sh — provider token-creation deep links. */
export function vcsTokenCreateUrls(): Record<string, any> {
  const tokenName = process.env.WORKFLOW_VCS_TOKEN_NAME ?? "workit";
  const { config: cfg } = readVcsJson();
  const defaults = (cfg.tokenDefaults ?? {}) as Record<string, any>;
  const name = String(defaults.name ?? tokenName);
  const desc = String(defaults.description ?? "OpenCode workit — /wk-pr and glab/gh");

  const gitlab = (cfg.gitlab ?? {}) as Record<string, any>;
  const host = String(gitlab.host ?? "gitlab.com");
  const gitlabScopes = Array.isArray(defaults.gitlabScopes) ? defaults.gitlabScopes : ["api"];
  const gitlabParams = new URLSearchParams({
    name,
    description: desc,
    scopes: gitlabScopes.join(","),
  });
  const gitlabUrl = `https://${host}/-/user_settings/personal_access_tokens?${gitlabParams}`;

  const githubPerms = defaults.githubPermissions ?? {
    pull_requests: "write",
    contents: "write",
    metadata: "read",
  };
  const ghParams = new URLSearchParams({ name, description: desc, ...githubPerms });
  const githubFineUrl = `https://github.com/settings/personal-access-tokens/new?${ghParams}`;

  const classicScopes = Array.isArray(defaults.githubClassicScopes)
    ? defaults.githubClassicScopes
    : ["repo"];
  const githubClassicUrl = `https://github.com/settings/tokens/new?${new URLSearchParams({ description: name, scopes: classicScopes.join(",") })}`;

  const provider = String(cfg.provider ?? "gitlab").toLowerCase();
  const active =
    {
      gitlab: {
        tokenFile: gitlab.tokenFile ?? path.join(configDir(), "gitlab.token"),
        createUrl: gitlabUrl,
        scopes: gitlabScopes,
        name,
      },
      github: {
        tokenFile:
          (cfg.github as Record<string, any>)?.tokenFile ?? path.join(configDir(), "github.token"),
        createUrl: githubFineUrl,
        createUrlClassic: githubClassicUrl,
        permissions: githubPerms,
        name,
      },
    }[provider] ?? {};

  return {
    tokenName: name,
    tokenDescription: desc,
    activeProvider: provider,
    active,
    gitlab: { host, createUrl: gitlabUrl, scopes: gitlabScopes, tokenFile: gitlab.tokenFile },
    github: {
      createUrl: githubFineUrl,
      createUrlClassic: githubClassicUrl,
      permissions: githubPerms,
      tokenFile: (cfg.github as Record<string, any>)?.tokenFile,
    },
  };
}

/** Port of scripts/vcs/merged-style.sh — recent merged MR/PR bodies for style reference. */
export function mergedPrStyle(limit = 6): Record<string, any> {
  const cfg = vcsConfig("load");
  if (!cfg.ok || !cfg.tokenReady) return { ok: false, error: "vcs not configured" };
  const provider = cfg.provider as string;
  const token = fs.readFileSync(cfg.tokenPath as string, "utf8").trim();
  const examples: Array<Record<string, any>> = [];

  const descInfo = (desc: string, caseInsensitiveNotes = false): Record<string, any> => ({
    hasNotesSection: caseInsensitiveNotes ? /##\s*notes/i.test(desc) : /##\s*Notes/.test(desc),
    sections: desc
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.trim()),
    descriptionPreview: desc.slice(0, 600),
  });

  if (provider === "gitlab") {
    const remote = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
    if (remote.status !== 0) return { ok: false, error: "no origin remote" };
    const url = (remote.stdout ?? "").trim();
    const m = /gitlab\.com[:/](.+?)(?:\.git)?$/.exec(url);
    if (!m) return { ok: false, error: "not a gitlab.com origin" };
    const project = m[1];
    const env = { ...process.env, GITLAB_TOKEN: token };
    const run = (args: string[]) => spawnSync("glab", ["api", ...args], { encoding: "utf8", env });
    let r = run([
      `projects/${project.replaceAll("/", "%2F")}/merge_requests?state=merged&per_page=${limit}&order_by=updated_at&sort=desc`,
    ]);
    if (r.status !== 0) {
      r = run([`merge_requests?state=merged&per_page=${limit}&order_by=updated_at&sort=desc`]);
    }
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
      ["pr", "list", "--state", "merged", "--limit", String(limit), "--json", "title,url,body"],
      { encoding: "utf8", env: { ...process.env, GH_TOKEN: token } },
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
