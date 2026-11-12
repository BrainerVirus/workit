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
// the checkout lock, backup kept). In a git checkout `.workit/` holds only
// committed team config (checks.json, risk-paths), so nothing is written
// there: migrated files and leftovers of older runtimes (2.x tasks and
// recovery copies, the 3.x marker that made 2.x readers fail closed) move
// once into legacy/<slug>/v2/ in the store, and only known markers are
// deleted. Outside git, where `.workit` is the store, the migrated
// `.workit/workspace.json` is replaced by a marker that 2.x readers reject
// with an upgrade message.
//
// TaskStore extends TaskReader (task-read.ts), which holds the reads, the
// layout, record parsing and locks; this file holds the write side.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { hostSessionFromEnv } from "../host-session";
import {
  SCHEMA_VERSION,
  canonicalJson,
  failure,
  intentSchema,
  newId,
  newRevision,
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
  EVENT_VERSION,
  appendEvent,
  readLog,
  replaceFile,
  type EventActor,
  type LogRead,
  type StoreEvent,
} from "../store/event-log";
import { diff } from "../store/patch";
import { checkoutSlug, type TaskKey } from "../store/paths";
import {
  encodeOps,
  encodeRecord,
  eventType,
  reduce,
  type BlobStore,
  type LegacyOrigin,
  type ReducedTask,
} from "../store/reduce";
import { migrationReporterInstalled, reportMigration } from "../store/notes";
import {
  STORE_FORMAT,
  STORE_MIN_RUNTIME,
  TOMBSTONE,
  TaskReader,
  fileSignature,
  indexEntry,
  isNewerVersion,
  isObject,
  runtimeVersion,
  validId,
  type Loaded,
  type Snapshot,
  type TaskReaderOptions,
} from "./task-read";

export {
  MIGRATION_PENDING,
  fileSignature,
  racySignature,
  runtimeVersion,
  sameDirectoryIdentity,
  type TaskIndexEntry,
  type TaskKey,
} from "./task-read";

/** A snapshot is written after this many events since the last one. */
export const SNAPSHOT_EVERY = 32;
/** `gc` compacts a log longer than this many events ... */
export const COMPACT_ABOVE = 200;
/** ... and keeps this many recent events after the checkpoint. */
export const COMPACT_KEEP = 50;
/** An append that leaves the log larger than this compacts it on the spot. */
export const AUTO_COMPACT_BYTES = 2 * 1024 * 1024;

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
export type TaskStoreOptions = TaskReaderOptions & {
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

/**
 * What older runtimes left in a git checkout's `.workit/`: moved into the
 * store's backup (known markers deleted), so `.workit/` keeps only team config.
 */
const CHECKOUT_LEFTOVERS = [
  "workspace.json",
  "index.json",
  "tasks",
  "recovery",
  "metadata.lock",
  "store.moved.json",
  "task-index.json",
  "checkouts",
  "blobs",
  "legacy",
  "ledger",
  "keys",
];
/** The `.gitignore` bodies older runtimes wrote into `.workit/`. */
const GENERATED_GITIGNORES = new Set(["*\n", "*\n!risk-paths\n"]);
/** Every field of a marker this runtime wrote (3.x workspace marker, 2.x task stub, moved store marker). */
const MARKER_FIELDS = {
  workspace: ["schemaVersion", "id", "revision", "root", "runtime", "writer", "store", "critical"],
  stub: ["schemaVersion", "id", "runtime", "store", "critical"],
  moved: ["format", "version", "createdWith"],
} as const;

/** True only for a file holding exactly a marker of `kind`: anything else is data. */
const isKnownMarker = (file: string, kind: keyof typeof MARKER_FIELDS): boolean => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObject(value)) return false;
    const fields: readonly string[] = MARKER_FIELDS[kind];
    if (!Object.keys(value).every((key) => fields.includes(key))) return false;
    if (kind === "moved") return value.format === "workit-store";
    return (
      isObject(value.store) &&
      value.store.format === "workit-store" &&
      JSON.stringify(value.critical) === '["store"]'
    );
  } catch {
    return false;
  }
};

/**
 * Move `from` (file or directory) to `to`, merging into a directory already
 * there. A file whose name is taken keeps both: identical bytes collapse,
 * different ones land beside it under a content suffix. Nothing is lost.
 */
const moveInto = (from: string, to: string): void => {
  if (fs.lstatSync(from).isDirectory()) {
    let target = to;
    if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) target = `${to}.dir`;
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(from))
      moveInto(path.join(from, name), path.join(target, name));
    fs.rmdirSync(from);
    return;
  }
  let target = to;
  if (fs.existsSync(target)) {
    const bytes = fs.readFileSync(from);
    if (fs.lstatSync(target).isFile() && bytes.equals(fs.readFileSync(target))) {
      fs.rmSync(from);
      return;
    }
    target = `${to}.${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
    if (fs.existsSync(target)) {
      fs.rmSync(from);
      return;
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(from, target);
  } catch {
    fs.copyFileSync(from, target);
    fs.rmSync(from);
  }
};

const now = (): Utc => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const stampNew = (record: { runtime?: { createdWith: string | null } }) => ({
  createdWith: record.runtime?.createdWith ?? null,
  updatedWith: runtimeVersion(),
});

const envActor = (): EventActor => {
  const value = (key: string) => process.env[key]?.trim() || null;
  const acting = hostSessionFromEnv(process.env);
  return {
    host: acting.host ?? "runtime",
    session: acting.session,
    agentId: value("WORKIT_AGENT_ID"),
  };
};

export class TaskStore extends TaskReader {
  private readonly actor: EventActor;
  private readonly migrateOnRead: boolean | undefined;
  /** Task logs past AUTO_COMPACT_BYTES, folded after the writing lock is released. */
  private readonly compactDue = new Set<Id>();

  constructor(root: string, options: TaskStoreOptions = {}) {
    super(root, options);
    this.actor = options.actor ?? envActor();
    this.migrateOnRead = options.migrateOnRead;
  }

  // -------------------------------------------------------------------------
  // writes

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
    // In a git store the copies were moved into the backup (settleMigrations).
    const recovery =
      [path.join(this.root, ".workit", "recovery"), path.join(dirs.legacy, "recovery")].find(
        (dir) => fs.existsSync(dir),
      ) ?? null;
    if (recovery) {
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
  // internals: the write side (reads, layout, parsing and locks: TaskReader)

  private taskLockPath(taskId: Id) {
    return path.join(this.paths().tasks, taskId, "lock");
  }

  protected override settleMigrations(write: boolean): Result<null> {
    const moved = this.adoptLocalStore();
    if (!moved.ok) return moved;
    const pending = this.pendingMigrations();
    if (pending.length > 0 && !write && !(this.migrateOnRead ?? migrationReporterInstalled()))
      return this.migrationPending(pending[0]);
    for (const v2 of this.v2Dirs()) {
      const migrated = this.migrateV2(v2);
      if (!migrated.ok) return migrated;
    }
    if (!write && !(this.migrateOnRead ?? migrationReporterInstalled()))
      return success(null, null, null);
    for (const v2 of this.v2Dirs()) {
      const cleared = this.clearCheckoutLeftovers(v2);
      if (!cleared.ok) return cleared;
    }
    return success(null, null, null);
  }

  protected override blobStore(): BlobStore {
    const dir = this.paths().blobs;
    const reader = super.blobStore();
    return {
      read: (digest) => reader.read(digest),
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
   *   4. each task file is removed (git store) or replaced by a marker
   *      (outside git) only while its digest still matches what was migrated
   *      (compare-and-swap under the 2.x lock);
   *   5. `.workit/workspace.json` goes (git store) or becomes the marker
   *      (outside git) last, so an interrupted run is finished by the next one.
   * `.workit/recovery` is kept: clearCheckoutLeftovers moves it into the
   * backup in a git store; `workit gc` reports it either way.
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
            if (dirs.shared) fs.rmSync(file);
            else replaceFile(file, this.stubFor(name.slice(0, -5)), false);
          }
          if (!complete)
            return failure("busy", `the 2.x store at ${v2} changed during migration; retry`, {
              path: v2,
            });
          fs.rmSync(path.join(v2, "index.json"), { force: true });
          // Both are in the backup; a git checkout's `.workit/` keeps no marker.
          if (dirs.shared) fs.rmSync(v2Workspace, { force: true });
          else this.writeTombstone(v2, target.id);
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
   * Once per checkout, empty a git checkout's `.workit/` of what older
   * runtimes left there (CHECKOUT_LEFTOVERS) so it holds only team config:
   * a known marker (the 3.x workspace marker, a 2.x task stub, a moved store
   * marker) and an empty directory are deleted; everything else moves into
   * legacy/<slug>/v2/ in the store. A generated `.gitignore` goes only with
   * the last leftover, so a config the repo still ignores stays ignored until
   * ensureWorkitDir writes it. Outside git `.workit` is the store and is left
   * alone. Idempotent.
   */
  private clearCheckoutLeftovers(v2: string): Result<null> {
    const dirs = this.paths();
    if (!dirs.shared) return success(null, null, null);
    const present = () => CHECKOUT_LEFTOVERS.filter((name) => fs.existsSync(path.join(v2, name)));
    const ignore = path.join(v2, ".gitignore");
    const onlyGeneratedIgnore = () => {
      try {
        return (
          fs.readdirSync(v2).length === 1 &&
          GENERATED_GITIGNORES.has(fs.readFileSync(ignore, "utf8"))
        );
      } catch {
        return false;
      }
    };
    if (present().length === 0 && !onlyGeneratedIgnore()) return success(null, null, null);
    const backup = path.join(dirs.dir, "legacy", checkoutSlug(path.dirname(v2)), "v2");
    return this.withLock(dirs.checkoutLock, () => {
      let moved = 0;
      try {
        for (const name of present()) {
          const entry = path.join(v2, name);
          const marker =
            name === "workspace.json"
              ? isKnownMarker(entry, "workspace")
              : name === "store.moved.json" && isKnownMarker(entry, "moved");
          const empty = fs.lstatSync(entry).isDirectory() && fs.readdirSync(entry).length === 0;
          if (marker || empty) {
            fs.rmSync(entry, { recursive: true });
            continue;
          }
          if (name === "tasks" && fs.lstatSync(entry).isDirectory()) {
            for (const task of fs.readdirSync(entry)) {
              const file = path.join(entry, task);
              if (fs.lstatSync(file).isFile() && isKnownMarker(file, "stub")) fs.rmSync(file);
              else {
                moveInto(file, path.join(backup, "tasks", task));
                moved += 1;
              }
            }
            fs.rmdirSync(entry);
            continue;
          }
          moveInto(entry, path.join(backup, name));
          moved += 1;
        }
        if (onlyGeneratedIgnore()) fs.rmSync(ignore);
        if (fs.readdirSync(v2).length === 0) fs.rmdirSync(v2);
      } catch (error) {
        return failure("storage_error", `cannot clear ${v2}: ${String(error)}`, { path: v2 });
      }
      if (moved > 0)
        reportMigration({ from: v2, to: dirs.dir, backup, tasks: 0, skipped: 0, workspace: false });
      return success(null, null, null);
    });
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
}
