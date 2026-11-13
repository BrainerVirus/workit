// One synchronous SQLite surface over the runtime's built-in driver
// (docs/specs/threads.md#runtimes): `bun:sqlite` under Bun, `node:sqlite`
// under Node >= 24. Both load through `process.getBuiltinModule`, never a
// static import, so one source bundles for either target.
//
// Named parameters are bare object keys bound to `$name` in SQL on both
// drivers (Bun needs `strict: true` for that).

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue>;
export type SqlRow = Record<string, SqlValue>;

export type SqlDb = {
  /** Runs one or more statements with no parameters. */
  exec(sql: string): void;
  /** Runs one statement; returns the number of rows changed. */
  run(sql: string, params?: SqlParams): number;
  get(sql: string, params?: SqlParams): SqlRow | undefined;
  all(sql: string, params?: SqlParams): SqlRow[];
  close(): void;
};

type Statement = {
  run(params?: SqlParams): { changes: number | bigint };
  get(params?: SqlParams): unknown;
  all(params?: SqlParams): unknown[];
};
type Connection = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};
type Driver = (file: string) => Connection;

/** The message Node prints while `node:sqlite` is still experimental. */
const SQLITE_EXPERIMENTAL = /^SQLite is an experimental feature/u;

const warningName = (warning: string | Error, rest: unknown[]): string | undefined => {
  if (warning instanceof Error) return warning.name;
  const [type] = rest;
  if (typeof type === "string") return type;
  if (type && typeof type === "object" && "type" in type) return String(type.type);
  return undefined;
};

/** Runs `load` with Node's SQLite ExperimentalWarning dropped; every other warning still goes out. */
const withoutSqliteWarning = <T>(load: () => T): T => {
  // The original function itself (not a bound copy), so `finally` puts back exactly it.
  const emit: typeof process.emitWarning = Reflect.get(process, "emitWarning");
  const filtered = (warning: string | Error, ...rest: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning;
    if (warningName(warning, rest) === "ExperimentalWarning" && SQLITE_EXPERIMENTAL.test(message))
      return;
    return Reflect.apply(emit, process, [warning, ...rest]);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = emit;
  }
};

const builtin = (id: string): unknown => (process.getBuiltinModule as (id: string) => unknown)(id);

const bunDriver = (): Driver => {
  const { Database } = builtin("bun:sqlite") as {
    Database: new (file: string, options: { strict: boolean }) => Connection;
  };
  return (file) => new Database(file, { strict: true });
};

const nodeDriver = (): Driver => {
  const loaded = withoutSqliteWarning(() => builtin("node:sqlite")) as
    | { DatabaseSync: new (file: string) => Connection }
    | undefined;
  if (!loaded?.DatabaseSync)
    throw new Error(
      `this Node (${process.version}) has no node:sqlite; Workit's store needs Node 24 or later`,
    );
  return (file) => new loaded.DatabaseSync(file);
};

let driver: Driver | undefined;
const loadDriver = (): Driver => (driver ??= process.versions.bun ? bunDriver() : nodeDriver());

/** Opens `file` (created when missing) with the runtime's SQLite. */
export const openSqlite = (file: string): SqlDb => {
  const connection = loadDriver()(file);
  const prepare = (sql: string) => connection.prepare(sql);
  return {
    exec: (sql) => connection.exec(sql),
    run: (sql, params = {}) => Number(prepare(sql).run(params).changes),
    get: (sql, params = {}) => (prepare(sql).get(params) ?? undefined) as SqlRow | undefined,
    all: (sql, params = {}) => prepare(sql).all(params) as SqlRow[],
    close: () => connection.close(),
  };
};

/** True for SQLite's SQLITE_BUSY (5) and SQLITE_LOCKED (6), as either driver reports them. */
export const isBusy = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const fields = error as Error & { code?: unknown; errno?: unknown; errcode?: unknown };
  const primary = Number(fields.errcode ?? fields.errno) & 0xff;
  if (primary === 5 || primary === 6) return true;
  if (fields.code === "SQLITE_BUSY" || fields.code === "SQLITE_LOCKED") return true;
  return /database is locked|database table is locked/u.test(error.message);
};
