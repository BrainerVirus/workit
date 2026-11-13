// `workit ps [--all]` (#328): the registered background processes: id, name,
// kind, pid, port, RSS, owner session, age and directory. Rows whose process
// is gone are ended first; `--all` adds the recently ended ones.
import {
  openProcs,
  procLogFile,
  procName,
  recentProcs,
  settleProcs,
  type ProcRow,
} from "@workit-dev/core/src/core/procs";
import { formatBytes } from "@workit-dev/core/src/core/resources";
import { emit, fail, ok, type Io } from "../output";

const USAGE = "workit ps [--all]";

type Listed = ProcRow & { name: string; log: string };

const age = (since: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3_600)}h`;
};

const line = (row: Listed, now: number): string =>
  [
    row.id,
    row.name,
    row.kind,
    `pid ${row.pid ?? "?"}`,
    `port ${row.port ?? "-"}`,
    `rss ${row.rss === null ? "?" : formatBytes(row.rss)}`,
    `owner ${row.session ?? "terminal"}`,
    row.endedAt ? `ended ${row.endReason ?? ""}`.trim() : `up ${age(row.startedAt, now)}`,
    ...(row.keep ? ["kept"] : []),
    row.cwd,
    `-- ${row.cmd}`,
  ].join("  ");

export async function run(argv: string[], io: Io): Promise<number> {
  const unknown = argv.find((arg) => arg !== "--all" && arg !== "--json");
  if (unknown) return emit(io, fail("invalid_input", `unknown argument ${unknown}: ${USAGE}`));
  const all = argv.includes("--all");
  let store;
  try {
    store = openProcs(io.env);
  } catch (error) {
    return emit(io, fail("unavailable", (error as Error).message));
  }
  try {
    const live = settleProcs(store, io.env);
    const rows = all ? recentProcs(store) : live;
    const listed: Listed[] = rows.map((row) => ({
      ...row,
      name: procName(io.env, row),
      log: procLogFile(io.env, row.id),
    }));
    const now = Date.now();
    return emit(io, ok({ processes: listed }), (data) =>
      data.processes.length
        ? data.processes.map((row) => line(row, now))
        : [`no registered background processes${all ? "" : " running"}`],
    );
  } finally {
    store.close();
  }
}
