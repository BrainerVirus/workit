// Remote URLs and the workspace entries that claim them (#549). Grants follow
// the folder; an entry's optional `remotes` makes them follow the remote too:
// a checkout whose remotes an entry claims never exceeds that entry's grants
// (autonomy.ts resolveAutonomy). Patterns and URLs compare normalized: the
// ssh, scp-like and https forms of one host/owner/repo are equal, the host
// and a forge path compare case-insensitively, a trailing `.git` is ignored,
// and a pattern ending in `/*` claims everything under that owner or group.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readSshConfig, resolveSshHost, type SshConfig } from "../git/rev";

const FORGE_SCHEMES = new Set(["ssh", "git", "http", "https", "git+ssh", "ssh+git"]);
const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"]);
const SSH_443: Record<string, string> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
};
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const SCP_LIKE = /^(?:[^@/\\]+@)?([^/\\:]+):(.+)$/u;

const accountHome = (): string => {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
};

/**
 * The ssh_config aliases resolve through, as deriveForge resolves them: the
 * account's own ~/.ssh/config (ssh reads the passwd home, never $HOME). Tests
 * swap `read` in-process.
 */
export const sshSeam: { read: () => SshConfig } = { read: () => readSshConfig(accountHome()) };

/**
 * `host/owner/repo`, lowercased, or null when the path is not a plain forge
 * path: a `~user` home path, `.` or `..` segments, or a doubled `.git`.
 */
const forgeKey = (rawHost: string, repo: string, ssh: boolean): string | null => {
  let host = rawHost.toLowerCase().replace(/\.$/u, "");
  if (ssh && host) host = resolveSshHost(host, sshSeam.read()).hostname.toLowerCase();
  host = host.replace(/\.$/u, "");
  // deriveForge's SSH-over-443 endpoints are the same forge.
  host = SSH_443[host] ?? host;
  const trimmed = repo.replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (trimmed.startsWith("~")) return null;
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((part) => part === "." || part === "..")) return null;
  const last = segments.length - 1;
  if (last >= 0) {
    segments[last] = segments[last].replace(/\.git$/iu, "");
    if (/\.git$/iu.test(segments[last]) || !segments[last]) return null;
  }
  const clean = segments.join("/");
  return host && clean ? `${host}/${clean.toLowerCase()}` : null;
};

const caseless = process.platform === "win32" || process.platform === "darwin";
const canonical = (real: string): string => {
  const slashed = real
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .replace(/\/\.git$/u, "");
  return `file:${caseless ? slashed.toLowerCase() : slashed}`;
};

/** The real path of a git directory at `at` (a repository, or a `gitdir:` file), else null. */
const gitDirAt = (at: string): string | null => {
  let real: string;
  try {
    // libc realpath: symlinks are followed before `..`, as the kernel does.
    real = realpathSync.native(at);
  } catch {
    return null;
  }
  try {
    if (statSync(real).isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(real, "utf8"))?.[1];
      if (!pointer) return null;
      const target = path.isAbsolute(pointer) ? pointer : `${path.dirname(real)}/${pointer}`;
      return gitDirAt(target);
    }
    const isRepo = ["HEAD", "objects", "refs"].every((name) => {
      try {
        lstatSync(`${real}/${name}`);
        return true;
      } catch {
        return false;
      }
    });
    return isRepo ? real : null;
  } catch {
    return null;
  }
};

/**
 * The repository git reaches for the local path `where` (git's own DWIM:
 * `X/.git`, `X`, `X.git/.git`, `X.git`), never normalized before symlinks
 * are followed; null when none is a repository.
 */
const localRepo = (where: string): string | null => {
  const bare = where.replace(/[\\/]+$/u, "");
  for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
    const found = gitDirAt(`${bare}${suffix}`);
    if (found) return found;
  }
  return null;
};

/**
 * A local remote's key. A target (`strict`) must resolve to a repository, or
 * it is unknown (null); a pattern that names no repository yet compares as
 * written, so it can be saved before the repository exists.
 */
const fileKey = (where: string, strict: boolean): string | null => {
  const repo = localRepo(where);
  if (repo) return canonical(repo);
  return strict ? null : canonical(path.resolve(where).replace(/\.git$/u, ""));
};

/**
 * The normalized key of a remote URL, or null when it cannot be read. `base`
 * marks a target (what an action reaches): a relative local path resolves
 * against it (the checkout's top, as git does) and a local path must name a
 * repository. Without one (a pattern), a bare `host/owner/repo` reads as https.
 */
export const remoteKey = (url: string, base?: string | (() => string)): string | null => {
  const value = url.trim();
  const strict = base !== undefined;
  // `<transport>::<address>` runs a remote helper: no URL to compare.
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*::/u.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
  if (scheme === "file") {
    // Parsed as text: URL would collapse `..` before the filesystem follows
    // a symlink, which is not what git reaches.
    const rest = value.slice(value.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);
    if (slash < 0 || (host && host.toLowerCase() !== "localhost")) return null;
    let local: string;
    try {
      local = decodeURIComponent(rest.slice(slash));
    } catch {
      return null;
    }
    return fileKey(
      process.platform === "win32" ? local.replace(/^\/(?=[A-Za-z]:)/u, "") : local,
      strict,
    );
  }
  if (scheme) {
    if (!FORGE_SCHEMES.has(scheme)) return null;
    // URL would collapse dot segments (also encoded ones): not a plain path.
    const raw = value.slice(value.indexOf("://") + 3);
    if (/(?:^|\/)\.{1,2}(?:\/|$)|%2e/iu.test(raw)) return null;
    try {
      const parsed = new URL(value);
      return forgeKey(
        parsed.hostname,
        decodeURIComponent(parsed.pathname),
        SSH_SCHEMES.has(scheme),
      );
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(value) || WINDOWS_DRIVE.test(value)) return fileKey(value, strict);
  const scp = SCP_LIKE.exec(value);
  if (scp) return forgeKey(scp[1], scp[2], true);
  // Joined as text: `..` after a symlink is resolved by the filesystem.
  if (strict) return fileKey(`${typeof base === "function" ? base() : base}/${value}`, true);
  const slash = value.indexOf("/");
  return slash > 0 ? forgeKey(value.slice(0, slash), value.slice(slash), false) : null;
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
    const key = remoteKey(url, base);
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
/** A target, or how to resolve it: resolved only when some workspace claims remotes. */
export type LazyTarget = GrantTarget | (() => GrantTarget);

const TRANSPORT_ENV = ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND"];

/** Whose home counts as the user's own git config; tests swap `home`. */
export const userGitSeam = { home: accountHome };

const realOrSelf = (file: string): string => {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * The user's own config: the account home's ~/.gitconfig or
 * ~/.config/git/config (never one $HOME, XDG_CONFIG_HOME or GIT_CONFIG_GLOBAL
 * points elsewhere: any shell sets those), or the system file while
 * GIT_CONFIG_SYSTEM does not redirect it.
 */
const userLevel = (scope: string, origin: string): boolean => {
  if (scope === "system") return process.env.GIT_CONFIG_SYSTEM === undefined;
  if (scope !== "global" || !origin.startsWith("file:")) return false;
  const file = realOrSelf(origin.slice("file:".length));
  const home = userGitSeam.home();
  return [path.join(home, ".gitconfig"), path.join(home, ".config", "git", "config")]
    .map(realOrSelf)
    .includes(file);
};
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * What makes a push reach something other than its URL says: the remote's
 * `receivepack` or `vcs` (any source), `core.gitProxy`, `core.sshCommand`
 * outside the user's global or system config (repo, worktree, include,
 * `-c`, GIT_CONFIG_*), or GIT_SSH, GIT_SSH_COMMAND or GIT_PROXY_COMMAND in
 * the environment. A global `core.sshCommand` is the user's own setup: an
 * agent writing ~/.gitconfig is outside its worktree. Null when none is set.
 */
const transportOverride = (
  git: (args: string[]) => ReturnType<typeof spawnSync>,
  remote: string,
): string | null => {
  const env = TRANSPORT_ENV.find((name) => process.env[name]);
  if (env) return env;
  // GIT_EXEC_PATH can swap the git-receive-pack a local push runs. git sets it
  // for its own hooks, so only a value other than git's own exec path counts.
  const execPath = process.env.GIT_EXEC_PATH;
  if (execPath) {
    const { GIT_EXEC_PATH: _set, ...rest } = process.env;
    const own = spawnSync("git", ["--exec-path"], { env: rest, encoding: "utf8" });
    if (own.status !== 0 || realOrSelf(own.stdout.trim()) !== realOrSelf(execPath))
      return "GIT_EXEC_PATH";
  }
  // The subsection keeps its case in git's canonical key.
  const name = escapeRegex(remote);
  const run = git([
    "config",
    "--show-scope",
    "--show-origin",
    "--get-regexp",
    `^(remote\\.${name}\\.(receivepack|vcs)|core\\.(sshcommand|gitproxy))$`,
  ]);
  // 1: none set. Anything else but success: unknown.
  if (run.status === 1) return null;
  if (run.status !== 0) return "a git config that cannot be read";
  for (const line of String(run.stdout).split(/\r?\n/u)) {
    const match = /^(\S+)\t(.*?)\t(\S+)(?: |$)/u.exec(line);
    if (!match) continue;
    const [, scope, origin, key] = match;
    if (key === "core.sshcommand" && userLevel(scope, origin)) continue;
    return `${key} (${scope} ${origin})`;
  }
  return null;
};

/** Every push URL of `remote` (`pushurl` and `pushInsteadOf` applied). */
export const pushTarget = (cwd: string, remote: string): GrantTarget => {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete env[name];
  if (!remote || remote.startsWith("-"))
    return Error(`push remote ${JSON.stringify(remote)} cannot be resolved`);
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5000, windowsHide: true });
  const override = transportOverride(git, remote);
  if (override)
    return Error(
      `${override} decides what the push to ${remote} reaches, not its URL, so its target is unknown`,
    );
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
    const key = remoteKey(url, base);
    if (key === null)
      return Error(
        `remote ${remote} has a push URL that names no repository workit can read: ${url}`,
      );
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
