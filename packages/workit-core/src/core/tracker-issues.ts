import { spawnSync } from "node:child_process";
import { hostingCliAvailable, parseGhIssue, pushRemote } from "./pr-create";
import { hostingApiHostMatches, vcsConfig } from "./vcs-config";

// Read-only issue fetches for context.read (GitHub + GitLab), mirroring the
// YouTrack triple shape. Authenticated gh/glab serves the read in the target checkout.

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
  remote?: (root: string) => string | null;
  cli?: TrackerCli;
  host?: string;
};

/** Native CLI runner (gh/glab) when installed; null when absent. */
const defaultCli = (bin: string, available: boolean): TrackerCli | null => {
  if (!available) return null;
  return (args, root) => {
    const out = spawnSync(bin, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    return Promise.resolve({
      status: out.status ?? 1,
      stdout: out.stdout ?? "",
      stderr: (out.error as Error | undefined)?.message ?? out.stderr ?? "",
    });
  };
};

const tryCliTriple = async (
  cli: TrackerCli | null | undefined,
  name: string,
  args: string[],
  root: string,
  id: string,
  idKeys: string[],
  bodyKeys: string[],
): Promise<{ data: TrackerIssueBody } | TrackerIssueFailure> => {
  if (!cli) return { error: `${name} CLI is unavailable`, kind: "creds" };
  const run = cli(args, root);
  if (!run) return { error: `${name} CLI is unavailable`, kind: "creds" };
  const out = await run;
  if (out.status !== 0)
    return { error: `${name} CLI is not authenticated or the issue is unavailable`, kind: "creds" };
  try {
    const triple = parseTriple(
      JSON.parse(out.stdout) as Record<string, unknown>,
      id,
      idKeys,
      bodyKeys,
    );
    return triple
      ? { data: triple }
      : { error: `unexpected ${name} issue response`, kind: "request" };
  } catch {
    return { error: `invalid ${name} issue response`, kind: "request" };
  }
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

/** Fetch a GitHub issue triple for context.read through the authenticated CLI. */
export const fetchGitHubIssueBody = async (
  ref: string,
  root: string,
  deps: TrackerDeps = {},
): Promise<{ data: TrackerIssueBody } | TrackerIssueFailure> => {
  const id = parseGhIssue(ref);
  if (!/^\d+$/.test(id)) return { error: `invalid GitHub issue ref "${ref}"`, kind: "input" };
  const remote = (deps.remote ?? pushRemote)(root);
  const repo = repoPathFromRemote(remote ?? "");
  if (!repo) return { error: "no origin remote to resolve the repository", kind: "input" };
  const cfg = vcsConfig("load", root);
  const host = (
    deps.host ??
    (cfg.ok && cfg.provider === "github" ? cfg.github?.host : null) ??
    "github.com"
  ).toLowerCase();
  if (!remote || !hostingApiHostMatches(remote, host))
    return { error: "hosting API host does not match the push destination", kind: "input" };
  const repoArg = host === "github.com" ? repo : `${host}/${repo}`;
  return tryCliTriple(
    deps.cli ?? defaultCli("gh", hostingCliAvailable("github")),
    "gh",
    ["issue", "view", id, "--repo", repoArg, "--json", "number,title,body,state"],
    root,
    id,
    ["number"],
    ["body"],
  );
};

/** Fetch a GitLab issue triple for context.read through the authenticated CLI. */
export const fetchGitLabIssueBody = async (
  ref: string,
  root: string,
  deps: TrackerDeps = {},
): Promise<{ data: TrackerIssueBody } | TrackerIssueFailure> => {
  const id = parseGhIssue(ref);
  if (!/^\d+$/.test(id)) return { error: `invalid GitLab issue ref "${ref}"`, kind: "input" };
  const remote = (deps.remote ?? pushRemote)(root);
  const repo = repoPathFromRemote(remote ?? "");
  if (!repo) return { error: "no origin remote to resolve the project", kind: "input" };
  const cfg = vcsConfig("load", root);
  const host = (
    deps.host ??
    (cfg.ok && cfg.provider === "gitlab" ? cfg.gitlab?.host : null) ??
    "gitlab.com"
  ).toLowerCase();
  if (!remote || !hostingApiHostMatches(remote, host))
    return { error: "hosting API host does not match the push destination", kind: "input" };
  const repoArg = host === "gitlab.com" ? repo : `https://${host}/${repo}`;
  return tryCliTriple(
    deps.cli ?? defaultCli("glab", hostingCliAvailable("gitlab")),
    "glab",
    ["issue", "view", id, "-R", repoArg, "-F", "json"],
    root,
    id,
    ["iid"],
    ["description"],
  );
};
