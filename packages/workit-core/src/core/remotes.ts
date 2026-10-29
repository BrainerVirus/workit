// Remote URLs and the workspace entries that claim them (#549). Grants follow
// the folder; an entry's optional `remotes` makes them follow the remote too:
// a checkout whose remotes an entry claims never exceeds that entry's grants
// (autonomy.ts resolveAutonomy). Patterns and URLs compare normalized: the
// ssh, scp-like and https forms of one host/owner/repo are equal, the host
// and a forge path compare case-insensitively, a trailing `.git` is ignored,
// and a pattern ending in `/*` claims everything under that owner or group.
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FORGE_SCHEMES = new Set(["ssh", "git", "http", "https", "git+ssh", "ssh+git"]);
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const SCP_LIKE = /^(?:[^@/\\]+@)?([^/\\:]+):(.+)$/u;

const trimRepo = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .replace(/\/\.git$/u, "")
    .replace(/\.git$/u, "");

const forgeKey = (host: string, repo: string): string | null => {
  const clean = trimRepo(repo.replace(/^\/+/u, "").replace(/^~[^/]*\//u, ""))
    .split("/")
    .filter(Boolean)
    .join("/");
  return host && clean ? `${host.toLowerCase()}/${clean.toLowerCase()}` : null;
};

const fileKey = (where: string): string => {
  let real = path.resolve(where);
  try {
    real = (realpathSync.native ?? realpathSync)(real);
  } catch {
    // A path that does not exist (yet) compares as written.
  }
  return `file:${trimRepo(real)}`;
};

/**
 * The normalized key of a remote URL, or null when it cannot be read. `base`
 * resolves a relative local path (git reads it from the checkout's top);
 * without one (a pattern), a bare `host/owner/repo` reads as https.
 */
export const remoteKey = (url: string, base?: string): string | null => {
  const value = url.trim();
  // `<transport>::<address>` runs a remote helper: no URL to compare.
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*::/u.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
  if (scheme === "file") {
    try {
      return fileKey(decodeURIComponent(new URL(value).pathname));
    } catch {
      return null;
    }
  }
  if (scheme) {
    if (!FORGE_SCHEMES.has(scheme)) return null;
    try {
      const parsed = new URL(value);
      return forgeKey(parsed.hostname, decodeURIComponent(parsed.pathname));
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(value) || WINDOWS_DRIVE.test(value)) return fileKey(value);
  const scp = SCP_LIKE.exec(value);
  if (scp) return forgeKey(scp[1], scp[2]);
  if (base !== undefined) return fileKey(path.resolve(base, value));
  const slash = value.indexOf("/");
  return slash > 0 ? forgeKey(value.slice(0, slash), value.slice(slash)) : null;
};

/** A `remotes` pattern: its key and whether it claims a whole owner (`/*`). */
export const remotePattern = (pattern: string): { key: string; owner: boolean } | null => {
  const trimmed = pattern.trim();
  const owner = trimmed.endsWith("/*");
  const key = remoteKey(owner ? trimmed.slice(0, -2) : trimmed);
  return key ? { key, owner } : null;
};

/** Whether `pattern` claims the remote whose key is `key`. */
export const remoteMatches = (pattern: string, key: string): boolean => {
  const parsed = remotePattern(pattern);
  if (!parsed) return false;
  return parsed.owner ? key.startsWith(`${parsed.key}/`) : key === parsed.key;
};

/** A local path relative to the checkout (git reads it from the top). */
const isRelative = (url: string): boolean =>
  !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(url) &&
  !path.isAbsolute(url) &&
  !WINDOWS_DRIVE.test(url) &&
  !SCP_LIKE.test(url);

export type CheckoutRemote = { name: string; url: string; key: string };

/**
 * Every fetch and push URL of the checkout at `cwd`, as git resolves them
 * (`insteadOf` and `pushurl` applied); [] outside a repository. An Error when
 * git did not answer or a URL cannot be read: callers fail closed.
 */
export const checkoutRemotes = (cwd: string): CheckoutRemote[] | Error => {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[name];
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
  const listed = git(["remote", "-v"]);
  if (listed.status !== 0) {
    if (/not a git repository/iu.test(listed.stderr ?? "")) return [];
    return Error(`git could not list the remotes of ${cwd}`);
  }
  let top: string | undefined;
  const base = (): string => {
    if (top === undefined) {
      const run = git(["rev-parse", "--show-toplevel"]);
      top = run.status === 0 && run.stdout.trim() ? run.stdout.trim() : cwd;
    }
    return top;
  };
  const out: CheckoutRemote[] = [];
  for (const line of listed.stdout.split(/\r?\n/u)) {
    const match = /^([^\t]+)\t(.*) \((?:fetch|push)\)$/u.exec(line);
    if (!match) continue;
    const [, name, url] = match;
    const key = remoteKey(url, isRelative(url) ? base() : undefined);
    if (key === null) return Error(`remote ${name} of ${cwd} has a URL workit cannot read: ${url}`);
    if (!out.some((item) => item.key === key)) out.push({ name, url, key });
  }
  return out;
};

/**
 * What a grant-gated action targets (#549 forks): the push URLs of the remote
 * a push goes to, or the forge repository a PR, merge or rerun acts on. Only
 * these are matched against `remotes`; an Error (unresolvable target) grants
 * nothing. Without a target, every remote of the checkout counts.
 */
export type GrantTarget = { remotes: CheckoutRemote[] } | Error;

/** Every push URL of `remote` (`pushurl` and `pushInsteadOf` applied). */
export const pushTarget = (cwd: string, remote: string): GrantTarget => {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[name];
  if (!remote || remote.startsWith("-"))
    return Error(`push remote ${JSON.stringify(remote)} cannot be resolved`);
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  const run = git(["remote", "get-url", "--push", "--all", remote]);
  const urls = run.status === 0 ? run.stdout.split(/\r?\n/u).map((url) => url.trim()) : [];
  if (!urls.some(Boolean))
    return Error(`git could not resolve the push URLs of remote ${remote} in ${cwd}`);
  let top: string | undefined;
  const base = (): string => {
    if (top === undefined) {
      const at = git(["rev-parse", "--show-toplevel"]);
      top = at.status === 0 && at.stdout.trim() ? at.stdout.trim() : cwd;
    }
    return top;
  };
  const remotes: CheckoutRemote[] = [];
  for (const url of urls.filter(Boolean)) {
    const key = remoteKey(url, isRelative(url) ? base() : undefined);
    if (key === null) return Error(`remote ${remote} has a push URL workit cannot read: ${url}`);
    remotes.push({ name: remote, url, key });
  }
  return { remotes };
};

/** The forge repository a PR, merge or CI rerun acts on, as its https URL. */
export const forgeTarget = (host: string, repo: string): GrantTarget => {
  const url = `https://${host}/${repo}`;
  const key = host && repo ? remoteKey(url) : null;
  return key === null
    ? Error(`the forge repository ${JSON.stringify(repo)} on ${host} cannot be resolved`)
    : { remotes: [{ name: "forge", url, key }] };
};
