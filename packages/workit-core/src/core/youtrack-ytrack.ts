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
