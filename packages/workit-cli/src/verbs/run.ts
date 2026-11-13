// `workit run --bg [--port N] [--name n] [--restart <id>] [--no-lease --reason "<why>"] -- <cmd…>`
// (#328): start a long-running command (a dev server, `docker compose up`)
// under a detached supervisor and register it, so `workit ps` lists it and
// `workit stop` (or the session's end) stops it.
//
//   - One dev server per repo and name: a second start in the same checkout
//     prints the live one's id and port and starts nothing; from another
//     checkout of the repo it fails naming the live one's cwd, branch and
//     owner (ruling D).
//   - The server is charged against the heavy budget of the caller's
//     checkout; a start that does not fit, or comes at critical pressure, is
//     refused at once naming the holders (ruling 6). `--no-lease --reason`
//     starts it anyway and records why in the ledger.
//   - A command that exits within the start bound prints its output and exit
//     code and leaves no live row (ruling H).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CHECKS_FILE, loadCheckConfig } from "@workit-dev/core/src/check-config";
import { gitDirs } from "@workit-dev/core/src/git/facts";
import { currentBranch } from "@workit-dev/core/src/git/rev";
import { hostSessionFromEnv, realHostSession } from "@workit-dev/core/src/host-session";
import { appendObserved, actorFromEnv } from "@workit-dev/core/src/ledger";
import { hostPid, leadOf } from "@workit-dev/core/src/core/live-session";
import { procTree } from "@workit-dev/core/src/core/proc-tree";
import {
  DEFAULT_PROC_NAME,
  newProcId,
  openProcs,
  procKind,
  procLogFile,
  procName,
  readExtra,
  serverFor,
  stopProcesses,
  updateExtra,
} from "@workit-dev/core/src/core/procs";
import { readProc, upsertProc } from "@workit-dev/core/src/store/threads/procs";
import { emit, fail, ok, type Io } from "../output";
import { SUPERVISE_ENV, supervise, type SupervisorSpec } from "../procs/supervisor";
import { workspaceResources } from "./check";

const USAGE =
  'workit run --bg [--port <n>] [--name <n>] [--restart <id>] [--no-lease --reason "<why>"] -- <cmd…>';

/** What a server is charged before its first RSS sample. */
const EXPECTED_RSS_BYTES = 512 * 1024 ** 2;

/** Seams for tests: how the supervisor is started and how long the start waits. */
export const runDeps = {
  /** The command that becomes the supervisor (this CLI, `workit run`, with the spec in its env). */
  supervisor: (): string[] => [process.execPath, process.argv[1] ?? "", "run"],
  /** How long a start waits for a port (or the command's exit) before it returns. */
  startBoundMs: 15_000,
  /** With --port, how long the command must stay up before the start returns. */
  settleMs: 1_000,
  sampleMs: 30_000,
  /** The RSS ceiling for the notice; null: the budget's per-check memoryMax. */
  ceilingBytes: null as number | null,
  /** The host process that owns this call (null: none can be told). */
  hostPid: (): number | null => hostPid("hook-process"),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Options = {
  bg: boolean;
  port: number | null;
  name: string | null;
  restart: string | null;
  noLease: boolean;
  reason: string | null;
  command: string[];
};

function parse(argv: string[]): Options | string {
  const options: Options = {
    bg: false,
    port: null,
    name: null,
    restart: null,
    noLease: false,
    reason: null,
    command: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      index += 1;
      return next === undefined || next === "--" ? null : next;
    };
    if (arg === "--") {
      options.command = argv.slice(index + 1);
      break;
    }
    if (arg === "--bg") options.bg = true;
    else if (arg === "--json") continue;
    else if (arg === "--no-lease") options.noLease = true;
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        return "--port takes a port number 1-65535";
      options.port = port;
    } else if (arg === "--name") {
      const name = value();
      if (!name || !/^[\w.-]{1,40}$/u.test(name))
        return "--name takes a short name (letters, digits, . _ -)";
      options.name = name;
    } else if (arg === "--restart") {
      options.restart = value();
      if (!options.restart) return "--restart takes the id `workit ps` shows";
    } else if (arg === "--reason") {
      options.reason = value();
      if (!options.reason) return '--reason takes "<why>"';
    } else return `unknown argument ${arg}`;
  }
  if (!options.bg) return "workit run starts a background process: pass --bg";
  if (options.noLease && !options.reason)
    return '--no-lease skips the heavy budget and needs --reason "<why>" (recorded in the ledger)';
  if (!options.restart && options.command.length === 0) return "no command after --";
  if (options.restart && options.command.length)
    return "--restart starts the recorded command again; pass no command";
  return options;
}

/** The first `localhost:<port>` (or 127.0.0.1, 0.0.0.0, [::1]) the log shows. */
export function portInLog(text: string): number | null {
  const match = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/u.exec(text);
  const port = match ? Number(match[1]) : null;
  return port && port <= 65_535 ? port : null;
}

const readLog = (file: string, limit = 1_000_000): string => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, limit);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
};

const realpath = (dir: string): string => {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
};

type Started = {
  id: string;
  pid: number | null;
  port: number | null;
  log: string;
  name: string;
  existing: boolean;
};

const startedLines = (data: Started): string[] => [
  `${data.existing ? "already running" : "started"} ${data.id} (${data.name}) pid ${data.pid ?? "?"} port ${data.port ?? "unknown"}`,
  `log: ${data.log}`,
  ...(data.port === null && !data.existing
    ? ["no localhost:<port> in the log yet; pass --port or read the log"]
    : []),
  `stop it: workit stop ${data.id}`,
];

export async function run(argv: string[], io: Io): Promise<number> {
  const specText = io.env[SUPERVISE_ENV];
  if (specText) return supervise(JSON.parse(specText) as SupervisorSpec, io.env);
  const parsed = parse(argv);
  if (typeof parsed === "string") return emit(io, fail("invalid_input", `${parsed}: ${USAGE}`));
  const env = io.env;
  const acting = hostSessionFromEnv(env);
  const real = realHostSession(env);
  const agent = real.kind === "none" ? null : acting.session;

  let argvToRun = parsed.command;
  let cwd = io.cwd;
  let name = parsed.name ?? DEFAULT_PROC_NAME;
  let port = parsed.port;
  if (parsed.restart) {
    const store = openProcs(env);
    const row = (() => {
      try {
        return readProc(store, parsed.restart);
      } finally {
        store.close();
      }
    })();
    const extra = row ? readExtra(env, row.id) : null;
    if (!row || !extra?.argv)
      return emit(io, fail("invalid_input", `no registered process ${parsed.restart} to restart`));
    const stopped = await stopProcesses({ ids: [row.id] }, "restart", {
      env,
      actor: actorFromEnv(env),
      caller: agent,
    });
    const refused = [...stopped.failed, ...stopped.skipped].find(
      (entry) => entry.id === row.id && !entry.reason.startsWith("already ended"),
    );
    if (refused)
      return emit(io, fail("blocked", `could not stop ${row.id} to restart it: ${refused.reason}`));
    argvToRun = extra.argv;
    cwd = row.cwd;
    name = parsed.name ?? extra.name;
    port = parsed.port ?? row.port;
  }

  const dirs = gitDirs(cwd);
  const repo = dirs ? realpath(dirs.commonDir) : null;
  const top = dirs?.top ? realpath(dirs.top) : null;
  const kind = procKind(argvToRun);

  if (repo && kind !== "docker") {
    const store = openProcs(env);
    let live;
    try {
      live = serverFor(store, env, repo, name);
    } finally {
      store.close();
    }
    if (live) {
      const liveTop = gitDirs(live.cwd)?.top;
      if (liveTop && top && realpath(liveTop) === top)
        return emit(
          io,
          ok<Started>({
            id: live.id,
            pid: live.pid,
            port: live.port ?? portInLog(readLog(procLogFile(env, live.id))),
            log: procLogFile(env, live.id),
            name,
            existing: true,
          }),
          startedLines,
        );
      return emit(
        io,
        fail(
          "blocked",
          `a ${name} server of this repo already runs in another checkout: ${live.id} in ${live.cwd} [${live.branch ?? "detached"}], owner ${live.session ?? "a terminal"}`,
          {
            data: { id: live.id, cwd: live.cwd, branch: live.branch, owner: live.session },
            unblock: `use that one, stop it (workit stop ${live.id}), or start this one under another --name`,
          },
        ),
      );
    }
  }

  const workspace = await workspaceResources(io);
  const sources = [
    { label: "workspaces.json", trust: "machine" as const, value: workspace.value },
    { label: CHECKS_FILE, trust: "repo" as const, value: loadCheckConfig(cwd).resources },
  ];
  const id = newProcId();
  const owner = agent === null ? null : runDeps.hostPid();
  if (parsed.noLease) {
    const recorded = appendObserved(cwd, {
      type: "proc.no_lease",
      actor: actorFromEnv(env),
      proc: id,
      cmd: argvToRun.join(" "),
      reason: parsed.reason,
    });
    if (!recorded.ok)
      return emit(
        io,
        fail("unavailable", `--no-lease needs its reason in the ledger: ${recorded.error}`),
      );
  }
  updateExtra(env, id, {
    name,
    state: "starting",
    argv: argvToRun,
    hostPidStart: owner === null ? null : procTree.start(owner),
  });
  const spec: SupervisorSpec = {
    id,
    argv: argvToRun,
    cwd,
    name,
    kind,
    port,
    session: acting.session,
    lead: acting.session ? leadOf(acting.session) : null,
    host: real.kind === "none" ? null : (acting.host ?? real.host),
    hostPid: owner,
    repo,
    branch: top ? currentBranch(top) : null,
    noLease: parsed.noLease,
    sources,
    expectedRssBytes: EXPECTED_RSS_BYTES,
    sampleMs: runDeps.sampleMs,
    ceilingBytes: runDeps.ceilingBytes,
  };
  const [command, ...args] = runDeps.supervisor();
  try {
    spawn(command, args, {
      cwd,
      env: { ...env, [SUPERVISE_ENV]: JSON.stringify(spec) },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch (error) {
    return emit(io, fail("failed", `could not start the supervisor: ${(error as Error).message}`));
  }

  const log = procLogFile(env, id);
  const started = Date.now();
  let runningSince: number | null = null;
  while (Date.now() - started < runDeps.startBoundMs) {
    await runDeps.sleep(100);
    const extra = readExtra(env, id);
    if (extra?.state === "refused")
      return emit(
        io,
        fail("blocked", extra.message ?? "the heavy budget refused the start", {
          data: { id },
          ...(extra.unblock ? { unblock: extra.unblock } : {}),
        }),
      );
    if (extra?.state === "failed")
      return emit(io, fail("failed", extra.message ?? "the start failed", { data: { id } }));
    if (extra?.state === "exited") {
      // Ruling H: it ended inside the start bound, so it was no server: its output and exit code.
      const output = readLog(log);
      const code = extra.exitCode ?? 1;
      if (io.json)
        io.stdout(
          `${JSON.stringify({ ok: code === 0, code: code === 0 ? "ok" : "failed", data: { id, exited: true, exitCode: code, output } })}\n`,
        );
      else {
        io.stdout(output);
        io.stderr(
          `workit: ${argvToRun.join(" ")} exited ${code} within the start bound; nothing left running\n`,
        );
      }
      return code;
    }
    if (extra?.state !== "running") continue;
    runningSince ??= Date.now();
    const seen = portInLog(readLog(log));
    // `docker run -d` exits at once and leaves its containers running under the row.
    const detached = extra.exitCode !== null;
    if (
      seen !== null ||
      detached ||
      (port !== null && Date.now() - runningSince >= runDeps.settleMs)
    ) {
      const store = openProcs(env);
      try {
        const row =
          port === null && seen !== null
            ? upsertProc(store, id, () => ({ port: seen }))
            : readProc(store, id);
        return emit(
          io,
          ok<Started>({
            id,
            pid: row?.pid ?? null,
            port: port ?? seen,
            log,
            name,
            existing: false,
          }),
          startedLines,
        );
      } finally {
        store.close();
      }
    }
  }
  const extra = readExtra(env, id);
  if (extra?.state !== "running")
    return emit(
      io,
      fail("failed", `the supervisor did not start ${argvToRun.join(" ")} within the start bound`, {
        data: { id },
      }),
    );
  const store = openProcs(env);
  try {
    const row = readProc(store, id);
    return emit(
      io,
      ok<Started>({
        id,
        pid: row?.pid ?? null,
        port,
        log,
        name: procName(env, row!),
        existing: false,
      }),
      startedLines,
    );
  } finally {
    store.close();
  }
}
