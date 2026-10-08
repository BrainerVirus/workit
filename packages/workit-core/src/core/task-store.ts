// The task store (design §4.1; D3, D13, D17).
//
// Layout under the store directory (`<git common dir>/workit`, or
// `<root>/.workit` outside git; see store/paths.ts):
//
//   store.json                       format marker (a newer format fails closed)
//   checkouts/<slug>/workspace.json  this checkout's workspace record
//   checkouts/<slug>/metadata.lock   checkout lock: workspace writes and task
//                                    creation
//   tasks/<id>/events.jsonl          the task's append-only event log
//   tasks/<id>/snapshot.json         rebuildable cache of the reduced state
//   tasks/<id>/lock                  task lock: one append at a time
//   task-index.json                  rebuildable listing cache for hooks
//   blobs/candidates/<sha256>.json   stored candidates, written once by content
//   legacy/<slug>/v2/                backup of a migrated 2.x `.workit` store
//
// Each task mutation appends one event holding a structural patch of the
// record, so state grows with the change, never with full-file copies, and
// there is no recovery directory: the log is the history. `workit gc` folds
// old events into a checkpoint. A checkout's work belongs to an implicit task
// keyed by its branch (detached HEAD: by worktree; outside git: by directory);
// the first mutation creates it.
//
// A 2.x store in `<root>/.workit` is migrated on first use (idempotent, under
// the checkout lock, backup kept). The migrated `.workit/workspace.json` is
// replaced by a marker that 2.x readers reject with an upgrade message.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import {
  acquireFileLockSync,
  type FileLockSyncHandle,
  type FileLockSyncAcquireOptions,
} from "@openclaw/fs-safe/file-lock";
import { hostSessionFromEnv } from "../host-session";
import { packageRoot } from "./package-root";
import {
  SCHEMA_VERSION,
  canonicalJson,
  failure,
  intentSchema,
  newId,
  newRevision,
  parseStoredRecord,
  provenanceSchema,
  sha256,
  success,
  taskRecordSchema,
  workspaceRecordSchema,
  type Id,
  type Intent,
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
  EVENT_VERSION,
  LogDamage,
  appendEvent,
  isTransientWindowsError,
  readLog,
  replaceFile,
  retryTransient,
  type EventActor,
  type LogRead,
  type StoreEvent,
} from "../store/event-log";
import { diff } from "../store/patch";
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
  encodeOps,
  encodeRecord,
  eventType,
  reduce,
  type BlobStore,
  type LegacyOrigin,
  type ReducedTask,
} from "../store/reduce";

import { migrationReporterInstalled, reportMigration } from "../store/notes";

/** Prefix of the `needs_input` error a read gets while a migration is pending. */
export const MIGRATION_PENDING = "workit migration pending";

export type { TaskKey } from "../store/paths";

/** The store format this runtime writes; a newer marker fails closed. */
export const STORE_FORMAT = 3;
/** The runtime version 2.x readers are told to upgrade to. */
const STORE_MIN_RUNTIME = "3.0.0";
/** A snapshot is written after this many events since the last one. */
export const SNAPSHOT_EVERY = 32;
/** `gc` compacts a log longer than this many events ... */
export const COMPACT_ABOVE = 200;
/** ... and keeps this many recent events after the checkpoint. */
export const COMPACT_KEEP = 50;
/** An append that leaves the log larger than this compacts it on the spot. */
export const AUTO_COMPACT_BYTES = 2 * 1024 * 1024;
/** readV2Workspace's answer for a 3.x marker at `.workit/workspace.json`. */
const TOMBSTONE = Symbol("tombstone");
/** A temp file or unreferenced blob older than this was left by a crashed writer. */
const STALE_TEMPORARY_MS = 60 * 60_000;

export type GarbageReport = {
  dryRun: boolean;
  compacted: { tasks: Id[]; eventsFolded: number; bytesBefore: number; bytesAfter: number };
  blobs: { removed: number; removedBytes: number; kept: number };
  temporary: { removed: number };
  /** A 2.x `.workit/recovery` directory left by migration (deleted only with pruneRecovery). */
  legacyRecovery: { path: string; files: number; bytes: number; removed: boolean } | null;
  /** Logs another writer changed mid-compaction: left for the next run (benign). */
  retried: Id[];
  failed: Id[];
};
export type TaskStoreOptions = {
  /** Total time a mutation retries a lock held by a live writer before `busy`
   * (default: `defaultLockTimeout()`, short for in-process hosts). */
  lockTimeoutMs?: number;
  /** Who the events are attributed to (default: WORKIT_HOST/WORKIT_SESSION_ID/WORKIT_AGENT_ID). */
  actor?: EventActor;
  /** Migrate a pending 2.x store on reads too (default: only when a host
   * installed a migration reporter, i.e. the CLI; writes always migrate). */
  migrateOnRead?: boolean;
};

export type MutationContext = { now: Utc; revision: Revision };
export type TaskMutation = (task: TaskRecord, context: MutationContext) => Result<TaskRecord>;
export type WorkspaceMutation = (
  workspace: WorkspaceRecord,
  context: MutationContext,
) => Result<WorkspaceRecord>;
export type CoupledMutation = {
  taskId: Id;
  expectedRevision: Revision;
  expectedWorkspaceRevision: Revision;
  now?: Utc;
  task: TaskMutation;
  workspace: WorkspaceMutation;
};
export type CoupledSnapshot = { task: TaskRecord; workspace: WorkspaceRecord };
export type CreateInput = {
  intent: Intent;
  provenance: Provenance;
  expectedWorkspaceRevision: Revision | null;
  now?: Utc;
};
export type ImportInput = {
  task: TaskRecord;
  expectedWorkspaceRevision: Revision | null;
  workspaceId?: Id;
  now?: Utc;
};
export type ImplicitInput = {
  provenance: Provenance;
  /** Objective for a task this call creates (default: names the branch). */
  objective?: string;
  now?: Utc;
  /** False: only find the task, never create it. */
  create?: boolean;
};
export type ImplicitTask = { task: TaskRecord; created: boolean; key: TaskKey };

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hostSession = (value: unknown): { host: string; handle: string } | null =>
  isObject(value) &&
  value.kind === "host" &&
  typeof value.host === "string" &&
  typeof value.handle === "string"
    ? { host: value.host, handle: value.handle }
    : null;
const indexEntry = (
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

const now = (): Utc => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

const stampNew = (record: { runtime?: { createdWith: string | null } }) => ({
  createdWith: record.runtime?.createdWith ?? null,
  updatedWith: runtimeVersion(),
});

const isNewerVersion = (candidate: string, current: string): boolean => {
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
const validId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
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

const envActor = (): EventActor => {
  const value = (key: string) => process.env[key]?.trim() || null;
  const acting = hostSessionFromEnv(process.env);
  return {
    host: acting.host ?? "runtime",
    session: acting.session,
    agentId: value("WORKIT_AGENT_ID"),
  };
};

/** The reduced, validated state of one task plus where its log stands. */
type Loaded = {
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

type Snapshot = {
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

export class TaskStore {
  /** The checkout this store serves: the worktree top level in a git
   * repository (every subdirectory is the same checkout), else the
   * directory. Git operations run here. */
  readonly root: string;
  /** The directory the store was opened from (a 2.x store may live there). */
  private readonly origin: string;
  private readonly lockTimeoutMs: number;
  private readonly actor: EventActor;
  private readonly migrateOnRead: boolean | undefined;
  private located: StoreLocation | Error | undefined;
  private migrationChecked = false;
  /** Task logs past AUTO_COMPACT_BYTES, folded after the writing lock is released. */
  private readonly compactDue = new Set<Id>();

  constructor(root: string, options: TaskStoreOptions = {}) {
    const resolved = path.resolve(root);
    this.origin = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    this.located = resolveStore(this.origin);
    this.root = checkoutRootOf(this.origin, this.located);
    this.lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeout();
    this.actor = options.actor ?? envActor();
    this.migrateOnRead = options.migrateOnRead;
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
   * The open task bound to this checkout's implicit key (branch, detached
   * worktree, or directory), created when `create` is not false and there is
   * none. A task bound to the key from another checkout of the same repo
   * (e.g. a removed worktree) is moved to this checkout.
   */
  implicitTask(input: ImplicitInput): Result<ImplicitTask | null> {
    const ready = this.ready(input.create !== false);
    if (!ready.ok) return ready;
    const key = this.currentKey();
    if (!key.ok) return key;
    const found = this.openTaskForKey(key.data.key);
    if (!found.ok) return found;
    const workspace = this.readWorkspace();
    if (!workspace.ok) return workspace;
    if (
      found.data &&
      workspace.data &&
      found.data.workspaceId === workspace.data.id &&
      (found.data.key === key.data.key || input.create === false)
    ) {
      const task = this.readTask(found.data.id);
      return task.ok
        ? success(task.revision, null, { task: task.data, created: false, key: key.data })
        : task;
    }
    if (input.create === false) {
      // A lookup never binds or moves anything.
      if (!found.data) return success(null, null, null);
      const loaded = this.load(found.data.id);
      if (!loaded.ok) return loaded;
      return loaded.data
        ? success(null, null, { task: loaded.data.record, created: false, key: key.data })
        : success(null, null, null);
    }
    return this.withLock<ImplicitTask | null>(this.paths().checkoutLock, () =>
      this.withKeyLock(key.data.key, () => this.implicitLocked(input, key.data)),
    );
  }

  /** Find, move or create the implicit task (under the checkout and key locks). */
  private implicitLocked(input: ImplicitInput, key: TaskKey): Result<ImplicitTask | null> {
    {
      const again = this.openTaskForKey(key.key);
      if (!again.ok) return again;
      if (again.data) {
        const moved = this.bindLocked(again.data.id, key, input.now);
        return moved.ok
          ? success(moved.data.revision, null, { task: moved.data, created: false, key })
          : moved;
      }
      const label =
        key.kind === "branch"
          ? `branch ${key.branch}`
          : key.kind === "detached"
            ? "a detached HEAD"
            : path.basename(this.root) || this.root;
      const intent: Intent = {
        objective: input.objective?.trim() || `Work on ${label}`,
        scope: { description: `the checkout (${label})`, paths: ["."], exclusions: [] },
        authorityRefs: [],
      };
      const created = this.createLocked(
        { intent, provenance: input.provenance, expectedWorkspaceRevision: null, now: input.now },
        false,
        key,
        false,
      );
      return created.ok
        ? success(created.data.revision, null, { task: created.data, created: true, key })
        : created;
    }
  }

  /** Bind task `taskId` (any checkout, not closed) to this checkout's implicit key. */
  adoptTask(taskId: Id): Result<TaskRecord> {
    if (!validId(taskId)) return failure("invalid_input", "task ID is invalid", { taskId });
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    const key = this.currentKey();
    if (!key.ok) return key;
    return this.withLock(this.paths().checkoutLock, () =>
      this.withKeyLock(key.data.key, () => {
        const holder = this.openTaskForKey(key.data.key);
        if (!holder.ok) return holder;
        if (holder.data && holder.data.id !== taskId)
          return failure(
            "invalid_transition",
            `${key.data.key} already has open task ${holder.data.id}; close it (\`workit task close\`) before adopting another`,
            { taskId: holder.data.id },
          );
        return this.bindLocked(taskId, key.data);
      }),
    );
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

  // -------------------------------------------------------------------------
  // writes

  create(
    input: CreateInput | Intent,
    provenance?: Provenance,
    expectedWorkspaceRevision?: Revision | null,
  ): Result<TaskRecord> {
    const value: CreateInput =
      "intent" in input
        ? input
        : {
            intent: input,
            provenance: provenance!,
            expectedWorkspaceRevision: expectedWorkspaceRevision ?? null,
          };
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    return this.withLock(this.paths().checkoutLock, () => this.createLocked(value, true, null));
  }

  importTask(input: ImportInput): Result<TaskRecord> {
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    return this.withLock<TaskRecord>(this.paths().checkoutLock, () => {
      const current = this.readWorkspace();
      if (!current.ok) return current;
      const origin = input.task.origin;
      if (current.data && origin) {
        if (origin.workspaceId === current.data.id) {
          const source = this.readTask(origin.taskId);
          if (source.ok) return success(source.data.revision, current.data.revision, source.data);
          if (source.code !== "not_found") return source;
          return failure("not_found", "source task is not present in this shared workspace");
        }
        const tasks = this.listTasks();
        if (!tasks.ok) return tasks;
        const prior = tasks.data.filter(
          (task) =>
            task.origin?.workspaceId === origin.workspaceId &&
            task.origin?.taskId === origin.taskId,
        );
        if (prior.length > 1)
          return failure(
            "recovery_required",
            `source task has multiple imported mappings: ${prior.map((task) => task.id).join(", ")}`,
          );
        if (prior.length === 1) {
          const existing = prior[0];
          if (existing.origin!.exportDigest !== origin.exportDigest)
            return failure(
              "revision_conflict",
              "source task export changed; reconcile the mapped destination task before importing",
              { taskId: existing.id },
            );
          return success(existing.revision, current.data.revision, existing);
        }
      }
      if (
        current.data
          ? input.expectedWorkspaceRevision !== current.data.revision
          : input.expectedWorkspaceRevision !== null
      )
        return failure(
          "revision_conflict",
          "workspace revision does not match; omit expectedWorkspaceRevision to use the current record",
          {
            expectedWorkspaceRevision: input.expectedWorkspaceRevision,
            actualWorkspaceRevision: current.data?.revision ?? null,
          },
        );
      const timestamp = input.now ?? now();
      const workspace = this.nextWorkspace(current.data, input.workspaceId);
      const task = {
        ...input.task,
        workspaceId: workspace.id,
        revision: newRevision(),
        createdAt: timestamp,
        updatedAt: timestamp,
        runtime: {
          createdWith: input.task.runtime?.createdWith ?? null,
          updatedWith: runtimeVersion(),
        },
      };
      const validTask = taskRecordSchema.safeParse(task);
      if (!validTask.success)
        return failure("invalid_input", "imported task does not satisfy its schema");
      return this.writeNewTask(current.data, workspace, validTask.data, "task.imported", null, {
        operation: "import",
      });
    });
  }

  mutateTask(
    taskId: Id,
    expected: Revision,
    update: TaskMutation,
    timestamp?: Utc,
  ): Result<TaskRecord> {
    if (!validId(taskId)) return failure("invalid_input", "task ID is invalid", { taskId });
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    const result = this.withLock(this.taskLockPath(taskId), () => {
      const loaded = this.loadBound(taskId);
      if (!loaded.ok) return loaded;
      if (loaded.data.record.revision !== expected)
        return this.conflict(expected, loaded.data.record.revision);
      const context = { now: timestamp ?? now(), revision: newRevision() };
      let changed: Result<TaskRecord>;
      try {
        // A copy: updates may edit in place, and the patch diffs against the original.
        changed = update(structuredClone(loaded.data.record), Object.freeze({ ...context }));
      } catch (error) {
        return failure("storage_error", `task mutation failed: ${String(error)}`);
      }
      if (!changed.ok) return changed;
      const valid = this.nextTask(loaded.data.record, changed.data, context);
      if (!valid) return failure("invalid_input", "task mutation produced an invalid record");
      const written = this.appendPatch(loaded.data, valid);
      return written.ok ? success(valid.revision, null, valid) : written;
    });
    this.compactPending();
    return result;
  }

  mutateWorkspace(expected: Revision, update: WorkspaceMutation): Result<WorkspaceRecord> {
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    return this.withLock(this.paths().checkoutLock, () => {
      const current = this.readWorkspace();
      if (!current.ok) return current;
      if (!current.data) return failure("not_found", "workspace not found");
      if (current.data.revision !== expected)
        return this.workspaceConflict(expected, current.data.revision);
      const context = { now: now(), revision: newRevision() };
      let changed: Result<WorkspaceRecord>;
      try {
        changed = update(current.data, Object.freeze({ ...context }));
      } catch (error) {
        return failure("storage_error", `workspace mutation failed: ${String(error)}`);
      }
      if (!changed.ok) return changed;
      const valid = workspaceRecordSchema.safeParse({
        ...changed.data,
        id: current.data.id,
        root: this.root,
        revision: context.revision,
        runtime: stampNew(current.data),
      });
      if (!valid.success)
        return failure("invalid_input", "workspace mutation produced an invalid record");
      const written = this.writeWorkspace(valid.data);
      return written.ok ? success(valid.data.revision, valid.data.revision, valid.data) : written;
    });
  }

  mutateTaskAndWorkspace(input: CoupledMutation): Result<CoupledSnapshot> {
    if (!validId(input.taskId))
      return failure("invalid_input", "task ID is invalid", { taskId: input.taskId });
    const ready = this.ready(true);
    if (!ready.ok) return ready;
    const result = this.withLock(this.paths().checkoutLock, () =>
      this.withLock(this.taskLockPath(input.taskId), () => {
        const task = this.loadBound(input.taskId);
        if (!task.ok) return task;
        const workspace = this.readWorkspace();
        if (!workspace.ok) return workspace;
        if (!workspace.data) return failure("not_found", "workspace not found");
        const expected = input.expectedRevision;
        if (!expected) return failure("invalid_input", "task revision is required");
        if (task.data.record.revision !== expected)
          return this.conflict(expected, task.data.record.revision);
        if (workspace.data.revision !== input.expectedWorkspaceRevision)
          return this.workspaceConflict(input.expectedWorkspaceRevision, workspace.data.revision);
        const workspaceContext = { now: input.now ?? now(), revision: newRevision() };
        let changedWorkspace: Result<WorkspaceRecord>;
        try {
          changedWorkspace = input.workspace(
            workspace.data,
            Object.freeze({ ...workspaceContext }),
          );
        } catch (error) {
          return failure("storage_error", `workspace mutation failed: ${String(error)}`);
        }
        if (!changedWorkspace.ok) return changedWorkspace;
        const nextWorkspace = workspaceRecordSchema.safeParse({
          ...changedWorkspace.data,
          id: workspace.data.id,
          root: this.root,
          revision: workspaceContext.revision,
          runtime: stampNew(workspace.data),
        });
        if (!nextWorkspace.success)
          return failure("invalid_input", "workspace mutation produced an invalid record");
        const reserved = this.writeWorkspace(nextWorkspace.data);
        if (!reserved.ok) return reserved;
        const uncertain = (message: string) => {
          return failure("external_outcome_unknown", message, {
            operation: "coupled_mutation",
            outcome: "unknown",
          });
        };
        const taskContext = { now: input.now ?? now(), revision: newRevision() };
        let changedTask: Result<TaskRecord>;
        try {
          changedTask = input.task(
            structuredClone(task.data.record),
            Object.freeze({ ...taskContext }),
          );
        } catch (error) {
          return uncertain(`workspace reserved but task mutation threw: ${String(error)}`);
        }
        if (!changedTask.ok) return uncertain("workspace reserved but task update is uncertain");
        const nextTask = this.nextTask(task.data.record, changedTask.data, taskContext);
        if (!nextTask) return uncertain("workspace reserved but task update is uncertain");
        const written = this.appendPatch(task.data, nextTask);
        if (!written.ok) return uncertain("workspace reserved but task append is uncertain");
        return success(nextTask.revision, nextWorkspace.data.revision, {
          task: nextTask,
          workspace: nextWorkspace.data,
        });
      }),
    );
    this.compactPending();
    return result;
  }

  /**
   * `workit gc`: compact long task logs into a checkpoint plus their most
   * recent events (the latest state is never lost), remove unreferenced
   * candidate blobs and temp files left by crashed writers, and report a 2.x
   * `.workit/recovery` directory left behind by migration (removed only with
   * `pruneRecovery`). A dry run is read-only.
   */
  collectGarbage(
    options: { dryRun?: boolean; pruneRecovery?: boolean; compactAbove?: number } = {},
  ): Result<GarbageReport> {
    const dryRun = options.dryRun === true;
    const compactAbove = options.compactAbove ?? COMPACT_ABOVE;
    const report: GarbageReport = {
      dryRun,
      compacted: { tasks: [], eventsFolded: 0, bytesBefore: 0, bytesAfter: 0 },
      blobs: { removed: 0, removedBytes: 0, kept: 0 },
      temporary: { removed: 0 },
      legacyRecovery: null,
      retried: [],
      failed: [],
    };
    const ready = this.ready(!dryRun);
    if (!ready.ok) return ready;
    const dirs = this.paths();
    const recovery = path.join(this.root, ".workit", "recovery");
    if (fs.existsSync(recovery)) {
      let files = 0;
      let bytes = 0;
      try {
        for (const name of fs.readdirSync(recovery)) {
          const stat = fs.lstatSync(path.join(recovery, name));
          if (!stat.isFile()) continue;
          files += 1;
          bytes += stat.size;
        }
      } catch {}
      const remove = options.pruneRecovery === true && !dryRun;
      if (remove) fs.rmSync(recovery, { recursive: true, force: true });
      report.legacyRecovery = { path: recovery, files, bytes, removed: remove };
    }
    if (!fs.existsSync(dirs.tasks)) return success(null, null, report);
    const names = fs.readdirSync(dirs.tasks).filter((name) => validId(name));
    for (const name of names) {
      const file = this.eventsPath(name);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      const lines = this.countEvents(file);
      if (lines > compactAbove) {
        if (dryRun) {
          report.compacted.tasks.push(name);
          report.compacted.eventsFolded += lines - COMPACT_KEEP;
          report.compacted.bytesBefore += size;
        } else {
          const compacted = this.compact(name);
          if (!compacted.ok)
            (compacted.code === "busy" ? report.retried : report.failed).push(name);
          else {
            report.compacted.tasks.push(name);
            report.compacted.eventsFolded += compacted.data.folded;
            report.compacted.bytesBefore += size;
            report.compacted.bytesAfter += compacted.data.bytes;
          }
        }
      }
    }
    const nowMs = Date.now();
    // Blobs go only when unreferenced and older than the grace period, under
    // the store's gc lock (one sweep at a time).
    const sweep = (): Result<null> => {
      const references = new Set<string>();
      for (const name of names)
        try {
          for (const match of fs
            .readFileSync(this.eventsPath(name), "utf8")
            .matchAll(/"\$blob":"([0-9a-f]{64})"/g))
            references.add(match[1]);
        } catch {}
      if (fs.existsSync(dirs.blobs))
        for (const name of fs.readdirSync(dirs.blobs)) {
          const digest = name.replace(/\.json$/, "");
          const file = path.join(dirs.blobs, name);
          let stat: fs.Stats;
          try {
            stat = fs.lstatSync(file);
          } catch {
            continue;
          }
          if (references.has(digest) || nowMs - stat.mtimeMs <= STALE_TEMPORARY_MS) {
            report.blobs.kept += 1;
            continue;
          }
          report.blobs.removed += 1;
          report.blobs.removedBytes += stat.size;
          if (!dryRun) fs.rmSync(file, { force: true });
        }
      return success(null, null, null);
    };
    const swept = dryRun ? sweep() : this.withLock(path.join(dirs.dir, "gc.lock"), sweep);
    if (!swept.ok) return swept;
    const temporaryDirs = [
      dirs.dir,
      dirs.tasks,
      dirs.blobs,
      dirs.checkout,
      ...names.map((name) => path.join(dirs.tasks, name)),
    ];
    for (const directory of temporaryDirs) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith(".tmp") && !name.endsWith(".probe")) continue;
        const file = path.join(directory, name);
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || nowMs - stat.mtimeMs <= STALE_TEMPORARY_MS) continue;
        } catch {
          continue;
        }
        report.temporary.removed += 1;
        if (!dryRun) fs.rmSync(file, { force: true });
      }
    }
    return success(null, null, report);
  }

  // -------------------------------------------------------------------------
  // internals: layout

  private paths() {
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
  private eventsPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "events.jsonl");
  }
  private snapshotPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "snapshot.json");
  }
  private taskLockPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "lock");
  }

  /** The store resolves, its format is readable, and any 2.x store here is migrated. */
  /**
   * The store resolves and its format is readable. A pending migration (a
   * 2.x store, or a pre-git 3.x store) runs on writes, and on reads only for
   * a host that can tell the user (the CLI); other reads, e.g. per-turn
   * hooks, get a `needs_input` naming the command that migrates.
   */
  private ready(write = false): Result<null> {
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

  private settleMigrations(write: boolean): Result<null> {
    const moved = this.adoptLocalStore();
    if (!moved.ok) return moved;
    const pending = this.pendingMigrations();
    if (pending.length > 0 && !write && !(this.migrateOnRead ?? migrationReporterInstalled()))
      return failure(
        "needs_input",
        `${MIGRATION_PENDING}: the task store at ${pending[0]} has not been migrated yet; run \`workit task status\` to migrate it`,
        { path: pending[0], guidance: "workit task status" },
      );
    for (const v2 of this.v2Dirs()) {
      const migrated = this.migrateV2(v2);
      if (!migrated.ok) return migrated;
    }
    return success(null, null, null);
  }

  private blobStore(): BlobStore {
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
      write: (digest, value) => {
        const file = path.join(dir, `${digest}.json`);
        if (fs.existsSync(file)) {
          // A reused blob is fresh again: gc spares blobs younger than its
          // grace period, so one about to be referenced is never collected.
          const stamp = new Date();
          try {
            fs.utimesSync(file, stamp, stamp);
            return;
          } catch {}
        }
        fs.mkdirSync(dir, { recursive: true });
        replaceFile(file, JSON.stringify(value), true);
      },
    };
  }

  // -------------------------------------------------------------------------
  // internals: task logs

  /** Reduce a task's log (from its snapshot when that matches); null when absent. */
  private load(taskId: Id): Result<Loaded | null> {
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

  private writeSnapshot(taskId: Id, loaded: Omit<Loaded, "size" | "snapshotSeq">) {
    const snapshot: Snapshot = {
      v: 1,
      task: taskId,
      seq: loaded.seq,
      lastId: loaded.lastId,
      lastStart: loaded.lastStart,
      end: loaded.end,
      key: loaded.key,
      legacy: loaded.legacy,
      record: loaded.record,
    };
    try {
      // A cache: a lost or torn snapshot only costs a replay.
      replaceFile(this.snapshotPath(taskId), JSON.stringify(snapshot), false);
    } catch {}
  }

  /** The task when it exists and belongs to this checkout. */
  private loadBound(taskId: Id): Result<Loaded> {
    const loaded = this.load(taskId);
    if (!loaded.ok) return loaded;
    if (!loaded.data) return failure("not_found", "task not found", { taskId });
    const workspace = this.readWorkspace();
    if (!workspace.ok) return workspace;
    const bound = this.bindingError(loaded.data.record, workspace.data);
    return bound ?? success(null, null, loaded.data);
  }

  private bindingError(task: TaskRecord, workspace: WorkspaceRecord | null): Result<never> | null {
    if (workspace && task.workspaceId === workspace.id) return null;
    return failure(
      "not_found",
      `task ${task.id} belongs to another checkout of this repository; run there, or move it here with \`workit task adopt ${task.id}\``,
      { taskId: task.id },
    );
  }

  private nextTask(
    current: TaskRecord,
    changed: TaskRecord,
    context: MutationContext,
  ): TaskRecord | null {
    const valid = taskRecordSchema.safeParse({
      ...changed,
      id: current.id,
      workspaceId: current.workspaceId,
      createdAt: current.createdAt,
      revision: context.revision,
      updatedAt: context.now,
      runtime: stampNew(current),
    });
    return valid.success ? valid.data : null;
  }

  private event(taskId: Id, seq: number, type: string, data: Record<string, unknown>): StoreEvent {
    return {
      v: EVENT_VERSION,
      seq,
      at: new Date().toISOString(),
      id: newId(),
      task: taskId,
      actor: this.actor,
      type,
      data,
    };
  }

  /** Append the patch from `loaded` to `next` (under the task lock). */
  private appendPatch(
    loaded: Loaded,
    next: TaskRecord,
    extra: { key?: TaskKey | null; type?: string; legacy?: LegacyOrigin } = {},
  ): Result<null> {
    const taskId = next.id;
    try {
      const blobs = this.blobStore();
      const before = loaded.record as unknown as Record<string, unknown>;
      const after = next as unknown as Record<string, unknown>;
      const ops = encodeOps(diff(before, after), blobs);
      const { type, ...data } = extra;
      if (data.key)
        data.key = { ...data.key, boundAt: data.key.boundAt ?? new Date().toISOString() };
      const event = this.event(
        taskId,
        loaded.seq + 1,
        type ?? ("key" in extra ? "task.bound" : eventType(before, after)),
        { ops, ...data },
      );
      const start = appendEvent(this.eventsPath(taskId), event, loaded.end);
      const end = start + Buffer.byteLength(`${JSON.stringify(event)}\n`);
      const key = "key" in data ? (data.key ?? null) : loaded.key;
      const state = {
        record: next,
        key,
        legacy: extra.legacy ?? loaded.legacy,
        seq: event.seq,
        lastId: event.id,
        lastStart: start,
        end,
      };
      if (
        event.seq - loaded.snapshotSeq >= SNAPSHOT_EVERY ||
        next.status !== loaded.record.status ||
        loaded.snapshotSeq === 0
      )
        this.writeSnapshot(taskId, state);
      // Bounded without a gc run: a log past the watermark is folded once
      // this write releases its lock (see compactDue).
      if (end > AUTO_COMPACT_BYTES) this.compactDue.add(taskId);
      this.indexTask(next, key, (extra.legacy ?? loaded.legacy) !== null);
      return success(null, null, null);
    } catch (error) {
      return failure("storage_error", `task append failed: ${String(error)}`, {
        path: this.eventsPath(taskId),
      });
    }
  }

  /** Write a new task's opening event. */
  private openTask(
    record: TaskRecord,
    type: string,
    key: TaskKey | null,
    legacy: LegacyOrigin | null = null,
  ) {
    const dir = path.join(this.paths().tasks, record.id);
    fs.mkdirSync(dir, { recursive: true });
    const blobs = this.blobStore();
    const bound = key ? { ...key, boundAt: key.boundAt ?? new Date().toISOString() } : null;
    const event = this.event(record.id, 1, type, {
      record: encodeRecord(record, blobs),
      key: bound,
      ...(legacy ? { legacy } : {}),
    });
    const file = this.eventsPath(record.id);
    const existing = readLog(file, 0, null);
    if (existing && existing.events.length > 0)
      throw new Error(`task ${record.id} already has a log`);
    appendEvent(file, event, 0);
    this.indexTask(record, bound, legacy !== null);
  }

  /** Fold the logs that writes marked past AUTO_COMPACT_BYTES (best effort). */
  private compactPending() {
    for (const taskId of this.compactDue) {
      this.compactDue.delete(taskId);
      this.compact(taskId);
    }
  }

  /**
   * Compact a task log to a checkpoint + its last COMPACT_KEEP events. The
   * checkpoint is built without the lock; the task lock is held only to
   * check that the log still holds the events it was built from, carry over
   * events appended meanwhile, and swap the file.
   */
  private compact(taskId: Id): Result<{ folded: number; bytes: number }> {
    try {
      const file = this.eventsPath(taskId);
      const log = readLog(file, 0, null);
      if (!log || log.events.length <= COMPACT_KEEP + 1)
        return success(null, null, { folded: 0, bytes: log?.size ?? 0 });
      const blobs = this.blobStore();
      const cut = log.events.length - COMPACT_KEEP;
      let state: ReducedTask | null = null;
      for (const event of log.events.slice(0, cut)) state = reduce(state, event, blobs);
      const folded = log.events[cut - 1];
      const checkpoint: StoreEvent = {
        ...this.event(taskId, folded.seq, "task.checkpoint", {
          record: encodeRecord(state!.record, blobs),
          key: state!.key,
          ...(state!.legacy ? { legacy: state!.legacy } : {}),
          folded: { from: log.events[0].seq, to: folded.seq },
        }),
      };
      const prefix = `${[checkpoint, ...log.events.slice(cut)].map((event) => JSON.stringify(event)).join("\n")}\n`;
      const last = log.events.at(-1)!;
      return this.withLock(this.taskLockPath(taskId), () => {
        // The log must still hold the events read above (another compaction
        // or a rewrite means start over next time).
        let latest: LogRead | null = null;
        try {
          latest = readLog(file, log.lastStart, last.seq);
        } catch {}
        if (!latest || latest.events[0]?.id !== last.id)
          return failure("busy", "the task log changed during compaction; retry", { taskId });
        const appended = fs.readFileSync(file).subarray(log.end, latest.end);
        const bytes = Buffer.concat([Buffer.from(prefix, "utf8"), appended]);
        replaceFile(file, bytes.toString("utf8"), true);
        // Re-anchor the snapshot on the rewritten log.
        try {
          fs.rmSync(this.snapshotPath(taskId), { force: true });
        } catch {}
        const reloaded = this.load(taskId);
        if (reloaded.ok && reloaded.data) this.writeSnapshot(taskId, reloaded.data);
        return success(null, null, { folded: cut, bytes: bytes.length });
      });
    } catch (error) {
      return failure("storage_error", `compaction failed: ${String(error)}`, { taskId });
    }
  }

  private countEvents(file: string): number {
    try {
      const bytes = fs.readFileSync(file);
      let count = 0;
      for (let index = bytes.indexOf(0x0a); index >= 0; index = bytes.indexOf(0x0a, index + 1))
        count += 1;
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Open tasks bound to `key` anywhere in the store, oldest first (with
   * duplicates, e.g. from a 2.x-era race, the oldest is the one used). A
   * task follows its branch through `git branch -m`: it counts for the new
   * name, and a branch created later under the old name starts fresh.
   */
  private openTasksForKey(key: string): Result<TaskIndexEntry[]> {
    const all = this.listStoreIndex();
    if (!all.ok) return all;
    const location = this.location();
    const renames = location.ok ? branchRenames(location.data) : [];
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

  private openTaskForKey(key: string): Result<TaskIndexEntry | null> {
    const bound = this.openTasksForKey(key);
    return bound.ok ? success(null, null, bound.data[0] ?? null) : bound;
  }

  /** Serialize implicit-task binding for one key across the whole store. */
  private withKeyLock<T>(key: string, operation: () => Result<T>): Result<T> {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return this.withLock(path.join(this.paths().dir, "keys", `${digest}.lock`), operation);
  }

  /** Bind `taskId` to `key` and this checkout (under the checkout lock). */
  private bindLocked(taskId: Id, key: TaskKey, timestamp?: Utc): Result<TaskRecord> {
    const current = this.readWorkspace();
    if (!current.ok) return current;
    let workspace = current.data;
    if (!workspace) {
      workspace = this.nextWorkspace(null);
      const written = this.writeWorkspace(workspace);
      if (!written.ok) return written;
    }
    const target = workspace;
    return this.withLock(this.taskLockPath(taskId), () => {
      const loaded = this.load(taskId);
      if (!loaded.ok) return loaded;
      if (!loaded.data) return failure("not_found", "task not found", { taskId });
      if (loaded.data.record.status === "closed")
        return failure("invalid_transition", "a closed task cannot be adopted", { taskId });
      if (loaded.data.record.workspaceId === target.id && loaded.data.key?.key === key.key)
        return success(loaded.data.record.revision, null, loaded.data.record);
      const next = taskRecordSchema.safeParse({
        ...loaded.data.record,
        workspaceId: target.id,
        revision: newRevision(),
        updatedAt: timestamp ?? now(),
        runtime: stampNew(loaded.data.record),
      });
      if (!next.success) return failure("invalid_input", "rebound task is invalid");
      const written = this.appendPatch(loaded.data, next.data, { key });
      return written.ok ? success(next.data.revision, null, next.data) : written;
    });
  }

  /** Release a task's implicit key (under the checkout lock). */
  private unbindLocked(taskId: Id): Result<null> {
    return this.withLock(this.taskLockPath(taskId), () => {
      const loaded = this.load(taskId);
      if (!loaded.ok) return loaded;
      if (!loaded.data || loaded.data.key === null) return success(null, null, null);
      return this.appendPatch(loaded.data, loaded.data.record, { key: null });
    });
  }

  /** Create a task (under the checkout lock), bound to `key`, or with
   * `bindCurrent` to the checkout's current key. */
  private createLocked(
    value: CreateInput,
    bindCurrent: boolean,
    key: TaskKey | null,
    checkRevision = true,
  ): Result<TaskRecord> {
    const current = this.readWorkspace();
    if (!current.ok) return current;
    if (
      checkRevision &&
      (current.data
        ? value.expectedWorkspaceRevision !== current.data.revision
        : value.expectedWorkspaceRevision !== null)
    )
      return failure(
        "revision_conflict",
        "workspace revision does not match; omit expectedWorkspaceRevision to use the current record",
        {
          expectedWorkspaceRevision: value.expectedWorkspaceRevision,
          actualWorkspaceRevision: current.data?.revision ?? null,
        },
      );
    if (!value.provenance) return failure("invalid_input", "provenance is required");
    if (
      !intentSchema.safeParse(value.intent).success ||
      !provenanceSchema.safeParse(value.provenance).success
    )
      return failure("invalid_input", "task intent or provenance is invalid");
    // An explicitly started task takes the branch over: the task that held
    // its key stays open, unbound (listed by `workit task status --all`).
    if (bindCurrent) {
      const currentKey = this.currentKey();
      if (currentKey.ok)
        return this.withKeyLock(currentKey.data.key, () => {
          const holder = this.openTaskForKey(currentKey.data.key);
          if (!holder.ok) return holder;
          if (holder.data) {
            const released = this.unbindLocked(holder.data.id);
            if (!released.ok) return released;
          }
          return this.newTask(value, current.data, currentKey.data);
        });
    }
    return this.newTask(value, current.data, key);
  }

  /** Write a new task, bound to `binding` (under the checkout lock). */
  private newTask(
    value: CreateInput,
    previous: WorkspaceRecord | null,
    binding: TaskKey | null,
  ): Result<TaskRecord> {
    const current = { data: previous };
    const workspace = this.nextWorkspace(current.data);
    const timestamp = value.now ?? now();
    const task: TaskRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      workspaceId: workspace.id,
      revision: newRevision(),
      createdAt: timestamp,
      updatedAt: timestamp,
      origin: null,
      intent: {
        id: newId(),
        recordedAt: timestamp,
        provenance: value.provenance,
        data: value.intent,
      },
      constraints: [],
      status: "active",
      closure: null,
      progress: { summary: "", nextAction: null, blockers: [] },
      runtime: { createdWith: runtimeVersion(), updatedWith: runtimeVersion() },
      assessments: [],
      policy: null,
      policyChanges: [],
      candidates: [],
      evidence: [],
      decisions: [],
      findings: [],
      workers: [],
    };
    return this.writeNewTask(current.data, workspace, task, "task.opened", binding, {
      operation: "create",
    });
  }

  private nextWorkspace(current: WorkspaceRecord | null, id?: Id): WorkspaceRecord {
    return current
      ? { ...current, revision: newRevision(), root: this.root, runtime: stampNew(current) }
      : {
          schemaVersion: SCHEMA_VERSION,
          id: id ?? newId(),
          revision: newRevision(),
          root: this.root,
          runtime: { createdWith: runtimeVersion(), updatedWith: runtimeVersion() },
        };
  }

  /** Write the workspace, then the task's opening event; undo the workspace on failure. */
  private writeNewTask(
    previous: WorkspaceRecord | null,
    workspace: WorkspaceRecord,
    task: TaskRecord,
    type: string,
    key: TaskKey | null,
    details: { operation: string },
  ): Result<TaskRecord> {
    const written = this.writeWorkspace(workspace);
    if (!written.ok) return written;
    try {
      this.openTask(task, type, key);
    } catch (error) {
      if (previous) {
        const restored = this.writeWorkspace(previous);
        if (!restored.ok)
          return failure(
            "external_outcome_unknown",
            `task ${details.operation} failed and workspace restoration is uncertain`,
            { ...details, outcome: "unknown" },
          );
      }
      return failure(
        "external_outcome_unknown",
        `workspace written but the task log is uncertain: ${String(error)}`,
        { ...details, outcome: "unknown" },
      );
    }
    return success(task.revision, workspace.revision, task);
  }

  private writeWorkspace(record: WorkspaceRecord): Result<null> {
    const file = this.paths().workspace;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      replaceFile(file, `${canonicalJson(record)}\n`, true);
      return success(null, null, null);
    } catch (error) {
      return failure("storage_error", `workspace write failed: ${String(error)}`, { path: file });
    }
  }

  // -------------------------------------------------------------------------
  // internals: index cache

  private readIndex(): Record<string, TaskIndexEntry> {
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
  private writeIndex(entries: TaskIndexEntry[]) {
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

  private indexTask(task: TaskRecord, key: TaskKey | null, legacy: boolean) {
    try {
      const signature = fileSignature(this.eventsPath(task.id));
      if (signature === null) return;
      const tasks = this.readIndex();
      tasks[task.id] = indexEntry(task, key, legacy, signature);
      this.writeIndex(Object.values(tasks));
    } catch {
      // A stale index entry is repaired by the next listing.
    }
  }

  // -------------------------------------------------------------------------
  // internals: record parsing

  private parseTask(record: Record<string, unknown>, taskId: Id): Result<TaskRecord> {
    const parsed = this.parseValue<TaskRecord>(record, taskRecordSchema, "task");
    if (!parsed.ok) return { ...parsed, details: { ...parsed.details, taskId } };
    if (parsed.data.id !== taskId)
      return failure("recovery_required", "task log and record ID differ", { taskId });
    return parsed;
  }

  private parseRecord<T>(
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

  private conflict(expected: Revision, actual: Revision): Result<never> {
    return failure(
      "revision_conflict",
      "snapshot revision does not match; omit expectedRevision to use the current record",
      { expectedRevision: expected, actualRevision: actual },
    );
  }

  private workspaceConflict(expected: Revision, actual: Revision): Result<never> {
    return failure(
      "revision_conflict",
      "workspace revision does not match; omit expectedWorkspaceRevision to use the current record",
      { expectedWorkspaceRevision: expected, actualWorkspaceRevision: actual },
    );
  }

  // -------------------------------------------------------------------------
  // internals: 2.x migration

  /** 2.x stores this checkout may have: `<top>/.workit`, and `<dir>/.workit`
   * when the store was opened from a subdirectory. */
  private v2Dirs(): string[] {
    return [...new Set([this.root, this.origin])].map((dir) => path.join(dir, ".workit"));
  }

  /** 2.x stores waiting to migrate into this checkout. (A pre-git 3.x
   * store is this runtime's own data and moves on any access.) */
  private pendingMigrations(): string[] {
    return this.v2Dirs().filter((dir) => {
      const raw = this.readV2Workspace(path.join(dir, "workspace.json"));
      return raw !== null && raw !== TOMBSTONE;
    });
  }

  /**
   * Migrate the 2.x store in `v2` (tasks/*.json + workspace.json) into this
   * store, under the checkout lock and the 2.x store's own metadata lock (S1
   * identity and reclaim rules), so a live 2.x writer is never migrated
   * under: its lock makes this `busy` and nothing changes.
   *   1. back up the 2.x files to legacy/<checkout>/v2/ (refreshed each run);
   *   2. each task file is migrated by content: a new task becomes
   *      tasks/<id>/events.jsonl with one `migrated.from_v2` event holding the
   *      whole record and the file's digest; a task already migrated from
   *      other bytes (a 2.x write after an interrupted run) gets the
   *      difference appended as another `migrated.from_v2` event;
   *   3. the tasks join this checkout's workspace (the existing 3.x record,
   *      else the 2.x one, so nothing migrated is hidden);
   *   4. each task file is replaced by a marker only while its digest still
   *      matches what was migrated (compare-and-swap under the 2.x lock);
   *   5. `.workit/workspace.json` becomes the marker last, so an interrupted
   *      run is finished by the next one.
   * `.workit/recovery` is left in place (`workit gc` reports it).
   */
  private migrateV2(v2: string): Result<null> {
    const dirs = this.paths();
    const v2Workspace = path.join(v2, "workspace.json");
    const v2Tasks = path.join(v2, "tasks");
    const legacy = path.join(dirs.dir, "legacy", checkoutSlug(path.dirname(v2)), "v2");
    const raw = this.readV2Workspace(v2Workspace);
    if (raw === null || raw === TOMBSTONE) return success(null, null, null);
    return this.withLock(dirs.checkoutLock, () =>
      this.withLock(path.join(v2, "metadata.lock"), () => {
        const workspace = this.readV2Workspace(v2Workspace);
        if (workspace === null || workspace === TOMBSTONE) return success(null, null, null);
        const parsedWorkspace = this.parseRecord<WorkspaceRecord>(
          workspace.bytes,
          workspaceRecordSchema,
          "2.x workspace",
        );
        if (!parsedWorkspace.ok)
          return failure(
            "recovery_required",
            `cannot migrate the 2.x store at ${v2}: ${parsedWorkspace.error}; move it aside to start fresh`,
            { path: v2Workspace },
          );
        let files: string[] = [];
        try {
          files = fs
            .readdirSync(v2Tasks)
            .filter((name) => name.endsWith(".json") && validId(name.slice(0, -5)))
            .filter((name) => !this.isStub(path.join(v2Tasks, name)));
        } catch {}
        const current = this.readWorkspace();
        if (!current.ok) return current;
        let workspaceMoved = false;
        let target = current.data;
        if (!target) {
          target = { ...parsedWorkspace.data, root: this.root };
          const written = this.writeWorkspace(target);
          if (!written.ok) return written;
          workspaceMoved = true;
        }
        let migrated = 0;
        let skipped = 0;
        const done = new Map<string, string>();
        try {
          fs.mkdirSync(path.join(legacy, "tasks"), { recursive: true });
          for (const name of ["workspace.json", "index.json"])
            if (fs.existsSync(path.join(v2, name)))
              fs.copyFileSync(path.join(v2, name), path.join(legacy, name));
          for (const name of files) {
            const id = name.slice(0, -5);
            const file = path.join(v2Tasks, name);
            const bytes = fs.readFileSync(file, "utf8");
            const digest = sha256(bytes);
            fs.writeFileSync(path.join(legacy, "tasks", name), bytes);
            const parsed = this.parseRecord<TaskRecord>(bytes, taskRecordSchema, "2.x task");
            if (!parsed.ok || parsed.data.id !== id)
              return failure(
                "recovery_required",
                `cannot migrate 2.x task ${id}: ${parsed.ok ? "file name and record ID differ" : parsed.error}; move ${file} aside to continue`,
                { path: file },
              );
            const record = { ...parsed.data, workspaceId: target.id };
            const origin = { path: path.join(legacy, "tasks", name), digest };
            if (!fs.existsSync(this.eventsPath(id))) {
              this.openTask(record, "migrated.from_v2", null, origin);
              migrated += 1;
            } else {
              const resynced = this.withLock(this.taskLockPath(id), () => {
                const loaded = this.load(id);
                if (!loaded.ok) return loaded;
                if (!loaded.data) return failure("not_found", "task not found", { taskId: id });
                if (loaded.data.legacy?.digest === digest) return success(null, null, false);
                const appended = this.appendPatch(loaded.data, record, {
                  type: "migrated.from_v2",
                  legacy: origin,
                });
                return appended.ok ? success(null, null, true) : appended;
              });
              if (!resynced.ok) return resynced;
              if (resynced.data) migrated += 1;
              else skipped += 1;
            }
            done.set(name, digest);
          }
        } catch (error) {
          return failure(
            "storage_error",
            `cannot migrate the 2.x store at ${v2}: ${String(error)}`,
            {
              path: v2,
            },
          );
        }
        try {
          // Compare-and-swap: replace a 2.x task file by a marker (so a 2.x
          // reader asked for it by id fails closed) only if it still holds
          // the bytes just migrated; otherwise leave the store unfinished so
          // the next run migrates the change.
          let complete = true;
          for (const [name, digest] of done) {
            const file = path.join(v2Tasks, name);
            if (sha256(fs.readFileSync(file, "utf8")) !== digest) {
              complete = false;
              continue;
            }
            replaceFile(file, this.stubFor(name.slice(0, -5)), false);
          }
          if (!complete)
            return failure("busy", `the 2.x store at ${v2} changed during migration; retry`, {
              path: v2,
            });
          fs.rmSync(path.join(v2, "index.json"), { force: true });
          this.writeTombstone(v2, target.id);
        } catch (error) {
          return failure("storage_error", `cannot finish the 2.x migration: ${String(error)}`, {
            path: v2,
          });
        }
        reportMigration({
          from: v2,
          to: dirs.dir,
          backup: legacy,
          tasks: migrated,
          skipped,
          workspace: workspaceMoved,
        });
        return success(null, null, null);
      }),
    );
  }

  /**
   * A 3.x store kept in `<root>/.workit` while the directory was not a git
   * repository moves into the git store once it is one: task logs, checkout
   * records, blobs and (when the git store has none) the ledger. Entries the
   * git store already has are left in place. The local marker is renamed so
   * this runs once.
   */
  private adoptLocalStore(): Result<null> {
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
  private readV2Workspace(file: string): { bytes: string } | typeof TOMBSTONE | null {
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
  private writeTombstone(v2: string, workspaceId: Id | null) {
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

  /** The marker that replaces a migrated 2.x task file. */
  private stubFor(taskId: Id): string {
    const version = isNewerVersion(runtimeVersion(), STORE_MIN_RUNTIME)
      ? runtimeVersion()
      : STORE_MIN_RUNTIME;
    return `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      id: taskId,
      runtime: { createdWith: version, updatedWith: version },
      store: { format: "workit-store", version: STORE_FORMAT, path: this.paths().dir },
      critical: ["store"],
    })}\n`;
  }

  private isStub(file: string): boolean {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isObject(value) && isObject(value.store) && value.store.format === "workit-store";
    } catch {
      return false;
    }
  }

  /**
   * Every checkout this runtime writes for carries the marker at
   * `<top>/.workit/workspace.json`, so a 2.x runtime never starts a second,
   * divergent store there (it fails closed with the upgrade message).
   */
  private writeTombstoneIfMissing() {
    try {
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

  private withLock<T>(lockPath: string, operation: () => Result<T>): Result<T> {
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
