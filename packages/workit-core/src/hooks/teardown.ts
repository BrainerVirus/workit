// Session teardown (#328). When a host session really ends, the processes it
// registered stop: `workit stop --session <id> --reason session-end`. At a
// session start, processes whose owner is gone are reaped: `workit stop
// --orphans --reason session-start`, at most once per REAP_INTERVAL_MS per
// user. Both run the owned CLI (core/cli-locate.ts) detached and
// fire-and-forget, so a hook stays within its host's deadline and never opens
// the process store itself (no SQLite in hooks). Never `workit gc`: an older
// CLI would fall through to the task-store gc (decider ruling 8).
//
// The CLI honours keep decisions and workspace `cleanup: keep` and says why it
// left a row running; that output goes to `<state>/procs/teardown.log`. The
// child runs in `<state>/procs`, never the session's checkout: on Windows its
// cmd.exe outlives the CLI and would pin the checkout (#904); the stop selects
// rows by session id or owner, never by its cwd.
// Only a reason a host's allowlist names ends a session, so a reason a host
// adds later stops nothing. A worker's end stops nothing: `--session
// <lead>:<child>` selects the lead's rows too. Every step fails open and never
// throws.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { locateWorkitCli } from "../core/cli-locate";
import { leadOf } from "../core/live-session";
import { stateDir } from "../core/workit-paths.mjs";

export const REAP_INTERVAL_MS = 10 * 60_000;
const LOG_MAX_BYTES = 1 << 20;

/**
 * Per host, the reasons on which the session really ends (ruling 1); any other
 * (Claude Code clear/resume, Pi new/resume/fork/reload, a future reason) keeps
 * its processes. Codex is absent: its SessionEnd cannot tell a subagent from
 * the lead, so it is not registered and the start reap covers it.
 */
const ENDS: Readonly<Record<string, ReadonlySet<string>>> = {
  claude_code: new Set(["logout", "prompt_input_exit", "other"]),
  // Cursor's hooks docs: sessionEnd reasons.
  cursor: new Set(["completed", "aborted", "error", "window_close", "user_close"]),
  pi: new Set(["quit"]),
  opencode: new Set(["deleted"]),
};
/** A session id safe as one argv word (never an option), even through cmd.exe on Windows. */
const SAFE_SESSION = /^[\w.@+][\w.:@/+-]{0,127}$/u;
const HOST_SESSION_VARS = ["OPENCODE_SESSION_ID", "PI_SESSION_ID", "CODEX_THREAD_ID"];

const teardownDir = (env: NodeJS.ProcessEnv): string => path.join(stateDir(env), "procs");
export const teardownLog = (env: NodeJS.ProcessEnv): string =>
  path.join(teardownDir(env), "teardown.log");
export const reapStamp = (env: NodeJS.ProcessEnv): string =>
  path.join(teardownDir(env), "reap-at-start.stamp");

export type SpawnRequest = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** An open file descriptor for the child's stdout and stderr, or null. */
  log: number | null;
};

/** Start `request` in its own process group, not waited for: true when it started. */
export function spawnDetached(request: SpawnRequest): boolean {
  try {
    // A .cmd launcher (Windows) runs only through cmd.exe, given one command
    // line (args beside `shell` are deprecated, DEP0190); the args are fixed
    // words and a checked id, so they need no quoting.
    const shell = process.platform === "win32" && !/\.exe$/iu.test(request.command);
    const line = [`"${request.command}"`, ...request.args].join(" ");
    const child = spawn(shell ? line : request.command, shell ? [] : request.args, {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      shell,
      stdio: ["ignore", request.log ?? "ignore", request.log ?? "ignore"],
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

/** Seams for tests: a test run (WORKIT_TEST_RUN) never starts the real CLI. */
export const teardownDeps = {
  spawn: (request: SpawnRequest): boolean =>
    request.env.WORKIT_TEST_RUN === undefined && spawnDetached(request),
  now: (): number => Date.now(),
};

/** Open the teardown log for appending (restarted past LOG_MAX_BYTES) with a header line, or null. */
const openLog = (env: NodeJS.ProcessEnv, args: string[]): number | null => {
  try {
    const file = teardownLog(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // A first run.
    }
    const fd = fs.openSync(file, size > LOG_MAX_BYTES ? "w" : "a", 0o600);
    fs.writeSync(fd, `${new Date(teardownDeps.now()).toISOString()} workit ${args.join(" ")}\n`);
    return fd;
  } catch {
    return null;
  }
};

/** Run `workit <args>` detached from Workit's procs state dir: true when the CLI started. */
function runCli(args: string[], env: NodeJS.ProcessEnv): boolean {
  let log: number | null = null;
  try {
    const cli = locateWorkitCli({ env });
    const cwd = teardownDir(env);
    fs.mkdirSync(cwd, { recursive: true });
    log = openLog(env, args);
    const started = teardownDeps.spawn({
      command: cli.command,
      args: [...cli.args, ...args],
      env,
      cwd,
      log,
    });
    if (!started && log !== null) fs.writeSync(log, "  not started\n");
    return started;
  } catch {
    return false;
  } finally {
    if (log !== null)
      try {
        fs.closeSync(log);
      } catch {
        // The child holds its own copy.
      }
  }
}

export type SessionEnd = {
  host: string;
  session: string | null;
  /** Set when a subagent's own end reaches the hook. */
  agentId: string | null;
  reason: string | null;
  /** The session's checkout; the stop never runs in it (#904). */
  cwd: string;
};

/**
 * Stop the processes an ended session registered (its workers' too). Nothing
 * runs unless the host's allowlist names the reason, or when the session is a
 * worker's. True when the stop started.
 */
export function endSession(end: SessionEnd, env: NodeJS.ProcessEnv = process.env): boolean {
  const session = end.session?.trim() ?? "";
  if (!SAFE_SESSION.test(session) || !ENDS[end.host]?.has(end.reason ?? "")) return false;
  const outer = env.WORKIT_SESSION_ID?.trim();
  if (
    end.agentId ||
    env.WORKIT_PI_WORKER_SESSION ||
    leadOf(session) !== session ||
    (outer && leadOf(outer) !== outer)
  )
    return false;
  // The CLI acts as the ended session, whatever host session its env names.
  const child: NodeJS.ProcessEnv = { ...env, WORKIT_SESSION_ID: session, WORKIT_HOST: end.host };
  for (const key of HOST_SESSION_VARS) delete child[key];
  return runCli(["stop", "--session", session, "--reason", "session-end"], child);
}

/** Take the reap claim (an exclusive create); a claim older than the interval is a crashed holder's. */
const claim = (file: string, now: number): boolean => {
  for (let attempt = 0; attempt < 2; attempt += 1)
    try {
      fs.writeFileSync(file, String(now), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      let held = Number.NaN;
      try {
        held = Number(fs.readFileSync(file, "utf8"));
      } catch {
        // Released meanwhile: try again.
      }
      if (now - held < REAP_INTERVAL_MS) return false;
      fs.rmSync(file, { force: true });
    }
  return false;
};

const fresh = (stamp: string, now: number): boolean => {
  try {
    const last = Number(fs.readFileSync(stamp, "utf8"));
    return now - last < REAP_INTERVAL_MS && last <= now;
  } catch {
    return false;
  }
};

/**
 * Reap processes whose owner is gone, at most once per REAP_INTERVAL_MS per
 * user: one start at a time holds the claim, and the stamp is written only once
 * the reap started. True when it started. The session's checkout (`_cwd`) is
 * never the child's cwd (#904).
 */
export function reapAtStart(_cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const stamp = reapStamp(env);
  const lock = `${stamp}.claim`;
  const now = teardownDeps.now();
  try {
    if (fresh(stamp, now)) return false;
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    if (!claim(lock, now)) return false;
  } catch {
    return false;
  }
  let started = false;
  try {
    // Another start may have reaped between the read and the claim.
    if (fresh(stamp, now)) return false;
    started = runCli(["stop", "--orphans", "--reason", "session-start"], env);
    if (started) {
      const temp = `${stamp}.${process.pid}`;
      fs.writeFileSync(temp, String(now), { mode: 0o600 });
      fs.renameSync(temp, stamp);
    }
  } catch {
    // The stamp failed: the next start reaps again.
  } finally {
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      // A claim left behind expires after the interval.
    }
  }
  return started;
}
