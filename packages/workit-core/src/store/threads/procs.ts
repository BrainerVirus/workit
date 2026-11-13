// The `procs` table (docs/specs/threads.md#v1): rows of the process registry
// (#328). Every write is a read-modify-write inside one BEGIN IMMEDIATE
// transaction, so two processes changing one row never lose an update.
import type { SqlParams, SqlRow } from "./sqlite";
import type { ThreadsStore } from "./store";

export type ProcKind = "server" | "docker" | "browser" | "other";

export type ProcRow = {
  id: string;
  session: string | null;
  lead: string | null;
  host: string | null;
  hostPid: number | null;
  /** The repo's git common dir. */
  repo: string | null;
  cwd: string;
  branch: string | null;
  pgid: number | null;
  pid: number | null;
  pidStart: string | null;
  cmd: string;
  kind: ProcKind;
  port: number | null;
  startedAt: string;
  rss: number | null;
  rssAt: string | null;
  keep: boolean;
  keepRef: string | null;
  endedAt: string | null;
  endReason: string | null;
};

/** A new row needs these; every other field defaults to null (keep to false). */
type ProcRequired = Pick<ProcRow, "cwd" | "cmd" | "kind" | "startedAt">;
export type ProcPatch = Partial<Omit<ProcRow, "id">>;

const COLUMNS = {
  session: "session",
  lead: "lead",
  host: "host",
  hostPid: "host_pid",
  repo: "repo",
  cwd: "cwd",
  branch: "branch",
  pgid: "pgid",
  pid: "pid",
  pidStart: "pid_start",
  cmd: "cmd",
  kind: "kind",
  port: "port",
  startedAt: "started_at",
  rss: "rss",
  rssAt: "rss_at",
  keep: "keep",
  keepRef: "keep_ref",
  endedAt: "ended_at",
  endReason: "end_reason",
} as const satisfies Record<keyof ProcPatch, string>;

type Field = keyof typeof COLUMNS;
const FIELDS = Object.keys(COLUMNS) as Field[];

const text = (value: unknown): string | null => (value == null ? null : String(value));
const integer = (value: unknown): number | null => (value == null ? null : Number(value));

const fromRow = (row: SqlRow): ProcRow => ({
  id: String(row.id),
  session: text(row.session),
  lead: text(row.lead),
  host: text(row.host),
  hostPid: integer(row.host_pid),
  repo: text(row.repo),
  cwd: String(row.cwd),
  branch: text(row.branch),
  pgid: integer(row.pgid),
  pid: integer(row.pid),
  pidStart: text(row.pid_start),
  cmd: String(row.cmd),
  kind: String(row.kind) as ProcKind,
  port: integer(row.port),
  startedAt: String(row.started_at),
  rss: integer(row.rss),
  rssAt: text(row.rss_at),
  keep: Number(row.keep) === 1,
  keepRef: text(row.keep_ref),
  endedAt: text(row.ended_at),
  endReason: text(row.end_reason),
});

const bind = (field: Field, value: unknown): SqlParams[string] => {
  if (value == null) return null;
  if (field === "keep") return value ? 1 : 0;
  return typeof value === "number" ? value : String(value);
};

const select = (store: ThreadsStore, id: string): ProcRow | undefined => {
  const row = store.db.get("SELECT * FROM procs WHERE id = $id", { id });
  return row ? fromRow(row) : undefined;
};

/** The row for `id`, if any. */
export const readProc = (store: ThreadsStore, id: string): ProcRow | undefined => select(store, id);

/**
 * Inserts or changes the row `id`. `change` sees the row as committed (or
 * undefined when there is none) under the write lock and returns the fields to
 * set; a new row's patch must carry cwd, cmd, kind and startedAt. Returns the
 * row as written.
 */
export const upsertProc = (
  store: ThreadsStore,
  id: string,
  change: (current: ProcRow | undefined) => ProcPatch,
): ProcRow =>
  store.write(() => {
    const current = select(store, id);
    const patch = change(current);
    const fields = FIELDS.filter((field) => patch[field] !== undefined);
    const params: SqlParams = { id };
    for (const field of fields) params[field] = bind(field, patch[field]);
    if (current) {
      if (fields.length)
        store.db.run(
          `UPDATE procs SET ${fields.map((field) => `${COLUMNS[field]} = $${field}`).join(", ")} WHERE id = $id`,
          params,
        );
    } else {
      const missing = (["cwd", "cmd", "kind", "startedAt"] as (keyof ProcRequired)[]).filter(
        (field) => patch[field] == null,
      );
      if (missing.length) throw new Error(`a new procs row ${id} needs ${missing.join(", ")}`);
      store.db.run(
        `INSERT INTO procs (id, ${fields.map((field) => COLUMNS[field]).join(", ")}) ` +
          `VALUES ($id, ${fields.map((field) => `$${field}`).join(", ")})`,
        params,
      );
    }
    return select(store, id) as ProcRow;
  });
