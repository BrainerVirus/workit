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
// left a row running; that output goes to `<state>/procs/teardown.log`.
// A worker's end stops nothing: `--session <lead>:<child>` selects the lead's
// rows too. Every step fails open and never throws.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { locateWorkitCli } from "../core/cli-locate";
import { leadOf } from "../core/live-session";
import { stateDir } from "../core/workit-paths.mjs";

export const REAP_INTERVAL_MS = 10 * 60_000;
const LOG_MAX_BYTES = 1 << 20;

/** Reasons on which the host session goes on in the same process (ruling 1): its processes stay. */
const CONTINUES = new Set(["clear", "resume", "new", "fork", "reload"]);
/** A session id safe as one argv word, even through cmd.exe on Windows. */
const SAFE_SESSION = /^[\w.@+-][\w.:@/+-]{0,127}$/u;
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
    // A .cmd launcher (Windows) runs only through cmd.exe; the args are fixed words and a checked id.
    const shell = process.platform === "win32" && !/\.exe$/iu.test(request.command);
    const child = spawn(shell ? `"${request.command}"` : request.command, request.args, {
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

/** Run `workit <args>` detached from `cwd`: true when the CLI started. */
function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): boolean {
  let log: number | null = null;
  try {
    const cli = locateWorkitCli({ env });
    log = openLog(env, args);
    const started = teardownDeps.spawn({
      command: cli.command,
      args: [...cli.args, ...args],
      env,
      cwd: fs.existsSync(cwd) ? cwd : teardownDir(env),
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
  cwd: string;
};

/**
 * Stop the processes an ended session registered (its workers' too). Nothing
 * runs when the session goes on (clear, resume, a new or forked session in the
 * same process) or when the session is a worker's. True when the stop started.
 */
export function endSession(end: SessionEnd, env: NodeJS.ProcessEnv = process.env): boolean {
  const session = end.session?.trim() ?? "";
  if (!SAFE_SESSION.test(session) || (end.reason !== null && CONTINUES.has(end.reason)))
    return false;
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
  return runCli(["stop", "--session", session, "--reason", "session-end"], child, end.cwd);
}

/**
 * Reap processes whose owner is gone, at most once per REAP_INTERVAL_MS per
 * user. The stamp is written only once the reap started. True when it started.
 */
export function reapAtStart(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const stamp = reapStamp(env);
  const now = teardownDeps.now();
  try {
    const last = Number(fs.readFileSync(stamp, "utf8"));
    if (now - last < REAP_INTERVAL_MS && last <= now) return false;
  } catch {
    // No stamp yet.
  }
  if (!runCli(["stop", "--orphans", "--reason", "session-start"], env, cwd)) return false;
  try {
    fs.writeFileSync(stamp, String(now), { mode: 0o600 });
  } catch {
    // The next start reaps again.
  }
  return true;
}
