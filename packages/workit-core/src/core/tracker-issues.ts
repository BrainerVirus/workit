import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { vcsConfig } from "./vcs-config";
import { hostingCliAvailable, parseGhIssue } from "./pr-create";

// Read-only issue fetches for context.read (GitHub + GitLab), mirroring the
// YouTrack triple shape. CLI-first: the native gh/glab CLI serves the read
// when installed (per-directory identity comes free); token files are the
// fallback and fail closed without one. No writes, no new secret files.

export type TrackerIssueBody = {
  id: string;
  title: string;
  body: string | null;
  state: string | null;
};

export type TrackerIssueFailure = {
  error: string;
  kind: "creds" | "request" | "input";
};

export type TrackerRequest = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; stdout: string; stderr: string }>;

export const trackerRequest: TrackerRequest = async (url, init) => {
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers });
    const text = await res.text();
    if (!res.ok) return { status: res.status, stdout: "", stderr: text.slice(0, 200) };
    return { status: 0, stdout: text, stderr: "" };
  } catch (err) {
    return { status: 1, stdout: "", stderr: err instanceof Error ? err.message : "network error" };
  }
};

/** Full repo path from an origin URL (scp-style, https, or bare); subgroups kept. */
export const repoPathFromRemote = (remote: string): string | null => {
  let rest = (remote || "").trim().replace(/\/+$/, "");
  if (!rest) return null;
  if (rest.endsWith(".git")) rest = rest.slice(0, -4);
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(rest);
  if (scp) return scp[1].replace(/^\//, "") || null;
  try {
    const url = new URL(rest.includes("://") ? rest : `https://${rest}`);
    return url.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
};

export type TrackerCli = (
  args: string[],
  root: string,
) => Promise<{ status: number; stdout: string; stderr: string }> | null;

export type TrackerDeps = {
  creds?: (root: string) => TrackerCreds;
  request?: TrackerRequest;
  remote?: (root: string) => string | null;
  cli?: TrackerCli;
};

/** Native CLI runner (gh/glab) when installed; null when absent. */
const defaultCli = (bin: string, available: boolean): TrackerCli | null => {
  if (!available) return null;
  return (args, root) => {
    const out = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
    return Promise.resolve({
      status: out.status ?? 1,
      stdout: out.stdout ?? "",
      stderr: (out.error as Error | undefined)?.message ?? out.stderr ?? "",
    });
  };
};

const tryCliTriple = async (
  cli: TrackerCli | null | undefined,
  args: string[],
  root: string,
  id: string,
  idKeys: string[],
  bodyKeys: string[],
): Promise<TrackerIssueBody | null> => {
  if (!cli) return null;
  const run = cli(args, root);
  if (!run) return null;
  const out = await run;
  if (out.status !== 0) return null;
  try {
    return parseTriple(JSON.parse(out.stdout) as Record<string, unknown>, id, idKeys, bodyKeys);
  } catch {
    return null;
  }
};

const originRemote = (root: string): string | null => {
  const out = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  return out.status === 0 ? (out.stdout ?? "").trim() || null : null;
};

type TrackerCreds = { token: string; api: string } | { error: string };

const trackerCreds = (root: string, provider: "github" | "gitlab"): TrackerCreds => {
  const cfg = vcsConfig("load", root) as Record<string, unknown>;
  if (!cfg || cfg.provider !== provider || typeof cfg.tokenPath !== "string" || !cfg.tokenPath)
    return { error: `unconfigured ${provider} provider` };
  let token = "";
  try {
    token = fs.readFileSync(cfg.tokenPath, "utf8").trim();
  } catch {
    return { error: `missing ${provider} token` };
  }
  if (!token) return { error: `empty ${provider} token file` };
  if (provider === "gitlab") {
    const gitlab = cfg.gitlab as Record<string, unknown> | undefined;
    const apiUrl = String(gitlab?.apiUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
    return { token, api: apiUrl };
  }
  const github = cfg.github as Record<string, unknown> | undefined;
  const host = String(github?.host ?? "github.com").toLowerCase();
  return {
    token,
    api: host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`,
  };
};

const parseTriple = (
  parsed: Record<string, unknown>,
  id: string,
  idKeys: string[],
  bodyKeys: string[],
): TrackerIssueBody | null => {
  const title = parsed.title;
  if (typeof title !== "string") return null;
  const pick = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
    }
    return null;
  };
  const foundId = pick(idKeys) ?? id;
  const state = typeof parsed.state === "string" ? parsed.state : null;
  return { id: foundId, title, body: pick(bodyKeys), state };
};

/** Fetch a GitHub issue triple for context.read: gh CLI first, token fallback (fail-closed). */
export const fetchGitHubIssueBody = async (
  ref: string,
  root: string,
  deps: TrackerDeps = {},
): Promise<{ data: TrackerIssueBody } | TrackerIssueFailure> => {
  const id = parseGhIssue(ref);
  if (!/^\d+$/.test(id)) return { error: `invalid GitHub issue ref "${ref}"`, kind: "input" };
  const repo = repoPathFromRemote((deps.remote ?? originRemote)(root) ?? "");
  if (!repo) return { error: "no origin remote to resolve the repository", kind: "input" };
  const viaCli = await tryCliTriple(
    deps.cli ?? defaultCli("gh", hostingCliAvailable("github")),
    ["issue", "view", id, "--repo", repo, "--json", "number,title,body,state"],
    root,
    id,
    ["number"],
    ["body"],
  );
  if (viaCli) return { data: viaCli };
  const credentials = (deps.creds ?? ((r) => trackerCreds(r, "github")))(root);
  if ("error" in credentials) return { ...credentials, kind: "creds" as const };
  const out = await (deps.request ?? trackerRequest)(
    `${credentials.api}/repos/${repo}/issues/${id}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (out.status !== 0)
    return { error: out.stderr || "GitHub issue fetch failed", kind: "request" };
  try {
    const triple = parseTriple(
      JSON.parse(out.stdout) as Record<string, unknown>,
      id,
      ["number"],
      ["body"],
    );
    if (!triple) return { error: "unexpected GitHub issue shape", kind: "request" };
    return { data: triple };
  } catch {
    return { error: "invalid GitHub issue response", kind: "request" };
  }
};

/** Fetch a GitLab issue triple for context.read: glab CLI first, token fallback (fail-closed). */
export const fetchGitLabIssueBody = async (
  ref: string,
  root: string,
  deps: TrackerDeps = {},
): Promise<{ data: TrackerIssueBody } | TrackerIssueFailure> => {
  const id = parseGhIssue(ref);
  if (!/^\d+$/.test(id)) return { error: `invalid GitLab issue ref "${ref}"`, kind: "input" };
  const repo = repoPathFromRemote((deps.remote ?? originRemote)(root) ?? "");
  if (!repo) return { error: "no origin remote to resolve the project", kind: "input" };
  const viaCli = await tryCliTriple(
    deps.cli ?? defaultCli("glab", hostingCliAvailable("gitlab")),
    ["issue", "view", id, "-R", repo, "-F", "json"],
    root,
    id,
    ["iid"],
    ["description"],
  );
  if (viaCli) return { data: viaCli };
  const credentials = (deps.creds ?? ((r) => trackerCreds(r, "gitlab")))(root);
  if ("error" in credentials) return { ...credentials, kind: "creds" as const };
  const out = await (deps.request ?? trackerRequest)(
    `${credentials.api}/projects/${encodeURIComponent(repo)}/issues/${id}`,
    { method: "GET", headers: { "PRIVATE-TOKEN": credentials.token } },
  );
  if (out.status !== 0)
    return { error: out.stderr || "GitLab issue fetch failed", kind: "request" };
  try {
    const triple = parseTriple(
      JSON.parse(out.stdout) as Record<string, unknown>,
      id,
      ["iid"],
      ["description"],
    );
    if (!triple) return { error: "unexpected GitLab issue shape", kind: "request" };
    return { data: triple };
  } catch {
    return { error: "invalid GitLab issue response", kind: "request" };
  }
};
