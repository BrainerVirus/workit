// Pure git revision and push-target helpers for the CLI verbs (design §2.0,
// §2.2; D16). Plain TS on top of the git binary: no task store, no config
// reads, no zod, so any verb can import this without paying for the engine.
//
// - headSha / worktreeTree / mergeBase / patchId / remoteTip key evidence and
//   verdicts to code state (fresh = same tree, carried = same patch-id).
// - pushRemoteName / pushUrl / deriveForge / pushForge derive the forge from
//   the PUSH remote host, honoring ~/.ssh/config Host aliases, instead of the
//   configured provider (design §0 #6). forgeConflict turns a disagreement
//   with the workspace provider into a `blocked` result with an unblock hint.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;

type GitRun = { ok: boolean; stdout: string; stderr: string };

const git = (
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): GitRun => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const line = (run: GitRun): string | null => {
  if (!run.ok) return null;
  const value = run.stdout.trim();
  return value ? value : null;
};

// A ref or remote argument must never be read as an option by git.
const safeArg = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/** The commit HEAD points at, or null (unborn HEAD, not a repository). */
export function headSha(cwd: string): string | null {
  return line(git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]));
}

const emptyTree = (cwd: string): string | null => line(git(cwd, ["mktree"], { input: "" }));

/**
 * The tree the worktree would commit right now, including unstaged and
 * untracked (non-ignored) files. Built in a throwaway index
 * (GIT_INDEX_FILE + `git add -A` + `git write-tree`), so the real index, HEAD
 * and every ref stay untouched. `dirty` is true when that tree differs from
 * HEAD's tree (or from the empty tree on an unborn branch).
 */
export function worktreeTree(cwd: string): { tree: string; dirty: boolean } | null {
  const top = line(git(cwd, ["rev-parse", "--show-toplevel"]));
  const indexPath = line(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  if (!top || !indexPath) return null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workit-tree-"));
  try {
    const tempIndex = path.join(scratch, "index");
    // Seeding from the real index keeps git's stat cache, so `add -A` only
    // rehashes files that actually changed.
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tempIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    if (!git(top, ["add", "-A"], { env }).ok) return null;
    const tree = line(git(top, ["write-tree"], { env }));
    if (!tree) return null;
    const base = line(git(top, ["rev-parse", "--verify", "-q", "HEAD^{tree}"])) ?? emptyTree(top);
    return { tree, dirty: tree !== base };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The best common ancestor of two revisions, or null. */
export function mergeBase(cwd: string, a: string, b: string): string | null {
  if (!safeArg(a) || !safeArg(b)) return null;
  return line(git(cwd, ["merge-base", a, b]));
}

/**
 * The stable patch-id of `merge-base(base, head)..head`: equal before and
 * after a rebase that only moved the base, different once the change itself
 * differs. Null when the range is empty or a revision does not resolve. Diff
 * options are pinned so user config (renames, prefixes, external diff) cannot
 * change the id between machines.
 */
export function patchId(cwd: string, base: string, head: string): string | null {
  if (!safeArg(base) || !safeArg(head)) return null;
  const diff = git(cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${base}...${head}`,
    "--",
  ]);
  if (!diff.ok || !diff.stdout.trim()) return null;
  const id = git(cwd, ["patch-id", "--stable"], { input: diff.stdout });
  return line(id)?.split(/\s+/u)[0] ?? null;
}

/** The commit a remote branch points at (`git ls-remote`), or null. */
export function remoteTip(cwd: string, remote: string, branch: string): string | null {
  if (!safeArg(remote) || !safeArg(branch)) return null;
  const ref = `refs/heads/${branch}`;
  const listed = git(cwd, ["ls-remote", remote, ref]);
  if (!listed.ok) return null;
  for (const row of listed.stdout.split(/\r?\n/u)) {
    const [sha, name] = row.split(/\s+/u);
    if (name === ref && sha) return sha;
  }
  return null;
}

const config = (cwd: string, key: string): string | null =>
  line(git(cwd, ["config", "--get", key]));

/** The current branch name (also on an unborn branch), or null when detached. */
export function currentBranch(cwd: string): string | null {
  return line(git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]));
}

/**
 * The remote `git push` would use for `branch` (default: the current branch),
 * in git's own precedence: branch.<b>.pushRemote, remote.pushDefault,
 * branch.<b>.remote, then `origin`, then the only remote. Null when none.
 */
export function pushRemoteName(cwd: string, branch?: string | null): string | null {
  const name = branch ?? currentBranch(cwd);
  const remotes = (git(cwd, ["remote"]).stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = [
    name ? config(cwd, `branch.${name}.pushRemote`) : null,
    config(cwd, "remote.pushDefault"),
    name ? config(cwd, `branch.${name}.remote`) : null,
  ];
  for (const candidate of candidates)
    if (candidate && candidate !== "." && remotes.includes(candidate)) return candidate;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/**
 * The single push URL of `remote` after git's insteadOf/pushInsteadOf
 * rewrites. Null when the remote is missing or pushes to several URLs (the
 * target would be ambiguous).
 */
export function pushUrl(cwd: string, remote: string): string | null {
  if (!safeArg(remote)) return null;
  const urls = git(cwd, ["remote", "get-url", "--push", "--all", remote])
    .stdout.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return urls.length === 1 ? urls[0] : null;
}

export type RemoteUrl = {
  protocol: "ssh" | "https" | "http" | "git" | "file";
  user: string | null;
  /** Host as written in the URL (an SSH alias stays unresolved here). */
  host: string;
  port: string | null;
  /** Repository path without leading slash, trailing slash or `.git`. */
  path: string;
};

const cleanPath = (value: string): string =>
  value
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");

/** Parse a git remote URL (scp-like `user@host:path` or URL syntax). */
export function parseRemoteUrl(raw: string): RemoteUrl | null {
  const value = raw.trim();
  if (!value) return null;
  // Local paths, including Windows drive paths that look scp-like (C:\repo).
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith(".")) {
    return { protocol: "file", user: null, host: "", port: null, path: value };
  }
  if (!value.includes("://")) {
    const scp = /^(?:([^@\s/]+)@)?([^:/\s]+):(.+)$/u.exec(value);
    if (!scp) return null;
    return {
      protocol: "ssh",
      user: scp[1] ?? null,
      host: scp[2].toLowerCase(),
      port: null,
      path: cleanPath(scp[3]),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/u, "");
  const protocol =
    scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git"
      ? "ssh"
      : scheme === "https" || scheme === "http" || scheme === "git" || scheme === "file"
        ? scheme
        : null;
  if (!protocol) return null;
  return {
    protocol,
    // Never keep an HTTPS credential; an SSH user is part of the identity.
    user: protocol === "ssh" && url.username ? decodeURIComponent(url.username) : null,
    host: url.hostname.toLowerCase().replace(/\.$/u, ""),
    port: url.port || null,
    path: cleanPath(decodeURIComponent(url.pathname)),
  };
}

// ---------------------------------------------------------------------------
// ~/.ssh/config Host alias resolution (enough of ssh_config(5) for HostName
// and Port: first value wins, Host patterns with * ? and !negation, Include
// expanded in place). `Match` blocks are skipped: they are conditional on
// runtime state that a static read cannot evaluate.

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("")
      .map((char) =>
        char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/gu, "\\$&"),
      )
      .join("")}$`,
    "iu",
  );

const hostMatches = (patterns: string[], host: string): boolean => {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(host)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
};

const tokens = (rest: string): string[] =>
  [...rest.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]);

type SshDirective = { key: string; args: string[] };

const directives = (text: string): SshDirective[] =>
  text.split(/\r?\n/u).flatMap((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/u.exec(trimmed);
    if (!match) return [];
    return [{ key: match[1].toLowerCase(), args: tokens(match[2]) }];
  });

/**
 * Read the user's SSH client config with `Include` expanded in place
 * (relative includes resolve against ~/.ssh; a `*`/`?` glob is allowed in the
 * last path segment). Missing or unreadable files read as empty.
 */
export function readSshConfig(home: string = os.homedir()): string {
  const sshDir = path.join(home, ".ssh");
  const read = (file: string, depth: number): string => {
    if (depth > 16) return "";
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
    return text
      .split(/\r?\n/u)
      .map((raw) => {
        const match = /^\s*include(?:\s*=\s*|\s+)(.*)$/iu.exec(raw);
        if (!match) return raw;
        return tokens(match[1])
          .flatMap((entry) => {
            const expanded = entry.startsWith("~") ? path.join(home, entry.slice(1)) : entry;
            const absolute = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);
            const dir = path.dirname(absolute);
            const base = path.basename(absolute);
            if (!/[*?]/u.test(base)) return [absolute];
            try {
              const pattern = globToRegExp(base);
              return fs
                .readdirSync(dir)
                .filter((name) => pattern.test(name))
                .toSorted()
                .map((name) => path.join(dir, name));
            } catch {
              return [];
            }
          })
          .map((included) => read(included, depth + 1))
          .join("\n");
      })
      .join("\n");
  };
  return read(path.join(sshDir, "config"), 0);
}

/**
 * Resolve an SSH host alias against an ssh_config text: the effective
 * HostName (with %h / %% expanded) and Port. An alias with no HostName
 * resolves to itself.
 */
export function resolveSshHost(
  alias: string,
  sshConfig: string,
): { hostname: string; port: string | null } {
  let active = true;
  let hostname: string | null = null;
  let port: string | null = null;
  for (const { key, args } of directives(sshConfig)) {
    if (key === "host") {
      active = hostMatches(args, alias);
      continue;
    }
    if (key === "match") {
      active = false;
      continue;
    }
    if (!active || args.length === 0) continue;
    if (key === "hostname" && hostname === null)
      hostname = args[0].replace(/%(%|h)/gu, (_, token: string) => (token === "h" ? alias : "%"));
    if (key === "port" && port === null) port = args[0];
  }
  return {
    hostname: (hostname ?? alias).toLowerCase().replace(/\.$/u, ""),
    port,
  };
}

// ---------------------------------------------------------------------------
// Forge derivation (D16): the push remote host decides github vs gitlab.

export type ForgeKind = "github" | "gitlab";

/** Self-hosted / enterprise hosts known from vcs config (`github.host`, `gitlab.host`). */
export type ForgeHosts = { github?: readonly string[]; gitlab?: readonly string[] };

export type DerivedForge = {
  kind: ForgeKind;
  /** Host as written in the remote URL (may be an SSH alias). */
  host: string;
  /** Host after SSH alias resolution. */
  hostname: string;
  /** Host the gh/glab API calls must target (GH_HOST / GITLAB_HOST). */
  apiHost: string;
  /** owner/name (GitHub) or group[/subgroup]/project (GitLab). */
  repo: string;
  /** How the kind was decided. */
  via: "known_host" | "configured_host" | "host_name";
};

// Public forges and their SSH-over-443 endpoints.
const KNOWN_HOSTS: Record<string, { kind: ForgeKind; apiHost: string }> = {
  "github.com": { kind: "github", apiHost: "github.com" },
  "ssh.github.com": { kind: "github", apiHost: "github.com" },
  "gitlab.com": { kind: "gitlab", apiHost: "gitlab.com" },
  "altssh.gitlab.com": { kind: "gitlab", apiHost: "gitlab.com" },
};

const normalizeHost = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/\/.*$/u, "")
    .replace(/\.$/u, "");

/**
 * Derive the forge from a remote URL. SSH aliases resolve through `sshConfig`
 * (default: the user's ~/.ssh/config), so `git@github-work.com:org/repo` with
 * `Host github-work.com / HostName github.com` is GitHub at github.com.
 * Configured enterprise hosts win next; finally a host whose first label is
 * exactly `github` or `gitlab` (gitlab.example.com) is taken at face value.
 * Null when the host is unknown or the path has no owner/name.
 */
export function deriveForge(
  url: string,
  options: { hosts?: ForgeHosts; sshConfig?: string } = {},
): DerivedForge | null {
  const parsed = parseRemoteUrl(url);
  if (!parsed || parsed.protocol === "file" || !parsed.host) return null;
  const segments = parsed.path.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const hostname =
    parsed.protocol === "ssh"
      ? resolveSshHost(parsed.host, options.sshConfig ?? readSshConfig()).hostname
      : parsed.host;
  const withPort =
    parsed.protocol !== "ssh" && parsed.port ? `${hostname}:${parsed.port}` : hostname;
  const base = { host: parsed.host, hostname, repo: segments.join("/") };
  const known = KNOWN_HOSTS[hostname];
  if (known) {
    if (known.kind === "github" && segments.length !== 2) return null;
    return { ...base, kind: known.kind, apiHost: known.apiHost, via: "known_host" };
  }
  for (const kind of ["github", "gitlab"] as const) {
    const hosts = new Set((options.hosts?.[kind] ?? []).map(normalizeHost));
    if (hosts.has(withPort) || hosts.has(hostname)) {
      const apiHost = hosts.has(withPort) ? withPort : hostname;
      return { ...base, kind, apiHost, via: "configured_host" };
    }
  }
  const label = hostname.split(".")[0];
  if ((label === "github" || label === "gitlab") && hostname.includes("."))
    return { ...base, kind: label, apiHost: withPort, via: "host_name" };
  return null;
}

export type PushForgeResult =
  | { ok: true; remote: string; url: string; forge: DerivedForge }
  | { ok: false; code: "not_found" | "unavailable"; error: string; unblock: string };

/**
 * The forge behind the current branch's push remote. Fails closed with an
 * unblock hint when there is no push remote, the push URL is ambiguous, or
 * the host is not a recognizable GitHub/GitLab.
 */
export function pushForge(
  cwd: string,
  options: { branch?: string | null; hosts?: ForgeHosts; sshConfig?: string } = {},
): PushForgeResult {
  const remote = pushRemoteName(cwd, options.branch);
  if (!remote)
    return {
      ok: false,
      code: "not_found",
      error: "no push remote is configured for this branch",
      unblock: "git remote add origin <url>",
    };
  const url = pushUrl(cwd, remote);
  if (!url)
    return {
      ok: false,
      code: "unavailable",
      error: `remote "${remote}" has no single push URL`,
      unblock: `git remote get-url --push --all ${remote}  # keep exactly one push URL`,
    };
  const forge = deriveForge(url, options);
  if (!forge) {
    const host = parseRemoteUrl(url)?.host ?? url;
    return {
      ok: false,
      code: "unavailable",
      error: `cannot tell whether push host "${host}" is GitHub or GitLab`,
      unblock: `map the alias in ~/.ssh/config (Host ${host} / HostName github.com|gitlab.com) or set github.host / gitlab.host in ~/.config/workit/vcs.json`,
    };
  }
  return { ok: true, remote, url, forge };
}

/**
 * D16: the push remote decides. A configured provider that disagrees is not
 * silently overridden; it is `blocked` with the exact fix.
 */
export function forgeConflict(
  derived: DerivedForge,
  configuredProvider: string | null | undefined,
): { code: "blocked"; error: string; unblock: string } | null {
  const configured = configuredProvider?.trim().toLowerCase();
  if (!configured || configured === derived.kind) return null;
  return {
    code: "blocked",
    error: `forge_mismatch: push remote ${derived.host} is ${derived.kind} but the workspace vcs.provider is ${configured}`,
    unblock: `set vcs.provider to "${derived.kind}" for this repo in ~/.config/workit/workspaces.json (workit-github-override), or push to a ${configured} remote`,
  };
}
