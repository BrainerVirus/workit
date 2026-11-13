// The per-user threads store (docs/specs/threads.md): `<state>/threads.db`,
// mode 0600, WAL, a busy timeout, forward-only migrations in BEGIN IMMEDIATE,
// and a refusal (before any write) of a schema newer than this build knows.
//
// No hook loads this module (docs/specs/threads.md#hooks).
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../../core/workit-paths.mjs";
import { isBusy, isNotDatabase, openSqlite, type SqlDb } from "./sqlite";

export const THREADS_DB = "threads.db";

/** How long a writer waits for another process's write lock by default. */
export const BUSY_TIMEOUT_MS = 5000;

/** Each entry migrates from the version before it; index 0 makes v1. Forward-only. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE procs (
     id TEXT PRIMARY KEY,
     session TEXT,
     lead TEXT,
     host TEXT,
     host_pid INTEGER,
     repo TEXT,
     cwd TEXT NOT NULL,
     branch TEXT,
     pgid INTEGER,
     pid INTEGER,
     pid_start TEXT,
     cmd TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('server', 'docker', 'browser', 'other')),
     port INTEGER,
     started_at TEXT NOT NULL,
     rss INTEGER,
     rss_at TEXT,
     keep INTEGER NOT NULL DEFAULT 0,
     keep_ref TEXT,
     ended_at TEXT,
     end_reason TEXT
   );
   CREATE INDEX procs_session ON procs (session);
   CREATE INDEX procs_repo ON procs (repo);`,
];

/** The schema version this build writes and the newest it opens. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** A DB from a newer Workit: refused before anything is written. */
export class ThreadsSchemaError extends Error {
  constructor(
    readonly file: string,
    readonly found: number,
  ) {
    super(
      `${file} is at schema v${found}, and this Workit knows only up to v${SCHEMA_VERSION}: ` +
        `it was written by a newer Workit. Upgrade Workit (\`workit upgrade\`) to open it; ` +
        `nothing was written.`,
    );
    this.name = "ThreadsSchemaError";
  }
}

export type UnsafeReason = "symlink" | "not-file" | "owner" | "mode" | "not-database";

/**
 * A threads.db (or its -wal or -shm file) Workit will not open: a symbolic
 * link, not a regular file, another user's, open to group or other, or not a
 * SQLite database. The store decides which processes the registry signals, so
 * it never follows, repairs or reuses such a file silently.
 */
export class ThreadsUnsafeError extends Error {
  constructor(
    readonly file: string,
    readonly reason: UnsafeReason,
    detail: string,
    fix: string,
    options?: { cause?: unknown },
  ) {
    super(`${file} is not safe to open: ${detail}. Fix: ${fix}. Nothing was opened.`, options);
    this.name = "ThreadsUnsafeError";
  }
}

/** Another process held the write lock past the busy timeout. */
export class ThreadsBusyError extends Error {
  constructor(
    readonly file: string,
    readonly waitedMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `${file} is busy: another Workit process held its write lock for over ${waitedMs} ms. ` +
        `Retry the command; nothing was written.`,
      options,
    );
    this.name = "ThreadsBusyError";
  }
}

export type ThreadsStore = {
  readonly file: string;
  readonly db: SqlDb;
  /** Runs `body` in one BEGIN IMMEDIATE transaction: committed when it returns, rolled back when it throws. */
  write<T>(body: (db: SqlDb) => T): T;
  close(): void;
};

export type OpenOptions = {
  /** Resolves the state dir (WORKIT_STATE_DIR, XDG_STATE_HOME, the platform default). */
  env?: NodeJS.ProcessEnv;
  /** How long a writer waits for the write lock before ThreadsBusyError. */
  busyTimeoutMs?: number;
};

/** `<state>/threads.db` for `env`. */
export const threadsDbFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(stateDir(env), THREADS_DB);

/** Creates the file mode 0600 when missing; another process creating it first is fine. */
const createPrivate = (file: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // O_CREAT | O_EXCL: never follows a link at `file`, dangling or not.
    fs.closeSync(fs.openSync(file, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};

const moveAside = (file: string): string => `move it aside (\`mv ${file} ${file}.unsafe\`)`;

/**
 * Refuses `file` unless it is absent (`required` false) or a regular file,
 * not a link, owned by this user, with no group or other mode bits. Windows
 * has no POSIX mode or uid (the file inherits the state dir's ACL), so only
 * the link and file-type checks apply there.
 */
const checkSafe = (file: string, required: boolean): void => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new ThreadsUnsafeError(
      file,
      "symlink",
      "it is a symbolic link, which Workit never follows",
      `remove the link (\`rm ${file}\`); Workit then creates its own file`,
    );
  if (!stat.isFile())
    throw new ThreadsUnsafeError(file, "not-file", "it is not a regular file", moveAside(file));
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new ThreadsUnsafeError(
      file,
      "owner",
      `it is owned by uid ${stat.uid}, not by this user (uid ${uid})`,
      moveAside(file),
    );
  const mode = stat.mode & 0o777;
  if (mode & 0o077)
    throw new ThreadsUnsafeError(
      file,
      "mode",
      `its mode is ${mode.toString(8).padStart(4, "0")}, open to group or other`,
      `\`chmod 600 ${file}\``,
    );
};

/** The DB file and the -wal and -shm files SQLite keeps beside it, each checked before SQLite opens them. */
const checkStoreFiles = (file: string): void => {
  checkSafe(file, true);
  checkSafe(`${file}-wal`, false);
  checkSafe(`${file}-shm`, false);
};

/** The file's schema version: 0 before the first migration. */
const schemaVersion = (db: SqlDb): number => {
  const meta = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (!meta) return 0;
  const row = db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : 0;
};

const transaction = <T>(db: SqlDb, file: string, waitMs: number, body: () => T): T => {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusy(error)) throw new ThreadsBusyError(file, waitMs, { cause: error });
    throw error;
  }
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // SQLite may already have rolled back (a busy COMMIT, an I/O error).
    try {
      db.exec("ROLLBACK");
    } catch {}
    if (isBusy(error)) throw new ThreadsBusyError(file, waitMs, { cause: error });
    throw error;
  }
};

const migrate = (db: SqlDb, file: string, waitMs: number): void =>
  transaction(db, file, waitMs, () => {
    // Read again under the write lock: another process may have migrated first.
    const found = schemaVersion(db);
    if (found > SCHEMA_VERSION) throw new ThreadsSchemaError(file, found);
    for (let version = found + 1; version <= SCHEMA_VERSION; version++)
      db.exec(MIGRATIONS[version - 1]);
    db.run(
      "INSERT INTO meta (key, value) VALUES ('schema_version', $version) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      { version: String(SCHEMA_VERSION) },
    );
  });

/**
 * Opens (creating and migrating when needed) the threads store. Throws
 * ThreadsUnsafeError for a file it will not trust (checked before SQLite
 * opens it), ThreadsSchemaError for a file from a newer Workit, having
 * written nothing, and ThreadsBusyError when another process holds the write
 * lock too long.
 */
export const openThreadsStore = (options: OpenOptions = {}): ThreadsStore => {
  const file = threadsDbFile(options.env ?? process.env);
  const waitMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  createPrivate(file);
  checkStoreFiles(file);
  const db = openSqlite(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(waitMs))}`);
    // Refuse a newer file before the WAL switch, which would rewrite its header.
    const found = schemaVersion(db);
    if (found > SCHEMA_VERSION) throw new ThreadsSchemaError(file, found);
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      if (isBusy(error)) throw new ThreadsBusyError(file, waitMs, { cause: error });
      throw error;
    }
    if (found < SCHEMA_VERSION) migrate(db, file, waitMs);
  } catch (error) {
    db.close();
    if (isNotDatabase(error))
      throw new ThreadsUnsafeError(
        file,
        "not-database",
        "it is not a SQLite database, or it is damaged",
        `${moveAside(file)}; Workit then creates a new one`,
        { cause: error },
      );
    throw error;
  }
  return {
    file,
    db,
    write: (body) => transaction(db, file, waitMs, () => body(db)),
    close: () => db.close(),
  };
};
