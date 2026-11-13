// The process registry (#328): long-running processes an agent started through
// `workit run --bg` (dev servers, `docker compose up`), recorded in the threads
// store (docs/specs/threads.md) with their owner, so the session that started
// one stops it at the end of its work and nobody else's process is touched.
//
// Rules (wave 9 decider rulings 1, 3, 4, A, B, C):
//   - a stop only signals a process whose leader start time still matches
//     (checked before SIGTERM and again before SIGKILL);
//   - an orphan needs proof its owner is gone: the recorded host pid is gone or
//     its start time changed; a row with no host pid is listed, never stopped;
//   - a row started outside any agent session, or marked keep, is stopped only
//     by naming its id (`workit stop <id>`);
//   - docker rows stop exactly the containers their start created
//     (`docker stop <id>`), never down, rm or -v;
//   - an agent acts only on rows its own session family owns;
//   - unregistered processes are never touched.
//
// The v1 `procs` table has no column for a few facts (the host pid's start
// time, container ids, the name, the start state): each row keeps them in a
// small JSON file beside the logs, `<state>/procs/rows/<id>.json`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendObserved, type LedgerActor } from "../ledger";
import { openThreadsStore, type ThreadsStore } from "../store/threads/store";
import { readProc, upsertProc, type ProcKind, type ProcRow } from "../store/threads/procs";
import { leadOf } from "./live-session";
import {
  groupAlive,
  identity,
  pidAlive,
  procTree,
  STOP_GRACE_MS,
  stopGroup,
  type GroupStop,
} from "./proc-tree";
import { stateDir } from "./workit-paths.mjs";

export type { ProcRow, ProcKind };

/** The name a start gets without --name: one dev server per repo and name. */
export const DEFAULT_PROC_NAME = "dev";

export const procsDir = (env: NodeJS.ProcessEnv): string => path.join(stateDir(env), "procs");
export const procLogFile = (env: NodeJS.ProcessEnv, id: string): string =>
  path.join(procsDir(env), "logs", `${id}.log`);
const extraFile = (env: NodeJS.ProcessEnv, id: string): string =>
  path.join(procsDir(env), "rows", `${id}.json`);
/** The stop channel: a request the row's supervisor polls for and acts on. */
export const stopRequestFile = (env: NodeJS.ProcessEnv, id: string): string =>
  path.join(procsDir(env), "rows", `${id}.stop`);
const sessionFileName = (session: string): string =>
  `${session.replace(/[^A-Za-z0-9_.@+-]/gu, "-").slice(0, 120) || "none"}.json`;
export const noticeFile = (env: NodeJS.ProcessEnv, session: string | null): string =>
  path.join(procsDir(env), "notices", sessionFileName(session ?? "terminal"));

/** A new registry id: short, sortable by start, safe in a path. */
export const newProcId = (now = Date.now()): string =>
  `p${now.toString(36)}${randomBytes(2).toString("hex")}`;

// ---------------------------------------------------------------------------
// per-row facts the v1 table has no column for

export type ProcState = "starting" | "refused" | "running" | "exited" | "failed";

export type ProcExtra = {
  version: 1;
  name: string;
  state: ProcState;
  /** The command as started, for `workit run --bg --restart <id>`. */
  argv: string[] | null;
  /** The host pid's start time, so a reused host pid does not keep the owner alive (ruling B). */
  hostPidStart: string | null;
  /** The supervisor that runs the command and samples its memory. */
  supervisorPid: number | null;
  /** The supervisor's start time, so a reused supervisor pid is never taken for it. */
  supervisorStart: string | null;
  /** The signal the supervisor's own stop ended its child with (the stop channel). */
  stopSignal: "SIGTERM" | "SIGKILL" | null;
  /** Containers this start created or started (a `docker ps -q` diff); null when the diff could not be read. */
  containers: string[] | null;
  /** The command's exit code once it ended on its own. */
  exitCode: number | null;
  /** A refusal or failure line, and its unblock. */
  message: string | null;
  unblock: string | null;
  /** True once the RSS notice for this process was written. */
  noticed: boolean;
};

const blankExtra = (name: string): ProcExtra => ({
  version: 1,
  name,
  state: "starting",
  argv: null,
  hostPidStart: null,
  supervisorPid: null,
  supervisorStart: null,
  stopSignal: null,
  containers: [],
  exitCode: null,
  message: null,
  unblock: null,
  noticed: false,
});

export function readExtra(env: NodeJS.ProcessEnv, id: string): ProcExtra | null {
  try {
    const value = JSON.parse(fs.readFileSync(extraFile(env, id), "utf8")) as Partial<ProcExtra>;
    if (value?.version !== 1 || typeof value.name !== "string") return null;
    return { ...blankExtra(value.name), ...value };
  } catch {
    return null;
  }
}

const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/** Merge `patch` into a row's facts (created with `name` when missing). */
export function updateExtra(
  env: NodeJS.ProcessEnv,
  id: string,
  patch: Partial<ProcExtra> & { name?: string },
): ProcExtra {
  const next = { ...(readExtra(env, id) ?? blankExtra(patch.name ?? DEFAULT_PROC_NAME)), ...patch };
  writeJson(extraFile(env, id), next);
  return next;
}

// ---------------------------------------------------------------------------
// reading

export const openProcs = (env: NodeJS.ProcessEnv): ThreadsStore => openThreadsStore({ env });

export const procName = (env: NodeJS.ProcessEnv, row: ProcRow): string =>
  readExtra(env, row.id)?.name ?? DEFAULT_PROC_NAME;

/** Rows still running (not ended), oldest first. */
export function liveProcs(store: ThreadsStore): ProcRow[] {
  return store.db
    .all("SELECT id FROM procs WHERE ended_at IS NULL ORDER BY started_at, id")
    .flatMap((row) => {
      const found = readProc(store, String(row.id));
      return found ? [found] : [];
    });
}

/** Every row, newest first, bounded. */
export function recentProcs(store: ThreadsStore, limit = 50): ProcRow[] {
  return store.db
    .all("SELECT id FROM procs ORDER BY started_at DESC, id DESC LIMIT $limit", { limit })
    .flatMap((row) => {
      const found = readProc(store, String(row.id));
      return found ? [found] : [];
    });
}

/**
 * End the row `id` with `reason`. `overwrite` (a stop) replaces the reason the
 * supervisor may have written a moment before, when the signal ended its child.
 */
export const endProc = (
  store: ThreadsStore,
  id: string,
  reason: string,
  now = Date.now(),
  overwrite = false,
) =>
  upsertProc(store, id, (current) =>
    current && (current.endedAt === null || overwrite)
      ? { endedAt: current.endedAt ?? new Date(now).toISOString(), endReason: reason }
      : {},
  );

/**
 * Is the row's process still there? A docker row with containers counts as
 * running while they may be (only `workit stop` ends it). A row whose leader
 * pid now belongs to another process is not.
 */
export function rowRunning(env: NodeJS.ProcessEnv, row: ProcRow): "running" | "gone" | "reused" {
  if (row.kind === "docker" && (readExtra(env, row.id)?.containers ?? [null]).length)
    return "running";
  if (row.pid === null) return row.pgid !== null && groupAlive(row.pgid) ? "running" : "gone";
  const who = identity(row.pid, row.pidStart);
  if (who === "reused") return "reused";
  if (who === "gone") return row.pgid !== null && groupAlive(row.pgid) ? "running" : "gone";
  return "running";
}

/** End rows whose process is gone; returns the rows still running. */
export function settleProcs(
  store: ThreadsStore,
  env: NodeJS.ProcessEnv,
  rows: ProcRow[] = liveProcs(store),
): ProcRow[] {
  return rows.filter((row) => {
    const state = rowRunning(env, row);
    if (state === "running") return true;
    endProc(store, row.id, state === "reused" ? "found gone (pid reused)" : "found gone");
    return false;
  });
}

const inside = (child: string, parent: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Live rows started in `dir` or below it (ruling 1: the delivery end's listing). */
export const processesWithin = (store: ThreadsStore, dir: string): ProcRow[] =>
  liveProcs(store).filter((row) => inside(row.cwd, dir));

/** The live dev server of `repo` (its git common dir) under `name`, after dropping dead rows. */
export function serverFor(
  store: ThreadsStore,
  env: NodeJS.ProcessEnv,
  repo: string,
  name: string,
): ProcRow | undefined {
  const rows = liveProcs(store).filter(
    (row) => row.repo === repo && row.kind !== "docker" && procName(env, row) === name,
  );
  return settleProcs(store, env, rows)[0];
}

/** `docker compose … up`, `docker-compose up` and `docker run` start containers. */
export function procKind(argv: readonly string[]): ProcKind {
  const words = argv.map((word) => path.basename(word));
  if (words[0] === "docker-compose" && words.includes("up")) return "docker";
  if (words[0] === "docker" && (words.includes("run") || words.includes("up"))) return "docker";
  return "server";
}

// ---------------------------------------------------------------------------
// ownership

/** orphanReason's answer for a row with no host pid to check. */
export const UNKNOWN_OWNER = "unknown";

/**
 * Why `row`'s owner is gone, or null while it lives (ruling B). Never by
 * heartbeat age: only the recorded host pid gone or now another process.
 * `unknown` when there is no host pid to check (Windows, a row from a shell
 * with no host): such a row is listed, never stopped automatically.
 */
export function orphanReason(env: NodeJS.ProcessEnv, row: ProcRow): string | null {
  if (row.hostPid === null) return UNKNOWN_OWNER;
  if (!pidAlive(row.hostPid)) return `its owner's host process ${row.hostPid} is gone`;
  const recorded = readExtra(env, row.id)?.hostPidStart ?? null;
  if (recorded === null) return null;
  const now = procTree.start(row.hostPid);
  if (now !== null && now !== recorded)
    return `its owner's host pid ${row.hostPid} now belongs to another process`;
  return null;
}

/** A row started with no agent session (a plain terminal): only `workit stop <id>` stops it. */
export const isTerminalRow = (row: ProcRow): boolean => row.host === null;

/** Does `caller` (an agent session) own `row`: the same session, or the same lead? */
export const ownsRow = (caller: string, row: ProcRow): boolean =>
  row.session === caller ||
  (row.lead ?? (row.session ? leadOf(row.session) : null)) === leadOf(caller);

// ---------------------------------------------------------------------------
// stopping

export type StopContext = {
  env: NodeJS.ProcessEnv;
  actor: LedgerActor;
  /** An agent session acting: rows another session family owns are skipped (ruling A). Null: a person at a terminal. */
  caller: string | null;
  graceMs?: number;
  store?: ThreadsStore;
  now?: () => number;
};

export type StoppedProc = {
  id: string;
  cmd: string;
  cwd: string;
  outcome: "stopped" | "gone" | "reused";
  signal: "SIGTERM" | "SIGKILL" | null;
  containers: string[];
  /** The ledger row, or why it was not written. */
  recorded: { id: string } | { error: string };
};

export type SkippedProc = { id: string; cmd: string; reason: string };

export type StopReport = {
  stopped: StoppedProc[];
  skipped: SkippedProc[];
  failed: SkippedProc[];
};

/** How the registry runs docker; tests swap it for a fake. */
export const procsDeps = {
  docker: (
    args: string[],
    cwd?: string,
  ): { status: number | null; stdout: string; stderr: string } => {
    const run = spawnSync("docker", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    return {
      status: run.error ? null : run.status,
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
    };
  },
  graceMs: STOP_GRACE_MS,
  /**
   * How a stop reaches the process: `auto` signals the group itself on POSIX
   * and asks the supervisor on Windows (ruling C); `supervisor` always asks the
   * supervisor (tests drive the Windows path on any platform with it).
   */
  stopVia: "auto" as "auto" | "supervisor",
  /** How long a stop waits for the supervisor's answer past the grace. */
  answerMs: 5_000,
};

export type StopRequest = { version: 1; reason: string; graceMs: number; at: string };

/** Whether the row's supervisor still runs: its pid alive and, where readable, the same start time. */
export function supervisorAlive(env: NodeJS.ProcessEnv, id: string): boolean {
  const extra = readExtra(env, id);
  if (!extra?.supervisorPid) return false;
  const who = identity(extra.supervisorPid, extra.supervisorStart);
  return who === "same" || who === "unknown";
}

/**
 * Stop through the supervisor that holds the child (ruling C; the only stop
 * on Windows): write a stop request it polls for, and wait for the row's
 * process to end. With the supervisor gone the stop is report-only: nothing
 * is signalled, so a pid another process took is never touched.
 */
export async function stopViaSupervisor(
  env: NodeJS.ProcessEnv,
  row: ProcRow,
  reason: string,
  graceMs: number,
): Promise<GroupStop> {
  if (!supervisorAlive(env, row.id))
    return {
      outcome: "refused",
      detail:
        "its supervisor is gone, so Workit cannot prove which process is its child: report only, nothing signalled",
    };
  const request: StopRequest = { version: 1, reason, graceMs, at: new Date().toISOString() };
  writeJson(stopRequestFile(env, row.id), request);
  const deadline = procTree.now() + graceMs + procsDeps.answerMs;
  while (procTree.now() < deadline) {
    const extra = readExtra(env, row.id);
    if (extra?.state === "exited" || extra?.state === "failed")
      return extra.stopSignal
        ? { outcome: "stopped", signal: extra.stopSignal }
        : { outcome: "gone" };
    if (!supervisorAlive(env, row.id)) break;
    await procTree.sleep(100);
  }
  try {
    fs.rmSync(stopRequestFile(env, row.id), { force: true });
  } catch {
    // the supervisor took it meanwhile
  }
  const extra = readExtra(env, row.id);
  if (extra?.state === "exited")
    return extra.stopSignal
      ? { outcome: "stopped", signal: extra.stopSignal }
      : { outcome: "gone" };
  return {
    outcome: "refused",
    detail: supervisorAlive(env, row.id)
      ? `its supervisor did not confirm the stop within ${Math.round((graceMs + procsDeps.answerMs) / 1000)} s`
      : "its supervisor ended without confirming the stop: report only",
  };
}

/** Running container ids (`docker ps -q --no-trunc`), or null when docker cannot be asked. */
export function dockerIds(cwd?: string): string[] | null {
  const run = procsDeps.docker(["ps", "-q", "--no-trunc"], cwd);
  if (run.status !== 0) return null;
  return run.stdout.split(/\s+/u).filter(Boolean);
}

/** Run `fn` on the context's store, or on one opened (and closed once `fn` settles) for it. */
const withStore = async <T>(
  context: Pick<StopContext, "store" | "env">,
  fn: (store: ThreadsStore) => Promise<T>,
): Promise<T> => {
  if (context.store) return fn(context.store);
  const store = openProcs(context.env);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
};

/** Stop one row (no ownership or keep check: the caller made it) and record proc.stopped. */
export async function stopProc(
  store: ThreadsStore,
  row: ProcRow,
  reason: string,
  context: StopContext,
): Promise<StoppedProc | SkippedProc> {
  const extra = readExtra(context.env, row.id);
  const containers = row.kind === "docker" ? (extra?.containers ?? null) : [];
  if (containers?.length) {
    // Stop only what this start created: never down, rm, -v or prune (ruling 4).
    const stopped = procsDeps.docker(["stop", ...containers], row.cwd);
    if (stopped.status !== 0)
      return {
        id: row.id,
        cmd: row.cmd,
        reason: `docker stop failed: ${(stopped.stderr || stopped.stdout).trim().split("\n")[0] || `exit ${stopped.status}`}`,
      };
  }
  const graceMs = context.graceMs ?? procsDeps.graceMs;
  const viaSupervisor =
    (procsDeps.stopVia === "supervisor" || procTree.platform === "win32") &&
    (row.pid !== null || row.pgid !== null);
  const result = viaSupervisor
    ? await stopViaSupervisor(context.env, row, reason, graceMs)
    : await stopGroup({ pid: row.pid, pgid: row.pgid, pidStart: row.pidStart }, graceMs);
  if (result.outcome === "refused") return { id: row.id, cmd: row.cmd, reason: result.detail };
  const signal = result.outcome === "stopped" ? result.signal : null;
  const endReason =
    result.outcome === "reused" ? `${reason} (pid reused: nothing signalled)` : reason;
  endProc(store, row.id, endReason, context.now?.() ?? Date.now(), true);
  const row2 = appendObserved(row.cwd, {
    type: "proc.stopped",
    actor: context.actor,
    proc: row.id,
    cmd: row.cmd,
    kind: row.kind,
    pid: row.pid,
    owner: row.session,
    reason,
    outcome: result.outcome,
    signal,
    containers: containers ?? [],
  });
  return {
    id: row.id,
    cmd: row.cmd,
    cwd: row.cwd,
    outcome: result.outcome,
    signal,
    containers: containers ?? [],
    recorded: row2.ok ? { id: String(row2.value.id) } : { error: row2.error },
  };
}

export type StopFilter = {
  /** Rows named by id: stopped even when kept or started from a terminal (rulings 1 and 3). */
  ids?: readonly string[];
  /** Rows of this session and its workers. */
  session?: string;
  /** Rows started in this directory or below it. */
  within?: string;
};

const isStopped = (value: StoppedProc | SkippedProc): value is StoppedProc => "outcome" in value;

/**
 * Stop the registered processes `filter` selects, recording each stop.
 * A filter by session or directory skips kept rows and rows started outside
 * an agent session, saying why; ids name rows to stop regardless. An agent
 * caller never stops another session family's row.
 */
export async function stopProcesses(
  filter: StopFilter,
  reason: string,
  context: StopContext,
): Promise<StopReport> {
  const report: StopReport = { stopped: [], skipped: [], failed: [] };
  return withStore(context, async (store) => {
    const live = settleProcs(store, context.env);
    let rows: ProcRow[];
    if (filter.ids?.length) {
      rows = [];
      for (const id of filter.ids) {
        const row = live.find((candidate) => candidate.id === id);
        if (row) rows.push(row);
        else {
          const ended = readProc(store, id);
          report.skipped.push({
            id,
            cmd: ended?.cmd ?? "",
            reason: ended
              ? `already ended ${ended.endedAt} (${ended.endReason ?? "no reason"})`
              : "no such registered process",
          });
        }
      }
    } else {
      rows = live.filter(
        (row) =>
          (filter.session === undefined ||
            row.session === filter.session ||
            row.lead === leadOf(filter.session)) &&
          (filter.within === undefined || inside(row.cwd, filter.within)),
      );
      rows = rows.filter((row) => {
        if (row.keep) {
          report.skipped.push({
            id: row.id,
            cmd: row.cmd,
            reason: `kept${row.keepRef ? ` (${row.keepRef})` : ""}: only \`workit stop ${row.id}\` stops it`,
          });
          return false;
        }
        if (isTerminalRow(row)) {
          report.skipped.push({
            id: row.id,
            cmd: row.cmd,
            reason: `started outside an agent session: only \`workit stop ${row.id}\` stops it`,
          });
          return false;
        }
        return true;
      });
    }
    for (const row of rows) {
      if (context.caller !== null && !ownsRow(context.caller, row)) {
        report.skipped.push({
          id: row.id,
          cmd: row.cmd,
          reason: `owned by session ${row.session ?? "(none)"}, not this one: its owner or a person stops it`,
        });
        continue;
      }
      const outcome = await stopProc(store, row, reason, context);
      if (isStopped(outcome)) report.stopped.push(outcome);
      else report.failed.push(outcome);
    }
    return report;
  });
}

export type OrphanReport = StopReport & {
  /** Rows whose owner is gone (stopped too when applied). */
  orphans: Array<{ id: string; cmd: string; reason: string }>;
  /** Rows with no host pid to prove anything: listed, never stopped. */
  unknown: SkippedProc[];
  apply: boolean;
};

/**
 * Find registered processes whose owner is gone (ruling B) and, with
 * `apply`, stop them with reason `orphan`. Kept rows and rows started
 * outside an agent session are reported and left running.
 */
export async function reapOrphans(
  context: StopContext & { apply?: boolean; reason?: string },
): Promise<OrphanReport> {
  const apply = context.apply ?? true;
  const report: OrphanReport = {
    stopped: [],
    skipped: [],
    failed: [],
    orphans: [],
    unknown: [],
    apply,
  };
  return withStore(context, async (store) => {
    for (const row of settleProcs(store, context.env)) {
      if (isTerminalRow(row)) {
        report.skipped.push({
          id: row.id,
          cmd: row.cmd,
          reason: `started outside an agent session: only \`workit stop ${row.id}\` stops it`,
        });
        continue;
      }
      const why = orphanReason(context.env, row);
      if (why === null) continue;
      if (why === UNKNOWN_OWNER) {
        report.unknown.push({
          id: row.id,
          cmd: row.cmd,
          reason: "its owner's host pid is unknown: listed, never stopped automatically",
        });
        continue;
      }
      if (row.keep) {
        report.skipped.push({
          id: row.id,
          cmd: row.cmd,
          reason: `orphan, but kept${row.keepRef ? ` (${row.keepRef})` : ""}`,
        });
        continue;
      }
      report.orphans.push({ id: row.id, cmd: row.cmd, reason: why });
      if (!apply) continue;
      const outcome = await stopProc(store, row, `${context.reason ?? "orphan"}: ${why}`, {
        ...context,
        caller: null,
      });
      if (isStopped(outcome)) report.stopped.push(outcome);
      else report.failed.push(outcome);
    }
    return report;
  });
}

/** Mark a row kept (cleanup leaves it running); `ref` names the ledger decision. */
export const keepProc = (store: ThreadsStore, id: string, ref: string | null): ProcRow =>
  upsertProc(store, id, () => ({ keep: true, keepRef: ref }));

// ---------------------------------------------------------------------------
// the RSS ceiling notice

export type RssNotice = {
  id: string;
  cmd: string;
  cwd: string;
  rssBytes: number;
  ceilingBytes: number;
  restart: string;
  at: string;
};

/**
 * Add `row` to its owner's notice file (`<state>/procs/notices/<session>.json`)
 * once: a process past the ceiling is named one time, with the restart command.
 * Returns false when it was already there.
 */
export function writeRssNotice(
  env: NodeJS.ProcessEnv,
  row: ProcRow,
  rssBytes: number,
  ceilingBytes: number,
  now = Date.now(),
): boolean {
  const file = noticeFile(env, row.session);
  let notices: RssNotice[] = [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { notices?: unknown };
    if (Array.isArray(value.notices)) notices = value.notices as RssNotice[];
  } catch {
    // none yet
  }
  if (notices.some((notice) => notice.id === row.id)) return false;
  notices.push({
    id: row.id,
    cmd: row.cmd,
    cwd: row.cwd,
    rssBytes,
    ceilingBytes,
    restart: `workit run --bg --restart ${row.id}`,
    at: new Date(now).toISOString(),
  });
  writeJson(file, { version: 1, session: row.session, notices });
  return true;
}
