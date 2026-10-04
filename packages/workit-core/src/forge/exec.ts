// Bounded gh/glab invocation (design §0 #8: `gh api` / `glab api` only, never
// porcelain whose flags vary by CLI version). Every call has a timeout, runs
// with prompts and update checks disabled, and targets the API host derived
// from the push remote (GH_HOST / GITLAB_HOST). Failures map to the envelope
// codes; stderr is redacted before it reaches a message.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ForgeKind } from "../git/rev";
import { redactText } from "./redact";
import { failure, type ForgeResult } from "./types";

export type CliBin = "gh" | "glab";

export type CliRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The binary is not on PATH. */
  missing: boolean;
};

/** Runs one gh/glab command. Injected in tests to replay recorded API fixtures. */
export type ForgeRunner = (
  bin: CliBin,
  args: readonly string[],
  options: {
    timeoutMs: number;
    /** Credential for this call (GH_TOKEN / GITLAB_TOKEN); never logged. */
    token?: string;
  },
) => CliRun;

/** Default per-call bounds (ms). */
export const FORGE_TIMEOUTS = { api: 20_000, log: 30_000 } as const;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Locate `bin` on `env.PATH` without running a shell. */
export function findExecutable(bin: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  // Only real executables: spawning a .cmd/.bat shim would need a shell.
  const exts = process.platform === "win32" ? [".exe"] : [""];
  for (const dir of dirs)
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // not here
      }
    }
  return null;
}

/** The real gh/glab, bound to one API host. */
export function systemRunner(
  kind: ForgeKind,
  apiHost: string,
  env: NodeJS.ProcessEnv = process.env,
): ForgeRunner {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(kind === "github" ? { GH_HOST: apiHost } : { GITLAB_HOST: apiHost }),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GLAB_CHECK_UPDATE: "false",
    NO_PROMPT: "1",
    NO_COLOR: "1",
    GH_PAGER: "",
    GLAB_PAGER: "",
    PAGER: "",
  };
  return (bin, args, options) => {
    const exe = findExecutable(bin, env);
    if (!exe) return { status: null, stdout: "", stderr: "", timedOut: false, missing: true };
    const token = options.token
      ? kind === "github"
        ? { GH_TOKEN: options.token, GH_ENTERPRISE_TOKEN: options.token }
        : { GITLAB_TOKEN: options.token }
      : {};
    const result = spawnSync(exe, [...args], {
      encoding: "utf8",
      env: { ...childEnv, ...token },
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const error: NodeJS.ErrnoException | undefined = result.error;
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: error?.code === "ETIMEDOUT",
      missing: error?.code === "ENOENT",
    };
  };
}

export const installHint = (bin: CliBin): string =>
  bin === "gh"
    ? "install the GitHub CLI (https://cli.github.com) and run: gh auth login"
    : "install glab (https://gitlab.com/gitlab-org/cli) and run: glab auth login";

export const loginHint = (bin: CliBin, apiHost: string): string =>
  `${bin} auth login --hostname ${apiHost}`;

/** Map a failed CLI run to an envelope error. */
export function cliFailure<T>(
  bin: CliBin,
  apiHost: string,
  run: CliRun,
  what: string,
  timeoutMs: number,
): ForgeResult<T> {
  if (run.missing) return failure("unavailable", `${bin} is not installed`, installHint(bin));
  if (run.timedOut)
    return failure("unavailable", `${bin} api ${what} timed out after ${timeoutMs} ms`);
  const stderr = redactText(run.stderr).trim();
  if (
    /auth login|not logged in|no token|authentication required|bad credentials|\b401\b|unauthorized/iu.test(
      stderr,
    )
  )
    return failure(
      "unavailable",
      `${bin} is not authenticated for ${apiHost}`,
      loginHint(bin, apiHost),
    );
  if (/\b404\b|not found/iu.test(stderr)) return failure("not_found", `${what} was not found`);
  const first = stderr.split(/\r?\n/u).find((value) => value.trim()) ?? `exit ${run.status}`;
  return failure("failed", `${bin} api ${what} failed: ${first.slice(0, 200)}`);
}

/** Run and parse a JSON response. */
export function apiJson<T>(
  runner: ForgeRunner,
  bin: CliBin,
  apiHost: string,
  args: readonly string[],
  what: string,
  timeoutMs: number = FORGE_TIMEOUTS.api,
  options: { graphql?: boolean } = {},
): ForgeResult<T> {
  const run = runner(bin, args, { timeoutMs });
  if (run.status !== 0) {
    // `gh api graphql` exits 1 on GraphQL errors but still prints the
    // response; the caller reads its `errors` array.
    if (options.graphql && !run.missing && !run.timedOut)
      try {
        const body = JSON.parse(run.stdout) as { errors?: unknown };
        if (Array.isArray(body.errors)) return { ok: true, data: body as T };
      } catch {
        // fall through
      }
    return cliFailure(bin, apiHost, run, what, timeoutMs);
  }
  try {
    return { ok: true, data: JSON.parse(run.stdout) as T };
  } catch {
    return failure("failed", `${bin} api ${what} returned invalid JSON`);
  }
}

/** Run and return raw text (job logs). */
export function apiText(
  runner: ForgeRunner,
  bin: CliBin,
  apiHost: string,
  args: readonly string[],
  what: string,
  timeoutMs: number = FORGE_TIMEOUTS.log,
): ForgeResult<string> {
  const run = runner(bin, args, { timeoutMs });
  if (run.status !== 0) return cliFailure(bin, apiHost, run, what, timeoutMs);
  return { ok: true, data: run.stdout };
}

/**
 * A forge write (create, merge, retarget). Like apiJson, plus: an HTTP 409 or
 * a head-moved/SHA-mismatch message is `blocked` (`head_moved`), and 405/406/
 * 422 refusals are `blocked` with the forge's own reason, so a refused
 * mutation never reads as a transient failure.
 */
export function apiWrite<T>(
  runner: ForgeRunner,
  bin: CliBin,
  apiHost: string,
  args: readonly string[],
  what: string,
  timeoutMs: number = FORGE_TIMEOUTS.api,
): ForgeResult<T> {
  const run = runner(bin, args, { timeoutMs });
  if (run.status !== 0) {
    const text = redactText(`${run.stderr}\n${run.stdout}`).trim();
    const reason = (text.split(/\r?\n/u).find((value) => value.trim()) ?? "").slice(0, 200);
    if (
      !run.missing &&
      !run.timedOut &&
      /\b409\b|head branch was modified|sha does not match|sha.*mismatch/iu.test(text)
    )
      return failure(
        "blocked",
        `head_moved: ${what} refused because the head changed (${reason})`,
        "workit pr status  # re-check the new head, then verify it again",
      );
    if (!run.missing && !run.timedOut && /\b(405|406|422)\b/u.test(text))
      return failure("blocked", `${what} refused by the forge: ${reason}`);
    return cliFailure(bin, apiHost, run, what, timeoutMs);
  }
  if (!run.stdout.trim()) return { ok: true, data: {} as T };
  try {
    return { ok: true, data: JSON.parse(run.stdout) as T };
  } catch {
    return failure("failed", `${bin} api ${what} returned invalid JSON`);
  }
}
