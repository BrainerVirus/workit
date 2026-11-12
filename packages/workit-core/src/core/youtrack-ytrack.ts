// The `ytrack` executable (BrainerVirus/youtrack-cli, #263): found on PATH,
// run without a shell, never handed a token (it keeps its own in the OS
// keyring). Workit reaches YouTrack only through it.
import { spawnSync } from "node:child_process";
import { findExecutable } from "../forge/exec";

export type YtrackResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  missing?: boolean;
};
export type YtrackRun = (args: string[], input?: string) => YtrackResult;

const TIMEOUT_MS = 60_000;

/** ytrack's exit codes: 0 ok, 1 failure, 2 cancelled, 4 authentication required. */
export const YTRACK_EXIT = { ok: 0, failed: 1, cancelled: 2, auth: 4 } as const;

/**
 * ytrack on `env`'s PATH, unless `WORKIT_NO_YTRACK=1`. The test preload
 * (test/shared/state-isolation.ts) sets it for the whole run: a developer's
 * real ytrack is logged in to a real instance (maybe the work one), so a test
 * reaches ytrack only through a stub PATH in an env it builds itself.
 */
export const findYtrack = (env: NodeJS.ProcessEnv): string | null =>
  env.WORKIT_NO_YTRACK === "1" ? null : findExecutable("ytrack", env);

/**
 * Run ytrack from `env`'s PATH. `host` (youtrack.json's baseUrl, when set)
 * goes in YTRACK_HOST so ytrack talks to the instance Workit is configured
 * for; Workit adds no token to argv or env.
 */
export function ytrackRunner(
  env: NodeJS.ProcessEnv,
  host?: string | null,
  timeoutMs: number = TIMEOUT_MS,
): YtrackRun {
  return (args, input) => {
    const exe = findYtrack(env);
    if (!exe) return { status: null, stdout: "", stderr: "", missing: true };
    const result = spawnSync(exe, args, {
      encoding: "utf8",
      env: { ...env, NO_COLOR: "1", ...(host ? { YTRACK_HOST: host } : {}) },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      ...(input === undefined
        ? { stdio: ["ignore", "pipe", "pipe"] as const }
        : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
    });
    const error: NodeJS.ErrnoException | undefined = result.error;
    if (error?.code === "ENOENT") return { status: null, stdout: "", stderr: "", missing: true };
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr || (error ? error.message : ""),
    };
  };
}

/** The last lines of ytrack's stderr, for an error message. */
export const ytrackDetail = (out: YtrackResult): string =>
  out.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);

export type YtrackHostStatus = {
  host: string;
  active: boolean;
  login: string | null;
  state: string;
  tokenSource: string | null;
  error: string | null;
};
export type YtrackStatus =
  | { installed: false }
  | {
      installed: true;
      version: string | null;
      /** ok: the active host accepted the token; logged_out: exit 4 or no host. */
      auth: YtrackAuth;
      hosts: YtrackHostStatus[];
      error: string | null;
    };

const STATUS_FIELDS = "host,active,login,state,tokenSource,error";

/** ytrack's version and auth state, for `workit doctor`. Never prints a token. */
export function ytrackStatus(run: YtrackRun): YtrackStatus {
  const version = run(["version"]);
  if (version.missing) return { installed: false };
  const match = /ytrack version (\S+)/u.exec(version.stdout);
  const status = run(["auth", "status", "--json", STATUS_FIELDS]);
  const base = { installed: true as const, version: match ? match[1] : null };
  if (status.status === YTRACK_EXIT.auth)
    return { ...base, auth: "logged_out", hosts: [], error: ytrackDetail(status) || null };
  let rows: unknown;
  try {
    rows = JSON.parse(status.stdout);
  } catch {
    return { ...base, auth: "error", hosts: [], error: ytrackDetail(status) || "no JSON" };
  }
  const hosts = (Array.isArray(rows) ? rows : [rows])
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      host: String(row.host ?? ""),
      active: row.active === true,
      login: typeof row.login === "string" && row.login ? row.login : null,
      state: String(row.state ?? "error"),
      tokenSource: typeof row.tokenSource === "string" && row.tokenSource ? row.tokenSource : null,
      error: typeof row.error === "string" && row.error ? row.error : null,
    }));
  const active = hosts.find((row) => row.active) ?? hosts[0];
  return { ...base, auth: rowAuth(active), hosts, error: null };
}

type YtrackAuth = "ok" | "logged_out" | "rejected" | "error";

const rowAuth = (row: YtrackHostStatus | undefined): YtrackAuth =>
  !row
    ? "logged_out"
    : row.state === "ok"
      ? "ok"
      : row.state === "rejected"
        ? "rejected"
        : row.state === "no_token"
          ? "logged_out"
          : "error";

/**
 * A YouTrack URL or host as ytrack names it (`ytrack auth login --host`):
 * the URL's host, lower case, without scheme, path or trailing slash.
 */
export const ytrackHostName = (urlOrHost: string): string =>
  urlOrHost
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")
    .split("/")[0]
    .toLowerCase();

/**
 * The auth state ytrack reports for `host` (a youtrack.json or workspace
 * baseUrl); with no host, the active one's. A host ytrack has no login for is
 * logged_out.
 */
export function ytrackHostAuth(
  status: Extract<YtrackStatus, { installed: true }>,
  host: string | null,
): { auth: YtrackAuth; login: string | null; error: string | null } {
  if (!host) {
    const active = status.hosts.find((row) => row.active) ?? status.hosts[0];
    return {
      auth: status.auth,
      login: active?.login ?? null,
      error: active?.error ?? status.error,
    };
  }
  const name = ytrackHostName(host);
  const row = status.hosts.find((candidate) => ytrackHostName(candidate.host) === name);
  return {
    auth: status.auth === "error" && !row ? "error" : rowAuth(row),
    login: row?.login ?? null,
    error: row?.error ?? status.error,
  };
}

/** Where ytrack comes from: Workit reaches YouTrack only through it. */
export const YTRACK_INSTALL =
  "install ytrack (https://github.com/BrainerVirus/youtrack-cli: install.sh, or install.ps1 on Windows)";

/** `ytrack auth login`, aimed at `host` (a URL or host name) when one is known. */
export const ytrackLogin = (host?: string | null): string =>
  `ytrack auth login${host ? ` --host ${ytrackHostName(host)}` : ""}`;

/** The unblock for a missing ytrack: install it, then log in to `host`. */
export const ytrackMissingUnblock = (host?: string | null): string =>
  `${YTRACK_INSTALL}, then ${ytrackLogin(host)}`;

export const YTRACK_MISSING = "ytrack is not on PATH: Workit reaches YouTrack only through ytrack";

export type YtrackReadiness =
  | { ok: true; version: string | null; login: string | null }
  | {
      ok: false;
      reason: "missing" | "logged_out" | "rejected" | "error";
      error: string;
      unblock: string;
    };

/**
 * Whether ytrack can reach `host` (youtrack.json's baseUrl; null for its
 * active host): installed and logged in, else the reason and the one command
 * that unblocks it. Never reads or prints a token.
 */
export function ytrackReadiness(run: YtrackRun, host: string | null): YtrackReadiness {
  const status = ytrackStatus(run);
  if (!status.installed)
    return {
      ok: false,
      reason: "missing",
      error: YTRACK_MISSING,
      unblock: ytrackMissingUnblock(host),
    };
  const auth = ytrackHostAuth(status, host);
  const where = host ? ytrackHostName(host) : "the active host";
  if (auth.auth === "ok") return { ok: true, version: status.version, login: auth.login };
  return {
    ok: false,
    reason: auth.auth,
    error:
      auth.auth === "logged_out"
        ? `ytrack is not logged in to ${where}`
        : auth.auth === "rejected"
          ? `${where} rejected ytrack's stored token`
          : `could not read ytrack's login for ${where}${auth.error ? ` (${auth.error})` : ""}`,
    unblock: ytrackLogin(host),
  };
}

/** What a newer ytrack adds: `issue comment --attach`, `issue attach`, `auth paths`. */
export type YtrackFeature = "comment-attach" | "issue-attach" | "auth-paths";

const FEATURE_PROBE: Record<YtrackFeature, { args: string[]; shows: RegExp }> = {
  "comment-attach": {
    args: ["issue", "comment", "--help"],
    shows: /--attach\b/u,
  },
  "issue-attach": {
    args: ["issue", "attach", "--help"],
    shows: /\bissue attach\b/u,
  },
  "auth-paths": { args: ["auth", "paths", "--help"], shows: /--add\b/u },
};

/**
 * Whether this ytrack has `feature`, read from its own `--help` (exit 0 and
 * the flag or command named): an older ytrack prints its parent's help or
 * fails, and neither names it.
 */
export function ytrackSupports(run: YtrackRun, feature: YtrackFeature): "ok" | "missing" | "old" {
  const probe = FEATURE_PROBE[feature];
  const out = run(probe.args);
  if (out.missing) return "missing";
  return out.status === YTRACK_EXIT.ok && probe.shows.test(`${out.stdout}\n${out.stderr}`)
    ? "ok"
    : "old";
}

/** The unblock for a ytrack too old for a feature Workit needs. */
export const ytrackUpgradeUnblock = (what: string): string =>
  `ytrack upgrade (this ytrack has no ${what}), then run the same command again`;

/** A word for a POSIX shell: always single-quoted unless it is plainly safe. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) && !word.includes("*")
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;

/** `ytrack auth paths --host <host> [--add '<glob>']… [--remove '<glob>']…`, ready to paste. */
export const ytrackAuthPathsCommand = (
  host: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): string =>
  [
    `ytrack auth paths --host ${ytrackHostName(host)}`,
    ...(change.add ?? []).map((glob) => `--add ${shellWord(glob)}`),
    ...(change.remove ?? []).map((glob) => `--remove ${shellWord(glob)}`),
  ].join(" ");

/** The argv of the same call, run without a shell. */
export const ytrackAuthPathsArgs = (
  host: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): string[] => [
  "auth",
  "paths",
  "--host",
  ytrackHostName(host),
  ...(change.add ?? []).flatMap((glob) => ["--add", glob]),
  ...(change.remove ?? []).flatMap((glob) => ["--remove", glob]),
];

export type YtrackPaths =
  | { ok: true; paths: string[] }
  | { ok: false; reason: "missing" | "old" | "failed"; error: string };

const UNKNOWN_COMMAND =
  /unknown (?:command|flag|option|subcommand)|unrecognized|invalid choice|no such command/iu;

/**
 * The folder globs ytrack maps to `host` (`ytrack auth paths --host <h> --json
 * host,paths`, youtrack-cli hosts.yml). `old` when this ytrack has no `auth
 * paths`: it refuses the command or prints no such JSON.
 */
export function ytrackAuthPaths(run: YtrackRun, host: string): YtrackPaths {
  const name = ytrackHostName(host);
  const out = run(["auth", "paths", "--host", name, "--json", "host,paths"]);
  if (out.missing) return { ok: false, reason: "missing", error: YTRACK_MISSING };
  const old = {
    ok: false as const,
    reason: "old" as const,
    error: "this ytrack has no `ytrack auth paths`",
  };
  if (out.status !== YTRACK_EXIT.ok) {
    const detail = ytrackDetail(out);
    return UNKNOWN_COMMAND.test(`${out.stdout}\n${out.stderr}`)
      ? old
      : {
          ok: false,
          reason: "failed",
          error: `ytrack auth paths failed (exit ${out.status ?? "signal"})${detail ? `: ${detail}` : ""}`,
        };
  }
  let json: unknown;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    return old;
  }
  const rows = (Array.isArray(json) ? json : [json]).filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
  const row =
    rows.find((candidate) => ytrackHostName(String(candidate.host ?? "")) === name) ??
    (rows.length === 1 && rows[0].host === undefined ? rows[0] : undefined);
  if (!row) return rows.some((candidate) => "paths" in candidate) ? { ok: true, paths: [] } : old;
  if (!Array.isArray(row.paths))
    return row.paths === undefined || row.paths === null ? { ok: true, paths: [] } : old;
  return {
    ok: true,
    paths: row.paths.filter((glob): glob is string => typeof glob === "string"),
  };
}
