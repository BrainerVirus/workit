// The read side of the task store (layout and design: task-store.ts).
//
// TaskReader lists, reads and resolves tasks and has no task-engine write
// path: no event appends, task or workspace writes, binding, compaction or
// 2.x migration. Per-turn hooks use it so their bundle carries none of that
// (#807). It keeps the side effects a read had before the split: the
// listing cache (task-index.json) is refreshed, and a pre-git 3.x store is
// moved into the git store under the checkout lock. A pending 2.x store is
// reported as `needs_input` (MIGRATION_PENDING); TaskStore (task-store.ts),
// which extends this class, migrates it.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import {
  acquireFileLockSync,
  type FileLockSyncHandle,
  type FileLockSyncAcquireOptions,
} from "@openclaw/fs-safe/file-lock";
import { packageRoot } from "./package-root";
import {
  SCHEMA_VERSION,
  canonicalJson,
  failure,
  newId,
  newRevision,
  parseStoredRecord,
  success,
  taskRecordSchema,
  workspaceRecordSchema,
  idRefPattern,
  resolveIdRef,
  type Id,
  type Provenance,
  type Result,
  type Revision,
  type TaskRecord,
  type Utc,
  type WorkspaceRecord,
} from "./task-contract";
import {
  TASK_STORE_LOCK,
  classifyLockOwner,
  clearAbandonedReclaimGuard,
  defaultLockTimeout,
  localLockHost,
  parseMetadataLockOrNull,
  processStartOf,
  type MetadataLock,
} from "./store-lock";
import {
  LogDamage,
  isTransientWindowsError,
  readLog,
  replaceFile,
  retryTransient,
  type LogRead,
} from "../store/event-log";
import {
  checkoutRootOf,
  checkoutSlug,
  branchRenames,
  followRenames,
  resolveStore,
  resolveTaskKey,
  type StoreLocation,
  type TaskKey,
} from "../store/paths";
import {
  OPENING_TYPES,
  reduce,
  type BlobStore,
  type LegacyOrigin,
  type ReducedTask,
} from "../store/reduce";
import { reportMigration } from "../store/notes";

/** Prefix of the `needs_input` error a read gets while a migration is pending. */
export const MIGRATION_PENDING = "workit migration pending";

export type { TaskKey } from "../store/paths";

/** The store format this runtime writes; a newer marker fails closed. */
export const STORE_FORMAT = 3;
/** The runtime version 2.x readers are told to upgrade to. */
export const STORE_MIN_RUNTIME = "3.0.0";

/** readV2Workspace's answer for a 3.x marker at `.workit/workspace.json`. */
export const TOMBSTONE = Symbol("tombstone");

/** One task's listing facts, kept in `task-index.json` so per-turn host
 * hooks can find a session's task without replaying every log. */
export type TaskIndexEntry = {
  id: Id;
  revision: Revision;
  status: TaskRecord["status"];
  createdAt: Utc;
  updatedAt: Utc;
  objective: string;
  source: { host: string; kind: Provenance["kind"] };
  progress: { summary: string; nextAction: string | null };
  /** Host sessions bound to the task: the intent session (workerId null) and worker sessions. */
  sessions: { host: string; handle: string; workerId: Id | null }[];
  /** The checkout workspace the task belongs to. */
  workspaceId: Id;
  /** The implicit-task key (branch) the task is bound to, if any. */
  key: string | null;
  branch: string | null;
  /** When the task was bound to `key`. */
  boundAt: string | null;
  /** Migrated from a 2.x store. */
  legacy: boolean;
  /** Stat signature of the task's event log the entry was derived from. */
  file: string;
};
const INDEX_VERSION = 3;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hostSession = (value: unknown): { host: string; handle: string } | null =>
  isObject(value) &&
  value.kind === "host" &&
  typeof value.host === "string" &&
  typeof value.handle === "string"
    ? { host: value.host, handle: value.handle }
    : null;
export const indexEntry = (
  task: TaskRecord,
  key: TaskKey | null,
  legacy: boolean,
  file: string,
): TaskIndexEntry => {
  const sessions: TaskIndexEntry["sessions"] = [];
  const intent = hostSession(task.intent.provenance.session);
  if (intent) sessions.push({ ...intent, workerId: null });
  for (const worker of task.workers) {
    const session = hostSession(worker.data.session);
    if (session) sessions.push({ ...session, workerId: worker.id });
  }
  return {
    id: task.id,
    revision: task.revision,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    objective: task.intent.data.objective,
    source: { host: task.intent.provenance.host, kind: task.intent.provenance.kind },
    progress: { summary: task.progress.summary, nextAction: task.progress.nextAction },
    sessions,
    workspaceId: task.workspaceId,
    key: key?.key ?? null,
    branch: key?.branch ?? null,
    boundAt: key?.boundAt ?? null,
    legacy,
    file,
  };
};

/** Cheap change detector for a file. An append-only log changes size on
 * every write; see `racySignature` for the timestamp-granularity caveat. */
export const fileSignature = (file: string): string | null => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
};
const RACY_WINDOW_NS = 2_000_000_000n;
/** Like Git's racy-index rule: a file changed within the timestamp-granularity
 * window may be rewritten again without changing its signature, so callers
 * must re-read it instead of trusting a cached signature. */
export const racySignature = (signature: string): boolean => {
  // ctime catches content written with a back-dated mtime (cp -p, touch -d).
  const [mtime = 0n, ctime = 0n] = signature.split(":").slice(3, 5).map(BigInt);
  const changed = mtime > ctime ? mtime : ctime;
  return BigInt(Date.now()) * 1_000_000n - changed < RACY_WINDOW_NS;
};

const oldestFirst = (left: TaskIndexEntry, right: TaskIndexEntry): number =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

let cachedRuntimeVersion: string | null = null;
/** Version of the package that hosts this runtime; recorded with state so a
 * bug report can identify the writer version without reading raw state. */
export const runtimeVersion = (): string => {
  if (cachedRuntimeVersion === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
        version?: unknown;
      };
      cachedRuntimeVersion = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
    } catch {
      cachedRuntimeVersion = "0.0.0";
    }
  }
  return cachedRuntimeVersion;
};

export const isNewerVersion = (candidate: string, current: string): boolean => {
  const parts = (value: string) =>
    value
      .split("-")[0]
      .split(".")
      .map((item) => Number.parseInt(item, 10) || 0);
  const [candidateParts, currentParts] = [parts(candidate), parts(current)];
  for (let index = 0; index < 3; index += 1) {
    const left = candidateParts[index] ?? 0;
    const right = currentParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
};
export const validId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** `<old> <new> <ident> <unix seconds> <tz>\t<message>`: new sha, seconds, message. */
const REFLOG_LINE = /^[0-9a-f]+ ([0-9a-f]+) .* (\d+) [+-]\d{4}\t(.*)$/u;

/**
 * The branch `branch` was cut from, read from git's reflogs (no git process).
 * Only the branch log's first line counts, and only when it is the creation
 * entry "branch: Created from <start>": an expired, rewritten or missing log
 * says nothing. A branch created from HEAD takes
 * the worktree HEAD log's checkout made by that creation (same new sha, same
 * or next second) onto the branch or one of its earlier names (`aliases`, it
 * may have been renamed since). A remote start (`origin/develop`) is
 * returned as written.
 */
const branchStart = (
  location: StoreLocation,
  branch: string,
  aliases: readonly string[],
): string | null => {
  const first = readText(
    path.join(path.dirname(location.dir), "logs", "refs", "heads", branch),
  ).split("\n", 1)[0];
  // A "Created from" message only ever starts a log (git deletes the log
  // with the branch), so the first line alone decides.
  const created = REFLOG_LINE.exec(first);
  const start = created && /^branch: Created from (\S+)$/u.exec(created[3])?.[1];
  if (!created || !start) return null;
  if (start !== "HEAD") return start;
  if (!location.git) return null;
  for (const line of readText(path.join(location.git.gitDir, "logs", "HEAD")).split("\n")) {
    const entry = REFLOG_LINE.exec(line);
    const moved = entry && /^checkout: moving from (\S+) to (\S+)$/u.exec(entry[3]);
    const seconds = entry ? Number(entry[2]) - Number(created[2]) : -1;
    if (
      moved &&
      entry[1] === created[1] &&
      seconds >= 0 &&
      seconds <= 1 &&
      aliases.includes(moved[2])
    )
      return moved[1];
  }
  return null;
};

/** Whether `ref` (`refs/remotes/origin/develop`) exists, loose or packed. */
const refExists = (common: string, ref: string): boolean =>
  fs.existsSync(path.join(common, ref)) ||
  readText(path.join(common, "packed-refs")).includes(` ${ref}\n`);

/** Resolved bases per checkout and branch, reused while the reflogs they came
 * from are unchanged (one entry per branch a process looked at). */
const origins = new Map<
  string,
  { signature: string; name: string | null; renames: ReturnType<typeof branchRenames> }
>();
export const sameDirectoryIdentity = (left: string, right: string): boolean => {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  try {
    const a = fs.statSync(normalizedLeft, { bigint: true });
    const b = fs.statSync(normalizedRight, { bigint: true });
    if (!a.isDirectory() || !b.isDirectory()) return false;
    if (
      process.platform === "win32"
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight
    )
      return true;
    const canonicalLeft = fs.realpathSync(normalizedLeft);
    const canonicalRight = fs.realpathSync(normalizedRight);
    if (
      process.platform === "win32"
        ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
        : canonicalLeft === canonicalRight
    )
      return true;
    return a.dev === b.dev && a.ino !== 0n && a.ino === b.ino;
  } catch {
    return false;
  }
};

/** Locks this process holds; waiting on them can only time out. */
const heldInProcess = new Map<string, number>();
const hold = (lock: string) => heldInProcess.set(lock, (heldInProcess.get(lock) ?? 0) + 1);
const drop = (lock: string) => {
  const count = (heldInProcess.get(lock) ?? 1) - 1;
  if (count > 0) heldInProcess.set(lock, count);
  else heldInProcess.delete(lock);
};

/** The reduced, validated state of one task plus where its log stands. */
export type Loaded = {
  record: TaskRecord;
  key: TaskKey | null;
  legacy: LegacyOrigin | null;
  seq: number;
  lastId: string;
  lastStart: number;
  end: number;
  size: number;
  /** Seq the current snapshot was taken at (0: none). */
  snapshotSeq: number;
};

export type Snapshot = {
  v: 1;
  task: Id;
  seq: number;
  lastId: string;
  lastStart: number;
  end: number;
  key: TaskKey | null;
  legacy: LegacyOrigin | null;
  record: unknown;
};

export type TaskReaderOptions = {
  /** Total time a lock held by a live writer is retried before `busy`
   * (default: `defaultLockTimeout()`, short for in-process hosts). */
  lockTimeoutMs?: number;
};

export class TaskReader {
  /** The checkout this store serves: the worktree top level in a git
   * repository (every subdirectory is the same checkout), else the
   * directory. Git operations run here. */
  readonly root: string;
  /** The directory the store was opened from (a 2.x store may live there). */
  private readonly origin: string;
  private readonly lockTimeoutMs: number;
  private located: StoreLocation | Error | undefined;
  private migrationChecked = false;

  constructor(root: string, options: TaskReaderOptions = {}) {
    const resolved = path.resolve(root);
    this.origin = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    this.located = resolveStore(this.origin);
    this.root = checkoutRootOf(this.origin, this.located);
    this.lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeout();
  }

  /** Where this checkout's store lives. */
  location(): Result<StoreLocation> {
    // A directory that became a repository (`git init`) moves to the git store.
    if (
      this.located !== undefined &&
      !(this.located instanceof Error) &&
      !this.located.shared &&
      fs.existsSync(path.join(this.root, ".git"))
    ) {
      this.located = undefined;
      this.migrationChecked = false;
    }
    if (this.located === undefined) this.located = resolveStore(this.root);
    return this.located instanceof Error
      ? failure("storage_error", this.located.message, { path: this.root })
      : success(null, null, this.located);
  }

  /** The implicit-task key of this checkout right now. */
  currentKey(): Result<TaskKey> {
    const location = this.location();
    if (!location.ok) return location;
    return success(null, null, resolveTaskKey(this.root, location.data));
  }

  // -------------------------------------------------------------------------
  // reads

  readTask(taskId: Id): Result<TaskRecord> {
    if (!validId(taskId)) return failure("invalid_input", "task ID is invalid", { taskId });
    const ready = this.ready();
    if (!ready.ok) return ready;
    const loaded = this.load(taskId);
    if (!loaded.ok) return loaded;
    if (!loaded.data) return failure("not_found", "task not found", { taskId });
    const workspace = this.readWorkspace();
    if (!workspace.ok) return workspace;
    const bound = this.bindingError(loaded.data.record, workspace.data);
    return bound ?? success(null, null, loaded.data.record);
  }

  /** This checkout's tasks (oldest id first). */
  listTasks(): Result<TaskRecord[]> {
    const listed = this.listTaskIndex();
    if (!listed.ok) return listed;
    const tasks: TaskRecord[] = [];
    for (const entry of listed.data.toSorted((left, right) => left.id.localeCompare(right.id))) {
      const loaded = this.load(entry.id);
      if (!loaded.ok) return loaded;
      if (loaded.data) tasks.push(loaded.data.record);
    }
    return success(null, null, tasks);
  }

  /** Listing facts for this checkout's tasks, from the index cache. */
  listTaskIndex(): Result<TaskIndexEntry[]> {
    const all = this.listStoreIndex();
    if (!all.ok) return all;
    const workspace = this.readWorkspace();
    if (!workspace.ok) return workspace;
    if (!workspace.data) return success(null, null, []);
    const id = workspace.data.id;
    return success(
      null,
      null,
      all.data.filter((entry) => entry.workspaceId === id),
    );
  }

  /**
   * Listing facts for every task in the store (all checkouts). Each cached
   * entry is checked against its log's stat signature; changed or missing
   * entries are rebuilt from the log and the index is rewritten best-effort.
   */
  listStoreIndex(): Result<TaskIndexEntry[]> {
    const ready = this.ready();
    if (!ready.ok) return ready;
    const tasksDir = this.paths().tasks;
    let names: string[];
    try {
      names = fs.existsSync(tasksDir)
        ? fs.readdirSync(tasksDir).filter((name) => validId(name))
        : [];
    } catch (error) {
      return failure("storage_error", `unable to list tasks: ${String(error)}`, {
        path: tasksDir,
      });
    }
    const stored = this.readIndex();
    const entries: TaskIndexEntry[] = [];
    let changed = Object.keys(stored).length !== names.length;
    for (const name of names.toSorted()) {
      const signature = fileSignature(this.eventsPath(name));
      if (signature === null) {
        changed = true;
        continue;
      }
      const cached = stored[name];
      if (cached && cached.file === signature && !racySignature(signature)) {
        entries.push(cached);
        continue;
      }
      const loaded = this.load(name);
      if (!loaded.ok) return loaded;
      if (!loaded.data) continue;
      const entry = indexEntry(
        loaded.data.record,
        loaded.data.key,
        loaded.data.legacy !== null,
        signature,
      );
      if (!cached || canonicalJson(cached) !== canonicalJson(entry)) changed = true;
      entries.push(entry);
    }
    if (changed) this.writeIndex(entries);
    return success(null, null, entries);
  }

  readWorkspace(): Result<WorkspaceRecord | null> {
    const ready = this.ready();
    if (!ready.ok) return ready;
    const file = this.paths().workspace;
    let bytes: string;
    try {
      bytes = retryTransient(() => fs.readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return success(null, null, null);
      return failure("recovery_required", `workspace record cannot be read: ${String(error)}`, {
        path: file,
      });
    }
    const parsed = this.parseRecord<WorkspaceRecord>(bytes, workspaceRecordSchema, "workspace");
    if (!parsed.ok) return parsed;
    if (parsed.data.root !== this.root && !sameDirectoryIdentity(parsed.data.root, this.root))
      return failure("recovery_required", "workspace root binding is invalid", { path: file });
    return parsed;
  }

  /**
   * What `workit task status` reports about the current key: every open task
   * bound to it (more than one is a duplicate; the oldest is the one used).
   */
  keyReport(): Result<{ key: TaskKey; bound: TaskIndexEntry[] }> {
    const key = this.currentKey();
    if (!key.ok) return key;
    const bound = this.openTasksForKey(key.data.key);
    if (!bound.ok) return bound;
    return success(null, null, { key: key.data, bound: bound.data });
  }

  /**
   * The open task of this checkout that worker `workerId` is assigned to,
   * whichever branch it is bound to: worker commands follow the worker, not
   * the branch checked out now (#264). Null when no open task has it.
   */
  taskForWorker(workerId: unknown): Result<Id | null> {
    if (typeof workerId !== "string" || !idRefPattern.test(workerId))
      return failure(
        "invalid_input",
        "needs a worker id: `workit worker cancel|report <workerId>`",
      );
    const listed = this.listTaskIndex();
    if (!listed.ok) return listed;
    const owners = new Map<string, Id>();
    for (const entry of listed.data) {
      if (entry.status === "closed") continue;
      const loaded = this.load(entry.id);
      if (!loaded.ok) return loaded;
      for (const worker of loaded.data?.record.workers ?? []) owners.set(worker.id, entry.id);
    }
    const resolved = resolveIdRef("worker", workerId, [...owners.keys()]);
    if (resolved.ok) return success(null, null, owners.get(resolved.data) ?? null);
    if (resolved.code !== "not_found") return resolved;
    return success(null, null, null);
  }

  /**
   * The open task whose decisions the current branch inherits: the task of
   * the branch it was cut from (`origin/develop` counts as `develop`), in any
   * checkout of this repository, labelled with its origin ("branch develop").
   * Null off a branch, or when git's reflogs do not name a base.
   */
  originTaskEntry(): Result<{ origin: string; entry: TaskIndexEntry } | null> {
    const key = this.currentKey();
    const location = this.location();
    const branch = key.ok ? key.data.branch : null;
    if (!branch || !location.ok) return success(null, null, null);
    const common = path.dirname(location.data.dir);
    const heads = path.join(common, "logs", "refs", "heads");
    const headLog = location.data.git ? path.join(location.data.git.gitDir, "logs", "HEAD") : "";
    // Per-turn path: reading a long HEAD log and every branch log costs tens
    // of ms, so the resolution is reused until one of these files changes.
    const signatures = [
      path.join(heads, branch),
      headLog,
      heads,
      path.join(common, "packed-refs"),
    ].map((file) => fileSignature(file) ?? "-");
    const slot = `${location.data.dir}\0${headLog}\0${branch}`;
    let resolved = origins.get(slot);
    if (resolved?.signature !== signatures.join("|")) {
      const renames = branchRenames(location.data);
      // The branch's earlier names, newest first: a rename keeps its log.
      const aliases = [branch];
      for (const rename of renames.toReversed())
        if (rename.to === aliases.at(-1)) aliases.push(rename.from);
      const start = branchStart(location.data, branch, aliases);
      const slash = start?.indexOf("/") ?? -1;
      // `origin/develop` is the remote's `develop`: strip the remote only for
      // a remote-tracking ref or a configured remote, never for a local
      // branch or tag that has a slash in its name.
      const remote =
        slash > 0 &&
        !refExists(common, `refs/heads/${start}`) &&
        (refExists(common, `refs/remotes/${start}`) ||
          readText(path.join(common, "config")).includes(`[remote "${start!.slice(0, slash)}"]`));
      const name = start && (remote ? start.slice(slash + 1) : start);
      // Logs only grow (their size is in the signature), so no racy check.
      resolved = {
        signature: signatures.join("|"),
        name: name && !aliases.includes(name) ? name : null,
        renames,
      };
      origins.set(slot, resolved);
    }
    const entry = resolved.name ? this.openTasksForKey(resolved.name, resolved.renames) : null;
    if (entry && !entry.ok) return entry;
    return success(
      null,
      null,
      entry?.data[0] ? { origin: `branch ${resolved.name}`, entry: entry.data[0] } : null,
    );
  }

  /** The record of an indexed task (`taskId` from the index) in any checkout of
   * this store: read-only, no binding check. */
  readStoreTask(taskId: Id): Result<TaskRecord | null> {
    const loaded = this.load(taskId);
    return loaded.ok ? success(null, null, loaded.data?.record ?? null) : loaded;
  }

  // -------------------------------------------------------------------------
  // internals: layout

  protected paths() {
    const location = this.location();
    // Callers go through ready(), which fails first when the store is unresolved.
    const dir = location.ok ? location.data.dir : path.join(this.root, ".workit");
    const checkout = path.join(dir, "checkouts", checkoutSlug(this.root));
    return {
      dir,
      shared: location.ok ? location.data.shared : false,
      marker: path.join(dir, "store.json"),
      checkout,
      workspace: path.join(checkout, "workspace.json"),
      checkoutLock: path.join(checkout, "metadata.lock"),
      tasks: path.join(dir, "tasks"),
      index: path.join(dir, "task-index.json"),
      blobs: path.join(dir, "blobs", "candidates"),
      legacy: path.join(dir, "legacy", checkoutSlug(this.root), "v2"),
      v2: path.join(this.root, ".workit"),
    };
  }
  protected eventsPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "events.jsonl");
  }
  protected snapshotPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "snapshot.json");
  }

  /**
   * The store resolves and its format is readable. A pending migration (a
   * 2.x store, or a pre-git 3.x store) runs on writes, and on reads only for
   * a host that can tell the user (the CLI); other reads, e.g. per-turn
   * hooks, get a `needs_input` naming the command that migrates.
   */
  protected ready(write = false): Result<null> {
    const location = this.location();
    if (!location.ok) return location;
    if (this.migrationChecked) return success(null, null, null);
    const dirs = this.paths();
    try {
      const marker = JSON.parse(fs.readFileSync(dirs.marker, "utf8")) as { version?: unknown };
      if (typeof marker.version === "number" && marker.version > STORE_FORMAT)
        return failure(
          "recovery_required",
          `the workit store at ${dirs.dir} has format ${marker.version}; upgrade Workit to use it`,
          { path: dirs.marker },
        );
    } catch {}
    // Reads made by the migration itself see the store as ready.
    this.migrationChecked = true;
    const settled = this.settleMigrations(write);
    if (!settled.ok) this.migrationChecked = false;
    return settled;
  }

  /** A reader moves a pre-git 3.x store (as every access did before the
   * split) and reports a pending 2.x store; TaskStore migrates it. */
  protected settleMigrations(_write: boolean): Result<null> {
    const moved = this.adoptLocalStore();
    if (!moved.ok) return moved;
    const pending = this.pendingMigrations();
    return pending.length > 0 ? this.migrationPending(pending[0]) : success(null, null, null);
  }

  protected migrationPending(dir: string): Result<never> {
    return failure(
      "needs_input",
      `${MIGRATION_PENDING}: the task store at ${dir} has not been migrated yet; run \`workit task status\` to migrate it`,
      { path: dir, guidance: "workit task status" },
    );
  }

  /** Stored candidates, read by content digest (TaskStore also writes them). */
  protected blobStore(): BlobStore {
    const dir = this.paths().blobs;
    return {
      read: (digest) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, `${digest}.json`), "utf8"));
        } catch (error) {
          throw new LogDamage(
            `stored candidate ${digest} is missing or unreadable: ${String(error)}`,
          );
        }
      },
      write: () => {
        throw new Error("a TaskReader writes no candidates");
      },
    };
  }

  // -------------------------------------------------------------------------
  // internals: task logs

  /** Reduce a task's log (from its snapshot when that matches); null when absent. */
  protected load(taskId: Id): Result<Loaded | null> {
    try {
      const loaded = this.loadOrThrow(taskId);
      if (!loaded) return success(null, null, null);
      const parsed = this.parseTask(loaded.state.record, taskId);
      if (!parsed.ok) return parsed;
      return success(null, null, {
        record: parsed.data,
        key: loaded.state.key,
        legacy: loaded.state.legacy,
        seq: loaded.seq,
        lastId: loaded.lastId,
        lastStart: loaded.lastStart,
        end: loaded.end,
        size: loaded.size,
        snapshotSeq: loaded.snapshotSeq,
      });
    } catch (error) {
      if (error instanceof LogDamage)
        return failure(
          "recovery_required",
          error.upgrade ? error.message : `task ${taskId} log is damaged: ${error.message}`,
          { taskId, path: this.eventsPath(taskId) },
        );
      return failure("recovery_required", `task ${taskId} cannot be read: ${String(error)}`, {
        taskId,
      });
    }
  }

  private loadOrThrow(taskId: Id) {
    const blobs = this.blobStore();
    const file = this.eventsPath(taskId);
    const snapshot = this.readSnapshot(taskId);
    if (snapshot) {
      try {
        const tail = readLog(file, snapshot.lastStart, snapshot.seq);
        const first = tail?.events[0];
        // The snapshot names the event it was taken after: same seq, same id.
        if (tail && first && first.id === snapshot.lastId) {
          let state: ReducedTask | null = {
            record: snapshot.record as Record<string, unknown>,
            key: snapshot.key,
            legacy: snapshot.legacy,
          };
          for (const event of tail.events.slice(1)) state = reduce(state, event, blobs);
          return this.loadedFrom(state!, tail, snapshot.seq);
        }
      } catch (error) {
        if (error instanceof LogDamage && error.upgrade) throw error;
        // Any other mismatch: fall back to a full replay.
      }
    }
    const log = readLog(file, 0, null);
    if (!log || log.events.length === 0) {
      if (log && log.size > 0) throw new LogDamage("the log holds no complete event");
      return null;
    }
    if (!OPENING_TYPES.has(log.events[0].type))
      throw new LogDamage(`the log starts with ${log.events[0].type}, not an opening event`);
    let state: ReducedTask | null = null;
    for (const event of log.events) state = reduce(state, event, blobs);
    return this.loadedFrom(state!, log, 0);
  }

  private loadedFrom(state: ReducedTask, log: LogRead, snapshotSeq: number) {
    const last = log.events.at(-1)!;
    return {
      state,
      seq: last.seq,
      lastId: last.id,
      lastStart: log.lastStart,
      end: log.end,
      size: log.size,
      snapshotSeq,
    };
  }

  private readSnapshot(taskId: Id): Snapshot | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.snapshotPath(taskId), "utf8")) as unknown;
      if (
        !isObject(value) ||
        value.v !== 1 ||
        value.task !== taskId ||
        typeof value.seq !== "number" ||
        typeof value.lastId !== "string" ||
        typeof value.lastStart !== "number" ||
        typeof value.end !== "number" ||
        !isObject(value.record)
      )
        return null;
      return value as Snapshot;
    } catch {
      return null;
    }
  }

  protected bindingError(
    task: TaskRecord,
    workspace: WorkspaceRecord | null,
  ): Result<never> | null {
    if (workspace && task.workspaceId === workspace.id) return null;
    return failure(
      "not_found",
      `task ${task.id} belongs to another checkout of this repository; run there, or move it here with \`workit task adopt ${task.id}\``,
      { taskId: task.id },
    );
  }

  /**
   * Open tasks bound to `key` anywhere in the store, oldest first (with
   * duplicates, e.g. from a 2.x-era race, the oldest is the one used). A
   * task follows its branch through `git branch -m`: it counts for the new
   * name, and a branch created later under the old name starts fresh.
   */
  protected openTasksForKey(
    key: string,
    known?: ReturnType<typeof branchRenames>,
  ): Result<TaskIndexEntry[]> {
    const all = this.listStoreIndex();
    if (!all.ok) return all;
    const location = known ? null : this.location();
    const renames = known ?? (location?.ok ? branchRenames(location.data) : []);
    return success(
      null,
      null,
      all.data
        .filter((entry) => entry.key !== null && entry.status !== "closed")
        .filter(
          (entry) =>
            (renames.length
              ? followRenames(entry.key!, entry.boundAt ?? entry.createdAt, renames)
              : entry.key) === key,
        )
        .toSorted(oldestFirst),
    );
  }

  protected openTaskForKey(key: string): Result<TaskIndexEntry | null> {
    const bound = this.openTasksForKey(key);
    return bound.ok ? success(null, null, bound.data[0] ?? null) : bound;
  }

  // -------------------------------------------------------------------------
  // internals: index cache

  protected readIndex(): Record<string, TaskIndexEntry> {
    try {
      const value = JSON.parse(fs.readFileSync(this.paths().index, "utf8")) as unknown;
      if (!isObject(value) || value.version !== INDEX_VERSION || !isObject(value.tasks)) return {};
      const tasks: Record<string, TaskIndexEntry> = {};
      for (const [id, entry] of Object.entries(value.tasks))
        if (
          isObject(entry) &&
          entry.id === id &&
          typeof entry.file === "string" &&
          typeof entry.status === "string" &&
          typeof entry.updatedAt === "string" &&
          typeof entry.workspaceId === "string" &&
          Array.isArray(entry.sessions) &&
          isObject(entry.progress) &&
          isObject(entry.source)
        )
          tasks[id] = entry as TaskIndexEntry;
      return tasks;
    } catch {
      return {};
    }
  }

  /** The index is a disposable cache: write it atomically, never fail the caller. */
  protected writeIndex(entries: TaskIndexEntry[]) {
    try {
      fs.mkdirSync(this.paths().tasks, { recursive: true });
      replaceFile(
        this.paths().index,
        JSON.stringify({
          version: INDEX_VERSION,
          tasks: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
        }),
        false,
      );
    } catch {}
  }

  // -------------------------------------------------------------------------
  // internals: record parsing

  protected parseTask(record: Record<string, unknown>, taskId: Id): Result<TaskRecord> {
    const parsed = this.parseValue<TaskRecord>(record, taskRecordSchema, "task");
    if (!parsed.ok) return { ...parsed, details: { ...parsed.details, taskId } };
    if (parsed.data.id !== taskId)
      return failure("recovery_required", "task log and record ID differ", { taskId });
    return parsed;
  }

  protected parseRecord<T>(
    bytes: string,
    schema: typeof taskRecordSchema | typeof workspaceRecordSchema,
    label: string,
  ): Result<T> {
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      return failure("recovery_required", `${label} record JSON is corrupt`);
    }
    return this.parseValue<T>(value, schema, label);
  }

  private parseValue<T>(
    value: unknown,
    schema: typeof taskRecordSchema | typeof workspaceRecordSchema,
    label: string,
  ): Result<T> {
    if (isObject(value) && "schemaVersion" in value && value.schemaVersion !== SCHEMA_VERSION)
      return failure("unsupported_version", `unsupported ${label} schema version`);
    const parsed = parseStoredRecord(schema, value);
    if (parsed.success) return success(null, null, parsed.data as T);
    const writerVersion =
      isObject(value) && isObject(value.runtime) ? value.runtime.updatedWith : null;
    if (parsed.critical.length > 0)
      return failure(
        "recovery_required",
        `${label} record requires fields this Workit cannot read (${parsed.critical.join(", ")}); upgrade Workit before mutating this checkout`,
      );
    if (typeof writerVersion === "string" && isNewerVersion(writerVersion, runtimeVersion()))
      return failure(
        "recovery_required",
        `${label} record was written by workit ${writerVersion}; upgrade Workit before mutating this checkout`,
      );
    return failure("recovery_required", `${label} record does not satisfy its schema`);
  }

  // -------------------------------------------------------------------------
  // internals: 2.x migration

  /** 2.x stores this checkout may have: `<top>/.workit`, and `<dir>/.workit`
   * when the store was opened from a subdirectory. */
  protected v2Dirs(): string[] {
    return [...new Set([this.root, this.origin])].map((dir) => path.join(dir, ".workit"));
  }

  /** 2.x stores waiting to migrate into this checkout. (A pre-git 3.x
   * store is this runtime's own data and moves on any access.) */
  protected pendingMigrations(): string[] {
    return this.v2Dirs().filter((dir) => {
      const raw = this.readV2Workspace(path.join(dir, "workspace.json"));
      return raw !== null && raw !== TOMBSTONE;
    });
  }

  /**
   * A 3.x store kept in `<root>/.workit` while the directory was not a git
   * repository moves into the git store once it is one: task logs, checkout
   * records, blobs and (when the git store has none) the ledger. Entries the
   * git store already has are left in place. The local marker is renamed so
   * this runs once.
   */
  protected adoptLocalStore(): Result<null> {
    const dirs = this.paths();
    const marker = path.join(dirs.v2, "store.json");
    if (!dirs.shared || !fs.existsSync(marker)) return success(null, null, null);
    return this.withLock(dirs.checkoutLock, () => {
      if (!fs.existsSync(marker)) return success(null, null, null);
      let tasks = 0;
      try {
        // Move what the git store lacks; merge directories both have.
        const merge = (from: string, to: string) => {
          if (!fs.existsSync(to)) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            try {
              fs.renameSync(from, to);
            } catch {
              fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
              fs.rmSync(from, { recursive: true, force: true });
            }
            return;
          }
          if (fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory())
            for (const name of fs.readdirSync(from))
              merge(path.join(from, name), path.join(to, name));
        };
        for (const sub of ["tasks", "checkouts", "blobs", "legacy"]) {
          const from = path.join(dirs.v2, sub);
          if (!fs.existsSync(from)) continue;
          if (sub === "tasks")
            for (const name of fs.readdirSync(from))
              if (validId(name) && !fs.existsSync(path.join(dirs.dir, sub, name))) tasks += 1;
          merge(from, path.join(dirs.dir, sub));
        }
        const ledger = path.join(dirs.v2, "ledger");
        if (fs.existsSync(ledger) && !fs.existsSync(path.join(dirs.dir, "ledger")))
          merge(ledger, path.join(dirs.dir, "ledger"));
        fs.rmSync(path.join(dirs.v2, "task-index.json"), { force: true });
        fs.renameSync(marker, path.join(dirs.v2, "store.moved.json"));
      } catch (error) {
        return failure(
          "storage_error",
          `cannot move ${dirs.v2} into ${dirs.dir}: ${String(error)}`,
          {
            path: dirs.v2,
          },
        );
      }
      reportMigration({
        from: dirs.v2,
        to: dirs.dir,
        backup: dirs.v2,
        tasks,
        skipped: 0,
        workspace: false,
      });
      return success(null, null, null);
    });
  }

  /** The 2.x workspace bytes, TOMBSTONE for a 3.x marker, or null when absent. */
  protected readV2Workspace(file: string): { bytes: string } | typeof TOMBSTONE | null {
    let bytes: string;
    try {
      bytes = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(bytes) as unknown;
      if (isObject(value) && isObject(value.store) && value.store.format === "workit-store")
        return TOMBSTONE;
    } catch {}
    return { bytes };
  }

  /**
   * `<root>/.workit/workspace.json` as a marker 2.x readers fail closed on:
   * its `store` field is declared critical, and runtimes that predate the
   * critical rule reject it as written by a newer Workit.
   */
  protected writeTombstone(v2: string, workspaceId: Id | null) {
    const dirs = this.paths();
    const version = isNewerVersion(runtimeVersion(), STORE_MIN_RUNTIME)
      ? runtimeVersion()
      : STORE_MIN_RUNTIME;
    const marker = {
      schemaVersion: SCHEMA_VERSION,
      id: workspaceId ?? newId(),
      revision: newRevision(),
      root: path.dirname(v2),
      runtime: { createdWith: version, updatedWith: version },
      writer: null,
      store: {
        format: "workit-store",
        version: STORE_FORMAT,
        path: dirs.dir,
        note: `workit ${STORE_MIN_RUNTIME}+ keeps task state in ${dirs.dir}; upgrade Workit`,
      },
      critical: ["store"],
    };
    fs.mkdirSync(v2, { recursive: true });
    // Keep the marker directory out of version control.
    const ignore = path.join(v2, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    replaceFile(path.join(v2, "workspace.json"), `${JSON.stringify(marker, null, 2)}\n`, true);
  }

  /**
   * A store outside git carries the marker at `<root>/.workit/workspace.json`,
   * so a 2.x runtime never starts a second, divergent store there (it fails
   * closed with the upgrade message). A git checkout gets none: its
   * `.workit/` holds only committed team config.
   */
  private writeTombstoneIfMissing() {
    try {
      if (this.paths().shared) return;
      const v2 = path.join(this.root, ".workit");
      if (fs.existsSync(path.join(v2, "workspace.json"))) return;
      let id: Id | null = null;
      try {
        id =
          (JSON.parse(fs.readFileSync(this.paths().workspace, "utf8")) as { id?: Id }).id ?? null;
      } catch {}
      this.writeTombstone(v2, id);
    } catch {}
  }

  // -------------------------------------------------------------------------
  // internals: locks

  private initializeStorage() {
    const dirs = this.paths();
    retryTransient(() => fs.mkdirSync(dirs.checkout, { recursive: true }));
    retryTransient(() => fs.mkdirSync(dirs.tasks, { recursive: true }));
    if (!fs.existsSync(dirs.marker))
      replaceFile(
        dirs.marker,
        `${JSON.stringify({ format: "workit-store", version: STORE_FORMAT, createdWith: runtimeVersion() })}\n`,
        false,
      );
    if (!dirs.shared) {
      // Outside git the store sits in the checkout: keep it out of any VCS.
      const ignore = path.join(dirs.dir, ".gitignore");
      let current: string | null = null;
      try {
        current = fs.readFileSync(ignore, "utf8");
      } catch {}
      if (current !== "*\n") retryTransient(() => fs.writeFileSync(ignore, "*\n"));
    }
    this.writeTombstoneIfMissing();
  }

  /**
   * Lock options: a holder that is gone (dead pid, reused pid, or a foreign
   * or unreadable lock past its TTL) is reclaimed; a live holder is waited
   * on briefly and then reported as retryable `busy`.
   */
  private lockOptions(lockPath: string): FileLockSyncAcquireOptions<MetadataLock> & {
    payload: () => MetadataLock;
  } {
    const inProcess = heldInProcess.has(lockPath);
    return {
      lockPath,
      staleMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: inProcess ? 0 : this.lockTimeoutMs,
      retry: inProcess
        ? { retries: 0 }
        : { minTimeout: 5, maxTimeout: 100, factor: 1.5, randomize: true },
      staleRecovery: "remove-if-unchanged",
      shouldReclaim: ({ payload, nowMs }) => {
        let ageMs: number | null = null;
        try {
          ageMs = nowMs - fs.lstatSync(lockPath).mtimeMs;
        } catch {}
        return (
          classifyLockOwner(payload, ageMs, localLockHost(), TASK_STORE_LOCK).state === "stale"
        );
      },
      // The library re-checks the bytes before removal, so a lock replaced
      // after classification is never deleted.
      shouldRemoveStaleLock: () => true,
      parsePayload: parseMetadataLockOrNull,
      payload: () => ({
        pid: process.pid,
        processStart: processStartOf(process.pid),
        host: localLockHost(),
        nonce: randomUUID(),
      }),
    };
  }

  private acquire(
    lockPath: string,
    options: FileLockSyncAcquireOptions<MetadataLock>,
  ): FileLockSyncHandle {
    clearAbandonedReclaimGuard(lockPath);
    // One budget for the whole acquisition: a lost reclaim race retries with
    // the remaining time, never a fresh timeout.
    const deadline = Date.now() + (options.timeoutMs ?? 0);
    while (true) {
      try {
        return acquireFileLockSync(lockPath, {
          ...options,
          timeoutMs: Math.max(0, deadline - Date.now()),
        });
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (
          (code !== "file_lock_stale" && !isTransientWindowsError(error)) ||
          Date.now() >= deadline
        )
          throw error;
        // A Windows denial with no visible holder and a directory that
        // refuses new files is a permission problem: fail fast.
        if (
          code !== "file_lock_stale" &&
          !this.lockHolderPresent(lockPath) &&
          !this.lockDirWritable(lockPath)
        )
          throw error;
        if (code !== "file_lock_stale")
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  protected withLock<T>(lockPath: string, operation: () => Result<T>): Result<T> {
    try {
      this.initializeStorage();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch (error) {
      return failure("storage_error", `unable to initialize store: ${String(error)}`, {
        path: this.paths().dir,
      });
    }
    let handle: FileLockSyncHandle;
    try {
      handle = this.acquire(lockPath, this.lockOptions(lockPath));
    } catch (error) {
      return this.lockFailure(lockPath, error);
    }
    hold(lockPath);
    let result: Result<T>;
    try {
      if (!handle.verifyStillHeld())
        result = failure("recovery_required", "metadata lock was compromised", { path: lockPath });
      else {
        try {
          result = operation();
        } catch (error) {
          result = failure("storage_error", `mutation failed: ${String(error)}`);
        }
      }
    } catch (error) {
      result = this.lockFailure(lockPath, error);
    }
    drop(lockPath);
    try {
      retryTransient(() => handle.release());
    } catch (error) {
      const released = this.lockFailure(lockPath, error);
      const releaseError = released.ok ? "metadata lock release failed" : released.error;
      result = result.ok
        ? released
        : failure("recovery_required", `${result.error}; ${releaseError}`, result.details);
    }
    return result;
  }

  /** Whether the lock's directory accepts a new file right now. */
  private lockDirWritable(lockPath: string): boolean {
    const probe = `${lockPath}.${process.pid}.${randomUUID()}.probe`;
    try {
      fs.closeSync(fs.openSync(probe, "wx", 0o600));
    } catch {
      return false;
    }
    try {
      fs.rmSync(probe, { force: true });
    } catch {}
    return true;
  }

  /** A lock file (or an entry Windows is still tearing down) exists. */
  private lockHolderPresent(lockPath: string): boolean {
    try {
      fs.lstatSync(lockPath);
      return true;
    } catch (error) {
      return (error as { code?: unknown } | null)?.code !== "ENOENT";
    }
  }

  private lockFailure(lockPath: string, error: unknown): Result<never> {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value?.code === "string" ? value.code : "";
    // A sharing-class denial is contention only when someone holds the lock.
    if (
      isTransientWindowsError(error) &&
      !this.lockHolderPresent(lockPath) &&
      !this.lockDirWritable(lockPath)
    )
      return failure(
        "storage_error",
        `cannot create the workit lock (${code}); no other Workit call holds it`,
        {
          path: lockPath,
          guidance: `Check permissions and the read-only attribute on ${path.dirname(lockPath)}.`,
        },
      );
    if (
      code === "EEXIST" ||
      code === "file_lock_timeout" ||
      code === "file_lock_stale" ||
      isTransientWindowsError(error)
    ) {
      let lock: MetadataLock | null = null;
      try {
        lock = parseMetadataLockOrNull(fs.readFileSync(lockPath, "utf8"));
      } catch {}
      return failure(
        "busy",
        `workit lock is held by another Workit call${lock ? ` (pid ${lock.pid} on ${lock.host})` : ""}; retry shortly`,
        {
          outcome: "not_started",
          path: lockPath,
          guidance:
            "Retry the same call. If it stays busy, run `workit doctor --fix-lock` to clear a lock left by a dead process.",
        },
      );
    }
    const recovery =
      code === "metadata_lock_invalid" ||
      code === "not-file" ||
      /metadata lock|file lock|reclaim/i.test(String(value?.message ?? error));
    return failure(
      recovery ? "recovery_required" : "storage_error",
      `lock operation failed: ${String(error)}`,
      { path: lockPath },
    );
  }
}
