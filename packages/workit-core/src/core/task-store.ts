import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import * as z from "zod";
import {
  acquireFileLockSync,
  type FileLockSyncHandle,
  type FileLockSyncAcquireOptions,
} from "@openclaw/fs-safe/file-lock";
import {
  SCHEMA_VERSION,
  canonicalJson,
  failure,
  intentSchema,
  newId,
  newRevision,
  provenanceSchema,
  refSchema,
  sha256,
  success,
  taskRecordSchema,
  workspaceRecordSchema,
  type Id,
  type Intent,
  type Ref,
  type Provenance,
  type Result,
  type Revision,
  type TaskRecord,
  type Utc,
  type WorkspaceRecord,
} from "./task-contract";

export type MutationContext = { now: Utc; revision: Revision };
export type TaskMutation = (task: TaskRecord, context: MutationContext) => Result<TaskRecord>;
export type WorkspaceMutation = (
  workspace: WorkspaceRecord,
  context: MutationContext,
) => Result<WorkspaceRecord>;
export type CoupledMutation = {
  taskId: Id;
  expectedTaskRevision?: Revision;
  expectedRevision?: Revision;
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
export type RecoveryInput = {
  expectedBytes: string;
  snapshotDigest: string;
  reason: string;
  authorityRefs: Ref[];
  expectedWorkspaceRevision: Revision;
  processEvidence: (
    lock: MetadataLock | null,
    writer: WorkspaceRecord["writer"],
  ) => Result<ProcessEvidence>;
};
export type MetadataLock = {
  pid: number;
  processStart: string | null;
  host: string;
  nonce: string;
};
export type ProcessEvidence = {
  state: "stopped" | "accounted_for";
  pid: number;
  processStart: string | null;
  ownerDigest: string | null;
};
const processEvidenceSchema = z
  .object({
    state: z.enum(["stopped", "accounted_for"]),
    pid: z.number().int().nonnegative(),
    processStart: z.string().nullable(),
    ownerDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();
const metadataLockSchema = z
  .object({
    pid: z.number().int().nonnegative().safe(),
    processStart: z.string().nullable(),
    host: z.string().min(1),
    nonce: z.string().min(1),
  })
  .strict();
export type RecoveryCandidate = {
  target: "task" | "workspace";
  path: string;
  digest: string;
};

const now = (): Utc => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const jsonBytes = (value: unknown): string => `${canonicalJson(value)}\n`;
const digestBytes = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const validId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const validDigest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const parseMetadataLock = (raw: string): MetadataLock => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("metadata lock is invalid"), { code: "metadata_lock_invalid" });
  }
  const parsed = metadataLockSchema.safeParse(value);
  if (!parsed.success)
    throw Object.assign(new Error("metadata lock is invalid"), { code: "metadata_lock_invalid" });
  return parsed.data;
};
const sameMetadataLock = (left: unknown, right: MetadataLock): boolean => {
  const parsed = metadataLockSchema.safeParse(left);
  return parsed.success && canonicalJson(parsed.data) === canonicalJson(right);
};
type LockSnapshot = { raw: string; data: MetadataLock };

export class TaskStore {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  }

  readTask(taskId: Id): Result<TaskRecord> {
    if (!validId(taskId)) return failure("invalid_input", "task ID is invalid", { taskId });
    const result = this.readRecord<TaskRecord>(
      path.join(this.tasksDir, `${taskId}.json`),
      taskRecordSchema,
    );
    if (!result.exists) return failure("not_found", "task not found", { taskId });
    if (result.result.ok && result.result.data.id !== taskId)
      return failure("recovery_required", "task filename and record ID differ", { taskId });
    if (result.result.ok) {
      const workspace = this.readWorkspace();
      if (!workspace.ok) return workspace as Result<never>;
      if (!workspace.data || result.result.data.workspaceId !== workspace.data.id)
        return failure("recovery_required", "task workspace binding is invalid", { taskId });
    }
    return result.result;
  }

  listTasks(): Result<TaskRecord[]> {
    if (!fs.existsSync(this.tasksDir)) return success(null, null, []);
    let names: string[];
    try {
      names = fs.readdirSync(this.tasksDir).filter((name) => name.endsWith(".json"));
    } catch (error) {
      return failure("storage_error", `unable to list tasks: ${String(error)}`, {
        path: this.tasksDir,
      });
    }
    const workspace = this.readWorkspace();
    if (!workspace.ok) return workspace as Result<never>;
    if (!workspace.data)
      return failure("recovery_required", "task workspace binding is invalid", {
        path: this.workspacePath,
      });
    const tasks: TaskRecord[] = [];
    for (const name of names.sort()) {
      const item = this.readRecord<TaskRecord>(path.join(this.tasksDir, name), taskRecordSchema);
      if (!item.exists) continue;
      if (!item.result.ok) return item.result;
      if (!validId(name.slice(0, -5)) || item.result.data.id !== name.slice(0, -5))
        return failure("recovery_required", "task filename and record ID differ", { path: name });
      if (item.result.data.workspaceId !== workspace.data.id)
        return failure("recovery_required", "task workspace binding is invalid", { path: name });
      tasks.push(item.result.data);
    }
    return success(null, null, tasks);
  }

  readWorkspace(): Result<WorkspaceRecord | null> {
    const item = this.readRecord<WorkspaceRecord>(this.workspacePath, workspaceRecordSchema);
    if (!item.exists) return success(null, null, null);
    if (item.result.ok && item.result.data.root !== this.root)
      return failure("recovery_required", "workspace root binding is invalid", {
        path: this.workspacePath,
      });
    return item.result;
  }

  create(
    input: CreateInput | Intent,
    provenance?: Provenance,
    expectedWorkspaceRevision?: Revision | null,
  ) {
    const value: CreateInput =
      "intent" in input
        ? input
        : {
            intent: input,
            provenance: provenance!,
            expectedWorkspaceRevision: expectedWorkspaceRevision ?? null,
          };
    return this.withLock<TaskRecord>(() => {
      const current = this.readWorkspace();
      if (!current.ok) return current;
      if (
        current.data
          ? value.expectedWorkspaceRevision !== current.data.revision
          : value.expectedWorkspaceRevision !== null
      ) {
        return failure("revision_conflict", "workspace revision does not match", {
          expectedWorkspaceRevision: value.expectedWorkspaceRevision,
          actualWorkspaceRevision: current.data?.revision ?? null,
        });
      }
      if (!value.provenance) return failure("invalid_input", "provenance is required");
      if (
        !intentSchema.safeParse(value.intent).success ||
        !provenanceSchema.safeParse(value.provenance).success
      )
        return failure("invalid_input", "task intent or provenance is invalid");
      const previousWorkspaceBytes = current.data ? this.snapshotBytes(this.workspacePath) : null;
      if (current.data && !previousWorkspaceBytes)
        return failure("storage_error", "workspace snapshot disappeared during creation");
      const workspace: WorkspaceRecord = current.data
        ? { ...current.data, revision: newRevision(), root: this.root }
        : {
            schemaVersion: SCHEMA_VERSION,
            id: newId(),
            revision: newRevision(),
            root: this.root,
            writer: null,
          };
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
        assessments: [],
        policy: null,
        policyChanges: [],
        candidates: [],
        evidence: [],
        decisions: [],
        findings: [],
        workers: [],
      };
      const writtenWorkspace = this.replaceSnapshot(
        this.workspacePath,
        workspace,
        previousWorkspaceBytes,
      );
      if (!writtenWorkspace.ok) return writtenWorkspace;
      const writtenTask = this.replaceSnapshot(this.taskPath(task.id), task, null);
      if (!writtenTask.ok) {
        if (current.data && previousWorkspaceBytes) {
          const restored = this.replaceSnapshot(
            this.workspacePath,
            current.data,
            this.snapshotBytes(this.workspacePath),
          );
          if (!restored.ok)
            return failure(
              "external_outcome_unknown",
              "task creation failed and workspace restoration is uncertain",
              { operation: "create", outcome: "unknown" },
            );
        }
        return failure(
          "external_outcome_unknown",
          "workspace created but task write is uncertain",
          { operation: "create", outcome: "unknown" },
        );
      }
      return success(task.revision, workspace.revision, task);
    });
  }

  importTask(input: ImportInput): Result<TaskRecord> {
    return this.withLock<TaskRecord>(() => {
      const current = this.readWorkspace();
      if (!current.ok) return current;
      if (
        current.data
          ? input.expectedWorkspaceRevision !== current.data.revision
          : input.expectedWorkspaceRevision !== null
      )
        return failure("revision_conflict", "workspace revision does not match", {
          expectedWorkspaceRevision: input.expectedWorkspaceRevision,
          actualWorkspaceRevision: current.data?.revision ?? null,
        });
      const previousWorkspaceBytes = current.data ? this.snapshotBytes(this.workspacePath) : null;
      if (current.data && !previousWorkspaceBytes)
        return failure("storage_error", "workspace snapshot disappeared during import");
      const timestamp = input.now ?? now();
      const workspace: WorkspaceRecord = current.data
        ? { ...current.data, revision: newRevision(), root: this.root }
        : {
            schemaVersion: SCHEMA_VERSION,
            id: input.workspaceId ?? newId(),
            revision: newRevision(),
            root: this.root,
            writer: null,
          };
      const task = {
        ...input.task,
        workspaceId: workspace.id,
        revision: newRevision(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const validTask = taskRecordSchema.safeParse(task);
      if (!validTask.success)
        return failure("invalid_input", "imported task does not satisfy its schema");
      const writtenWorkspace = this.replaceSnapshot(
        this.workspacePath,
        workspace,
        previousWorkspaceBytes,
      );
      if (!writtenWorkspace.ok) return writtenWorkspace;
      const writtenTask = this.replaceSnapshot(this.taskPath(task.id), validTask.data, null);
      if (!writtenTask.ok) {
        if (current.data && previousWorkspaceBytes) {
          const restored = this.replaceSnapshot(
            this.workspacePath,
            current.data,
            this.snapshotBytes(this.workspacePath),
          );
          if (!restored.ok)
            return failure(
              "external_outcome_unknown",
              "import failed and workspace restoration is uncertain",
              { operation: "import", outcome: "unknown" },
            );
        }
        return failure(
          "external_outcome_unknown",
          `workspace created but task import is uncertain: ${writtenTask.error}`,
          {
            operation: "import",
            outcome: "unknown",
            path: writtenTask.details.path,
          },
        );
      }
      return success(validTask.data.revision, workspace.revision, validTask.data);
    });
  }

  mutateTask(
    taskId: Id,
    expected: Revision,
    update: TaskMutation,
    timestamp?: Utc,
  ): Result<TaskRecord> {
    return this.withLock(() => {
      const current = this.readTask(taskId);
      if (!current.ok) return current;
      if (current.data.revision !== expected) return this.conflict(expected, current.data.revision);
      const previousBytes = this.snapshotBytes(this.taskPath(taskId));
      if (!previousBytes)
        return failure("storage_error", "task snapshot disappeared during mutation");
      const context = { now: timestamp ?? now(), revision: newRevision() };
      let changed: Result<TaskRecord>;
      try {
        changed = update(current.data, Object.freeze({ ...context }));
      } catch (error) {
        return failure("storage_error", `task mutation failed: ${String(error)}`);
      }
      if (!changed.ok) return changed;
      const record = {
        ...changed.data,
        id: taskId,
        workspaceId: current.data.workspaceId,
        createdAt: current.data.createdAt,
        revision: context.revision,
        updatedAt: context.now,
      };
      const valid = taskRecordSchema.safeParse(record);
      if (!valid.success)
        return failure("invalid_input", "task mutation produced an invalid record");
      const written = this.replaceSnapshot(this.taskPath(taskId), valid.data, previousBytes);
      return written.ok ? success(valid.data.revision, null, valid.data) : written;
    });
  }

  mutateWorkspace(expected: Revision, update: WorkspaceMutation): Result<WorkspaceRecord> {
    return this.withLock(() => {
      const current = this.readWorkspace();
      if (!current.ok) return current;
      if (!current.data) return failure("not_found", "workspace not found");
      if (current.data.revision !== expected) return this.conflict(expected, current.data.revision);
      const previousBytes = this.snapshotBytes(this.workspacePath);
      if (!previousBytes)
        return failure("storage_error", "workspace snapshot disappeared during mutation");
      const context = { now: now(), revision: newRevision() };
      let changed: Result<WorkspaceRecord>;
      try {
        changed = update(current.data, Object.freeze({ ...context }));
      } catch (error) {
        return failure("storage_error", `workspace mutation failed: ${String(error)}`);
      }
      if (!changed.ok) return changed;
      const record = {
        ...changed.data,
        id: current.data.id,
        root: this.root,
        revision: context.revision,
      };
      const valid = workspaceRecordSchema.safeParse(record);
      if (!valid.success)
        return failure("invalid_input", "workspace mutation produced an invalid record");
      const written = this.replaceSnapshot(this.workspacePath, valid.data, previousBytes);
      return written.ok ? success(valid.data.revision, valid.data.revision, valid.data) : written;
    });
  }

  mutateTaskAndWorkspace(input: CoupledMutation): Result<CoupledSnapshot> {
    return this.withLock(() => {
      const task = this.readTask(input.taskId);
      if (!task.ok) return task;
      const workspace = this.readWorkspace();
      if (!workspace.ok) return workspace;
      if (!workspace.data) return failure("not_found", "workspace not found");
      const expectedTaskRevision = input.expectedTaskRevision ?? input.expectedRevision!;
      if (!expectedTaskRevision) return failure("invalid_input", "task revision is required");
      if (task.data.revision !== expectedTaskRevision)
        return this.conflict(expectedTaskRevision, task.data.revision);
      if (workspace.data.revision !== input.expectedWorkspaceRevision)
        return this.conflict(input.expectedWorkspaceRevision, workspace.data.revision);
      const previousWorkspaceBytes = this.snapshotBytes(this.workspacePath);
      const previousTaskBytes = this.snapshotBytes(this.taskPath(input.taskId));
      if (!previousWorkspaceBytes || !previousTaskBytes)
        return failure("storage_error", "snapshot disappeared during coupled mutation");
      const workspaceContext = { now: input.now ?? now(), revision: newRevision() };
      let changedWorkspace: Result<WorkspaceRecord>;
      try {
        changedWorkspace = input.workspace(workspace.data, Object.freeze({ ...workspaceContext }));
      } catch (error) {
        return failure("storage_error", `workspace mutation failed: ${String(error)}`);
      }
      if (!changedWorkspace.ok) return changedWorkspace;
      const nextWorkspace = workspaceRecordSchema.safeParse({
        ...changedWorkspace.data,
        id: workspace.data.id,
        root: this.root,
        revision: workspaceContext.revision,
      });
      if (!nextWorkspace.success)
        return failure("invalid_input", "workspace mutation produced an invalid record");
      const reserved = this.replaceSnapshot(
        this.workspacePath,
        nextWorkspace.data,
        previousWorkspaceBytes,
      );
      if (!reserved.ok) return reserved;
      const taskContext = { now: input.now ?? now(), revision: newRevision() };
      let changedTask: Result<TaskRecord>;
      try {
        changedTask = input.task(task.data, Object.freeze({ ...taskContext }));
      } catch (error) {
        this.markUncertain(nextWorkspace.data);
        return failure(
          "external_outcome_unknown",
          `workspace reserved but task mutation threw: ${String(error)}`,
          { operation: "coupled_mutation", outcome: "unknown" },
        );
      }
      if (!changedTask.ok) {
        this.markUncertain(nextWorkspace.data);
        return failure(
          "external_outcome_unknown",
          "workspace reserved but task update is uncertain",
          { operation: "coupled_mutation", outcome: "unknown" },
        );
      }
      const nextTask = taskRecordSchema.safeParse({
        ...changedTask.data,
        id: input.taskId,
        workspaceId: task.data.workspaceId,
        createdAt: task.data.createdAt,
        revision: taskContext.revision,
        updatedAt: taskContext.now,
      });
      if (!nextTask.success) {
        this.markUncertain(nextWorkspace.data);
        return failure(
          "external_outcome_unknown",
          "workspace reserved but task update is uncertain",
          { operation: "coupled_mutation", outcome: "unknown" },
        );
      }
      const written = this.replaceSnapshot(
        this.taskPath(input.taskId),
        nextTask.data,
        previousTaskBytes,
      );
      if (!written.ok) {
        this.markUncertain(nextWorkspace.data);
        return failure(
          "external_outcome_unknown",
          "workspace reserved but task replacement is uncertain",
          { operation: "coupled_mutation", outcome: "unknown" },
        );
      }
      return success(nextTask.data.revision, nextWorkspace.data.revision, {
        task: nextTask.data,
        workspace: nextWorkspace.data,
      });
    });
  }

  recoveryCandidates(): Result<RecoveryCandidate[]> {
    if (!fs.existsSync(this.recoveryDir)) return success(null, null, []);
    try {
      const candidates: RecoveryCandidate[] = [];
      for (const name of fs.readdirSync(this.recoveryDir)) {
        const match = /^(task|workspace)\.([^.]+)\.([0-9a-f]{64})\.json$/.exec(name);
        if (match)
          candidates.push({
            target: match[1] as "task" | "workspace",
            path: path.join(this.recoveryDir, name),
            digest: match[3],
          });
      }
      return success(null, null, candidates);
    } catch (error) {
      return failure("storage_error", `unable to list recovery: ${String(error)}`, {
        path: this.recoveryDir,
      });
    }
  }

  recoverTask(taskId: Id, input: RecoveryInput): Result<TaskRecord> {
    return this.recover("task", taskId, input);
  }

  recoverWorkspace(input: RecoveryInput): Result<WorkspaceRecord> {
    return this.recover("workspace", null, input);
  }

  private recover(
    target: "task" | "workspace",
    taskId: Id | null,
    input: RecoveryInput,
  ): Result<any> {
    if (taskId !== null && !validId(taskId))
      return failure("invalid_input", "task ID is invalid", { taskId });
    if (
      !input.reason ||
      !Array.isArray(input.authorityRefs) ||
      typeof input.processEvidence !== "function" ||
      !validDigest(input.expectedBytes) ||
      !validDigest(input.snapshotDigest)
    )
      return failure("invalid_input", "recovery authority is invalid");
    if (input.authorityRefs.some((ref) => !refSchema.safeParse(ref).success))
      return failure("invalid_input", "recovery references are invalid");
    try {
      const workspace = this.readWorkspace();
      if (!workspace.ok && target === "task") return workspace;
      const workspaceValue = workspace.ok ? workspace.data : null;
      if (workspaceValue && workspaceValue.revision !== input.expectedWorkspaceRevision)
        return this.conflict(input.expectedWorkspaceRevision, workspaceValue.revision);
      const file = target === "workspace" ? this.workspacePath : this.taskPath(taskId!);
      const currentBytes = this.snapshotBytes(file);
      if (!currentBytes) return failure("not_found", "snapshot not found");
      if (digestBytes(currentBytes) !== input.expectedBytes)
        return failure("revision_conflict", "snapshot bytes do not match expected bytes");
      let selectedBytes = currentBytes;
      if (digestBytes(currentBytes) !== input.snapshotDigest) {
        const candidate = this.findRecovery(target, taskId, input.snapshotDigest, workspaceValue);
        if (!candidate)
          return failure("recovery_required", "validated recovery snapshot not found");
        selectedBytes = candidate;
      }
      const selectedRecord =
        target === "workspace"
          ? this.parseBytes<WorkspaceRecord>(selectedBytes, workspaceRecordSchema)
          : this.parseBytes<TaskRecord>(selectedBytes, taskRecordSchema);
      if (!selectedRecord.ok) return selectedRecord;
      if (target === "workspace") {
        const parsed = selectedRecord as Result<WorkspaceRecord>;
        if (!parsed.ok || parsed.data.root !== this.root)
          return failure("recovery_required", "workspace recovery binding is invalid");
      } else {
        const parsed = selectedRecord as Result<TaskRecord>;
        if (
          !parsed.ok ||
          parsed.data.id !== taskId ||
          !workspaceValue ||
          parsed.data.workspaceId !== workspaceValue.id
        )
          return failure("recovery_required", "task recovery binding is invalid");
      }
      const lock = this.readLockSnapshot();
      if (!lock.ok) return lock;
      const writer =
        target === "workspace"
          ? (selectedRecord.data as WorkspaceRecord).writer
          : (workspaceValue?.writer ?? null);
      const evidence = this.processEvidence(input, lock.data?.data ?? null, writer);
      if (!evidence.ok) return evidence;
      if (
        lock.data &&
        (evidence.data.pid !== lock.data.data.pid ||
          evidence.data.processStart !== lock.data.data.processStart)
      )
        return failure("recovery_required", "process evidence does not match metadata lock");
      if (
        writer &&
        (evidence.data.state !== "accounted_for" ||
          evidence.data.ownerDigest !== sha256(canonicalJson(writer)))
      )
        return failure("recovery_required", "workspace writer is not accounted for");
      const recoveryGate = { reclaimed: false };
      const result = this.withLock<any>(
        (handle) => {
          if (lock.data && !recoveryGate.reclaimed)
            return failure("recovery_required", "metadata lock changed during recovery", {
              path: this.lockPath,
            });
          if (!handle.verifyStillHeld())
            return failure("recovery_required", "metadata lock was compromised", {
              path: this.lockPath,
            });
          const reacquiredBytes = this.snapshotBytes(file);
          if (!reacquiredBytes)
            return failure("recovery_required", "snapshot disappeared during recovery");
          if (digestBytes(reacquiredBytes) !== input.expectedBytes)
            return failure("revision_conflict", "snapshot changed during recovery");
          if (target === "task") {
            const currentWorkspace = this.readWorkspace();
            if (!currentWorkspace.ok || !currentWorkspace.data)
              return failure("recovery_required", "workspace changed during recovery");
            if (currentWorkspace.data.revision !== input.expectedWorkspaceRevision)
              return this.conflict(input.expectedWorkspaceRevision, currentWorkspace.data.revision);
          }
          if (target === "workspace") {
            const parsed = this.parseBytes<WorkspaceRecord>(selectedBytes, workspaceRecordSchema);
            if (!parsed.ok) return parsed;
            const value = { ...parsed.data, revision: newRevision(), writer: null };
            const replaced = this.replaceSnapshot(file, value, reacquiredBytes);
            return replaced.ok ? success(value.revision, value.revision, value) : replaced;
          }
          const parsed = this.parseBytes<TaskRecord>(selectedBytes, taskRecordSchema);
          if (!parsed.ok) return parsed;
          const value = {
            ...parsed.data,
            revision: newRevision(),
            updatedAt: now(),
            status: parsed.data.status === "active" ? "paused" : parsed.data.status,
          } as TaskRecord;
          const replaced = this.replaceSnapshot(file, value, reacquiredBytes);
          return replaced.ok ? success(value.revision, null, value) : replaced;
        },
        this.recoveryLockOptions(lock.data, evidence.data, recoveryGate),
      );
      return result;
    } catch (error) {
      return failure("recovery_required", `recovery protocol failed: ${String(error)}`);
    }
  }

  private processEvidence(
    input: RecoveryInput,
    lock: MetadataLock | null,
    writer: WorkspaceRecord["writer"],
  ): Result<ProcessEvidence> {
    const lockCopy = lock ? this.deepFreeze(structuredClone(lock)) : null;
    const writerCopy = writer ? this.deepFreeze(structuredClone(writer)) : null;
    const lockDigest = lockCopy ? sha256(canonicalJson(lockCopy)) : null;
    const writerDigest = writerCopy ? sha256(canonicalJson(writerCopy)) : null;
    try {
      const result = input.processEvidence(lockCopy, writerCopy);
      if (lockCopy && sha256(canonicalJson(lockCopy)) !== lockDigest)
        return failure("recovery_required", "process evidence mutated lock identity");
      if (writerCopy && sha256(canonicalJson(writerCopy)) !== writerDigest)
        return failure("recovery_required", "process evidence mutated writer identity");
      if (!result.ok) return result;
      const parsed = processEvidenceSchema.safeParse(result.data);
      return parsed.success
        ? success(null, null, parsed.data)
        : failure("recovery_required", "process evidence is invalid");
    } catch (error) {
      return failure("recovery_required", `process evidence failed: ${String(error)}`);
    }
  }

  private deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) this.deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  }

  private readLockSnapshot(): Result<LockSnapshot | null> {
    try {
      const stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink())
        return failure("recovery_required", "metadata lock is not a regular file", {
          path: this.lockPath,
        });
      const raw = fs.readFileSync(this.lockPath, "utf8");
      return success(null, null, { raw, data: parseMetadataLock(raw) });
    } catch (error: any) {
      if (error?.code === "ENOENT") return success(null, null, null);
      return failure("recovery_required", `metadata lock is invalid: ${String(error)}`, {
        path: this.lockPath,
      });
    }
  }

  private metadataLockOptions(): FileLockSyncAcquireOptions<MetadataLock> {
    return {
      lockPath: this.lockPath,
      staleMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 0,
      retry: { retries: 0 },
      staleRecovery: "fail-closed",
      shouldReclaim: () => false,
      parsePayload: parseMetadataLock,
      payload: () => ({
        pid: process.pid,
        processStart: this.processStart(process.pid),
        host: hostname(),
        nonce: randomUUID(),
      }),
    };
  }

  private recoveryLockOptions(
    observed: LockSnapshot | null,
    evidence: ProcessEvidence,
    gate: { reclaimed: boolean },
  ): FileLockSyncAcquireOptions<MetadataLock> {
    const options = this.metadataLockOptions();
    options.staleRecovery = "remove-if-unchanged";
    options.shouldReclaim = ({ payload }) =>
      Boolean(
        observed &&
        sameMetadataLock(payload, observed.data) &&
        (evidence.state === "stopped" || evidence.state === "accounted_for"),
      );
    options.shouldRemoveStaleLock = ({ raw, payload }) => {
      if (!observed || raw !== observed.raw || !sameMetadataLock(payload, observed.data))
        return false;
      gate.reclaimed = true;
      return true;
    };
    return options;
  }

  private markUncertain(workspace: WorkspaceRecord) {
    if (!workspace.writer || workspace.writer.state === "uncertain") return;
    const value = {
      ...workspace,
      writer: { ...workspace.writer, state: "uncertain" as const },
      revision: newRevision(),
    };
    this.replaceSnapshot(this.workspacePath, value, workspace);
  }

  private withLock<T>(
    operation: (handle: FileLockSyncHandle) => Result<T>,
    options: FileLockSyncAcquireOptions<MetadataLock> = this.metadataLockOptions(),
  ): Result<T> {
    try {
      this.initializeMutationStorage();
    } catch (error) {
      return failure("storage_error", `unable to initialize store: ${String(error)}`, {
        path: this.workitDir,
      });
    }
    let handle: FileLockSyncHandle | undefined;
    let result: Result<T> = failure(
      "storage_error",
      "metadata lock operation did not produce a result",
    );
    try {
      handle = acquireFileLockSync(this.workspacePath, options);
    } catch (error) {
      result = this.lockFailure(error);
    }
    if (handle) {
      try {
        if (!handle.verifyStillHeld())
          result = failure("recovery_required", "metadata lock was compromised", {
            path: this.lockPath,
          });
        else {
          try {
            result = operation(handle);
          } catch (error) {
            result = failure("storage_error", `mutation failed: ${String(error)}`);
          }
        }
      } catch (error) {
        result = this.lockFailure(error);
      }
    }
    if (handle) {
      try {
        handle.release();
      } catch (error) {
        const releaseFailure = this.lockFailure(error);
        const releaseError = releaseFailure.ok
          ? "metadata lock release failed"
          : releaseFailure.error;
        result = result.ok
          ? releaseFailure
          : failure("recovery_required", `${result.error}; ${releaseError}`, result.details);
      }
    }
    return result;
  }

  private lockFailure(error: unknown): Result<never> {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value?.code === "string" ? value.code : "";
    const recovery =
      code === "EEXIST" ||
      code === "file_lock_timeout" ||
      code === "file_lock_stale" ||
      code === "metadata_lock_invalid" ||
      code === "not-file" ||
      /metadata lock|file lock|reclaim/i.test(String(value?.message ?? error));
    return failure(
      recovery ? "recovery_required" : "storage_error",
      `metadata lock operation failed: ${String(error)}`,
      { path: this.lockPath },
    );
  }

  private initializeMutationStorage() {
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.mkdirSync(this.recoveryDir, { recursive: true });
    fs.writeFileSync(this.gitignorePath, "*\n");
  }

  private replaceSnapshot(file: string, value: unknown, previous: unknown): Result<any> {
    let temporary: string | undefined;
    try {
      if (Buffer.isBuffer(previous)) this.saveRecovery(file, previous);
      else if (previous !== null && typeof previous === "object")
        this.saveRecovery(file, jsonBytes(previous));
      else if (typeof previous === "string") this.saveRecovery(file, previous);
      temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeSync(fd, jsonBytes(value));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      temporary = undefined;
      this.fsyncDirectory(path.dirname(file));
      return success(null, null, value);
    } catch (error) {
      return failure("storage_error", `snapshot replacement failed: ${String(error)}`, {
        path: file,
      });
    } finally {
      if (temporary)
        try {
          fs.unlinkSync(temporary);
        } catch {}
    }
  }

  private saveRecovery(file: string, bytes: string | Buffer) {
    const target = path.basename(file) === "workspace.json" ? "workspace" : "task";
    const id = target === "task" ? path.basename(file, ".json") : "workspace";
    const destination = path.join(this.recoveryDir, `${target}.${id}.${digestBytes(bytes)}.json`);
    if (fs.existsSync(destination)) {
      if (digestBytes(fs.readFileSync(destination)) === digestBytes(bytes)) return;
      throw new Error("recovery copy already exists with different bytes");
    }
    let temporary: string | undefined;
    try {
      temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeSync(fd, bytes as any);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, destination);
      temporary = undefined;
      this.fsyncDirectory(this.recoveryDir);
    } finally {
      if (temporary)
        try {
          fs.unlinkSync(temporary);
        } catch {}
    }
  }

  private findRecovery(
    target: "task" | "workspace",
    taskId: Id | null,
    digest: string,
    workspace: WorkspaceRecord | null,
  ): Buffer | null {
    if (!fs.existsSync(this.recoveryDir)) return null;
    const workspaceId = workspace?.id ?? this.trustedWorkspaceId();
    if (target === "workspace" && !workspaceId) return null;
    const candidates = this.recoveryCandidates();
    if (!candidates.ok) return null;
    for (const candidate of candidates.data) {
      if (candidate.target !== target || candidate.digest !== digest) continue;
      try {
        if (!fs.lstatSync(candidate.path).isFile()) continue;
        const bytes = fs.readFileSync(candidate.path);
        if (digestBytes(bytes) !== digest) continue;
        if (target === "workspace") {
          const parsed = this.parseBytes<WorkspaceRecord>(bytes, workspaceRecordSchema);
          if (parsed.ok && parsed.data.id === workspaceId && parsed.data.root === this.root)
            return bytes;
        } else {
          const parsed = this.parseBytes<TaskRecord>(bytes, taskRecordSchema);
          if (parsed.ok && parsed.data.id === taskId && parsed.data.workspaceId === workspace?.id)
            return bytes;
        }
      } catch {}
    }
    return null;
  }

  private fsyncDirectory(directory: string) {
    try {
      const fd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      // Windows rejects fsync on a directory handle; the rename is the durable step there.
      if (process.platform !== "win32") throw error;
    }
  }

  private trustedWorkspaceId(): Id | null {
    if (!fs.existsSync(this.tasksDir)) return null;
    const ids = new Set<Id>();
    try {
      for (const name of fs.readdirSync(this.tasksDir)) {
        if (!name.endsWith(".json") || !validId(name.slice(0, -5))) return null;
        const parsed = this.parseBytes<TaskRecord>(
          fs.readFileSync(path.join(this.tasksDir, name)),
          taskRecordSchema,
        );
        if (!parsed.ok || parsed.data.id !== name.slice(0, -5)) return null;
        ids.add(parsed.data.workspaceId);
      }
    } catch {
      return null;
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  private snapshotBytes(file: string): Buffer | null {
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  private readRecord<T>(file: string, schema: { safeParse(value: unknown): any }) {
    try {
      const bytes = fs.readFileSync(file, "utf8");
      return { exists: true, result: this.parseBytes<T>(bytes, schema) };
    } catch (error: any) {
      if (error?.code === "ENOENT")
        return { exists: false, result: success(null, null, null as T) };
      return {
        exists: true,
        result: failure("recovery_required", `snapshot cannot be read: ${String(error)}`, {
          path: file,
        }),
      };
    }
  }

  private parseBytes<T>(
    bytes: string | Buffer,
    schema: { safeParse(value: unknown): any },
  ): Result<T> {
    let value: unknown;
    try {
      value = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
    } catch {
      return failure("recovery_required", "snapshot JSON is corrupt");
    }
    if (isObject(value) && "schemaVersion" in value && value.schemaVersion !== SCHEMA_VERSION)
      return failure("unsupported_version", "unsupported snapshot schema version");
    const parsed = schema.safeParse(value);
    return parsed.success
      ? success(null, null, parsed.data)
      : failure("recovery_required", "snapshot does not satisfy its schema");
  }

  private processStart(pid: number): string | null {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null;
    } catch {
      return null;
    }
  }

  private conflict(expected: Revision, actual: Revision): Result<never> {
    return failure("revision_conflict", "snapshot revision does not match", {
      expectedRevision: expected,
      actualRevision: actual,
    });
  }

  private taskPath(taskId: Id) {
    return path.join(this.tasksDir, `${taskId}.json`);
  }
  private get workitDir() {
    return path.join(this.root, ".workit");
  }
  private get tasksDir() {
    return path.join(this.workitDir, "tasks");
  }
  private get recoveryDir() {
    return path.join(this.workitDir, "recovery");
  }
  private get workspacePath() {
    return path.join(this.workitDir, "workspace.json");
  }
  private get lockPath() {
    return path.join(this.workitDir, "metadata.lock");
  }
  private get gitignorePath() {
    return path.join(this.workitDir, ".gitignore");
  }
}
