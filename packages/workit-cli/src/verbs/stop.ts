// `workit stop <id>… | --session <s> | --within <dir> | --orphans [--reason "<why>"]` (#328):
// stop registered background processes. SIGTERM to the process group, 10 s,
// then SIGKILL, each after checking the leader is still the recorded process;
// docker rows stop exactly their containers. Each stop writes a `proc.stopped`
// ledger row with the reason.
//
// Naming an id stops that row even when it is kept or was started from a
// terminal; --session and --within skip those, saying why. An agent stops only
// rows its own session family started. --orphans stops rows whose owner's
// host process is gone (never by heartbeat age).
import path from "node:path";
import { actorFromEnv } from "@workit-dev/core/src/ledger";
import { hostSessionFromEnv, realHostSession } from "@workit-dev/core/src/host-session";
import {
  reapOrphans,
  stopProcesses,
  type OrphanReport,
  type StopReport,
} from "@workit-dev/core/src/core/procs";
import { emit, fail, ok, type Io } from "../output";

const USAGE = 'workit stop <id>… | --session <s> | --within <dir> | --orphans [--reason "<why>"]';

type Parsed = {
  ids: string[];
  session: string | null;
  within: string | null;
  orphans: boolean;
  reason: string | null;
};

function parse(argv: string[]): Parsed | string {
  const parsed: Parsed = { ids: [], session: null, within: null, orphans: false, reason: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string | null => {
      const next = argv[index + 1];
      index += 1;
      return next === undefined || next.startsWith("--") ? null : next;
    };
    if (arg === "--json") continue;
    if (arg === "--") {
      // Everything after -- is an id, even one that starts with a dash.
      parsed.ids.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--orphans") parsed.orphans = true;
    else if (arg === "--session") {
      parsed.session = value();
      if (!parsed.session) return "--session takes a session id";
    } else if (arg === "--within") {
      parsed.within = value();
      if (!parsed.within) return "--within takes a directory";
    } else if (arg === "--reason") {
      parsed.reason = value();
      if (!parsed.reason) return '--reason takes "<why>"';
    } else if (arg.startsWith("-")) return `unknown argument ${arg}`;
    else parsed.ids.push(arg);
  }
  const forms = [
    parsed.ids.length > 0,
    parsed.session !== null,
    parsed.within !== null,
    parsed.orphans,
  ].filter(Boolean).length;
  if (forms === 0) return "name what to stop";
  if (forms > 1) return "pass ids, --session, --within or --orphans, one of them";
  return parsed;
}

const stopLines = (data: StopReport & Partial<OrphanReport>): string[] => [
  ...(data.orphans ?? []).map((entry) => `orphan ${entry.id}: ${entry.reason} -- ${entry.cmd}`),
  ...data.stopped.map(
    (entry) =>
      `${entry.outcome === "stopped" ? `stopped (${entry.signal})` : entry.outcome === "reused" ? "ended; its pid now belongs to another process, nothing signalled" : "already gone; ended"} ${entry.id} -- ${entry.cmd}${entry.containers.length ? ` [containers ${entry.containers.map((id) => id.slice(0, 12)).join(", ")}]` : ""}${"error" in entry.recorded ? ` (ledger: not recorded: ${entry.recorded.error})` : ""}`,
  ),
  ...data.skipped.map((entry) => `skipped ${entry.id}: ${entry.reason}`),
  ...(data.unknown ?? []).map((entry) => `listed ${entry.id}: ${entry.reason}`),
  ...data.failed.map((entry) => `not stopped ${entry.id}: ${entry.reason}`),
  ...(data.stopped.length + data.skipped.length + data.failed.length + (data.unknown?.length ?? 0)
    ? []
    : ["nothing to stop"]),
];

export async function run(argv: string[], io: Io): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") return emit(io, fail("invalid_input", `${parsed}: ${USAGE}`));
  const real = realHostSession(io.env);
  const context = {
    env: io.env,
    actor: actorFromEnv(io.env),
    caller: real.kind === "none" ? null : hostSessionFromEnv(io.env).session,
  };
  let report: StopReport & Partial<OrphanReport>;
  try {
    if (parsed.orphans)
      report = await reapOrphans({ ...context, apply: true, reason: parsed.reason ?? "orphan" });
    else
      report = await stopProcesses(
        {
          ...(parsed.ids.length ? { ids: parsed.ids } : {}),
          ...(parsed.session !== null ? { session: parsed.session } : {}),
          ...(parsed.within !== null ? { within: path.resolve(io.cwd, parsed.within) } : {}),
        },
        parsed.reason ?? "stopped by workit stop",
        context,
      );
  } catch (error) {
    return emit(io, fail("unavailable", (error as Error).message));
  }
  // An id that names nothing, or a stop that failed, is an error; skipping a kept row is not.
  const missed =
    report.failed.length > 0 ||
    (parsed.ids.length > 0 &&
      report.skipped.some((entry) => entry.reason === "no such registered process"));
  if (missed && !io.json) {
    for (const text of stopLines(report)) io.stderr(`${text}\n`);
    return emit(io, fail("failed", "some processes were not stopped", { data: report }));
  }
  if (missed) return emit(io, fail("failed", "some processes were not stopped", { data: report }));
  return emit(io, ok(report), stopLines);
}
