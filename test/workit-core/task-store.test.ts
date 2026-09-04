import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/workit-core/src/core/task-store";
import {
  failure,
  sha256,
  success,
  type TaskRecord,
} from "../../packages/workit-core/src/core/task-contract";
import { ref, scope } from "./task-fixtures";

const fixtureRoot = () => mkdtempSync(join(tmpdir(), "workit-store-"));

test("reads never initialize or repair state", () => {
  const root = fixtureRoot();
  const store = new TaskStore(root);
  expect(store.listTasks()).toEqual(success(null, null, []));
  expect(existsSync(join(root, ".workit"))).toBe(false);
  expect(store.readWorkspace()).toEqual(success(null, null, null));
});

const provenance = {
  kind: "host_observed" as const,
  host: "workit_cli" as const,
  session: null,
  workerId: null,
  receipts: [],
};

const startedStore = () => {
  const store = new TaskStore(fixtureRoot());
  const created = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "test", scope: scope(), authorityRefs: [ref()] },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  return { store, task: created.data };
};

const identity = (task: TaskRecord) => success(task.revision, null, task);
const recoveryEvidence = () => () =>
  success(null, null, { state: "stopped" as const, pid: 0, processStart: null, ownerDigest: null });
const workspaceRevision = (store: TaskStore) => {
  const value = store.readWorkspace();
  if (!value.ok || !value.data) throw new Error("workspace missing");
  return value.data.revision;
};

test("creates snapshots atomically and writes the ignore file only on mutation", () => {
  const { store, task } = startedStore();
  expect(store.readTask(task.id)).toMatchObject({ ok: true, data: { id: task.id } });
  expect(store.readWorkspace()).toMatchObject({ ok: true, data: { id: task.workspaceId } });
  expect(existsSync(join(store.root, ".workit", ".gitignore"))).toBe(true);
});

test("a stale task revision cannot overwrite a newer snapshot", () => {
  const { store, task } = startedStore();
  const first = store.mutateTask(task.id, task.revision, identity);
  expect(first.ok).toBe(true);
  const stale = store.mutateTask(task.id, task.revision, identity);
  expect(stale).toMatchObject({ ok: false, code: "revision_conflict" });
});

test("corrupt current bytes are reported without replacement", () => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  expect(store.readTask(task.id)).toMatchObject({ ok: false, code: "recovery_required" });
  expect(readFileSync(file, "utf8")).toBe("{broken");
});

test("unsupported snapshots and leftover locks stay inspectable", () => {
  const { store, task } = startedStore();
  const workit = join(store.root, ".workit");
  const workspaceFile = join(workit, "workspace.json");
  const workspaceBytes = readFileSync(workspaceFile, "utf8");
  writeFileSync(workspaceFile, JSON.stringify({ schemaVersion: 2 }));
  expect(store.readWorkspace()).toMatchObject({ ok: false, code: "unsupported_version" });
  expect(readFileSync(workspaceFile, "utf8")).toBe(JSON.stringify({ schemaVersion: 2 }));
  writeFileSync(workspaceFile, workspaceBytes);
  writeFileSync(join(workit, "metadata.lock"), JSON.stringify({ pid: 999999, nonce: "x" }));
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
});

test("recovery restores validated bytes with a fresh revision", () => {
  const { store, task } = startedStore();
  const changed = store.mutateTask(task.id, task.revision, identity);
  expect(changed.ok).toBe(true);
  const candidate = store.recoveryCandidates();
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const taskCandidate = candidate.data.find((item) => item.target === "task");
  expect(taskCandidate).toBeDefined();
  if (!taskCandidate) throw new Error("missing task recovery candidate");
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  const recovered = store.recoverTask(task.id, {
    expectedBytes: sha256("{broken"),
    snapshotDigest: taskCandidate.digest,
    reason: "crash recovery",
    authorityRefs: [],
    expectedWorkspaceRevision: workspaceRevision(store),
    processEvidence: recoveryEvidence(),
  });
  expect(recovered.ok).toBe(true);
  if (recovered.ok) expect(recovered.data.revision).not.toBe(task.revision);
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "revision_conflict",
  });
});

test("recovery cannot use caller booleans as process authority", () => {
  const { store, task } = startedStore();
  const changed = store.mutateTask(task.id, task.revision, identity);
  expect(changed.ok).toBe(true);
  const candidate = store.recoveryCandidates();
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const taskCandidate = candidate.data.find((item) => item.target === "task");
  if (!taskCandidate) throw new Error("missing task recovery candidate");
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  const recovered = store.recoverTask(task.id, {
    expectedBytes: sha256("{broken"),
    snapshotDigest: taskCandidate.digest,
    reason: "caller assertion",
    authorityRefs: [],
    expectedWorkspaceRevision: workspaceRevision(store),
    processEvidence: () => failure("recovery_required", "no native evidence"),
    processStopped: true,
  } as any);
  expect(recovered).toMatchObject({ ok: false, code: "recovery_required" });
});

test("recovery rejects a candidate whose bytes do not belong to the task", () => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  const forged = JSON.parse(readFileSync(file, "utf8")) as TaskRecord;
  forged.id = "00000000-0000-4000-8000-000000000099";
  const forgedBytes = `${JSON.stringify(forged)}\n`;
  writeFileSync(
    join(store.root, ".workit", "recovery", `task.${task.id}.${sha256(forgedBytes)}.json`),
    forgedBytes,
  );
  writeFileSync(file, "{broken");
  const recovered = store.recoverTask(task.id, {
    expectedBytes: sha256("{broken"),
    snapshotDigest: sha256(forgedBytes),
    reason: "forged candidate",
    authorityRefs: [],
    expectedWorkspaceRevision: workspaceRevision(store),
    processEvidence: recoveryEvidence(),
  });
  expect(recovered).toMatchObject({ ok: false, code: "recovery_required" });
});

test("workspace recovery requires its own CAS revision and preserves a clean owner", () => {
  const { store, task } = startedStore();
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const changed = store.mutateWorkspace(workspace.data.revision, (current, context) =>
    success(context.revision, context.revision, current),
  );
  expect(changed.ok).toBe(true);
  const candidates = store.recoveryCandidates();
  if (!candidates.ok) throw new Error(candidates.error);
  const candidate = candidates.data.find((item) => item.target === "workspace");
  if (!candidate) throw new Error("missing workspace recovery candidate");
  const file = join(store.root, ".workit", "workspace.json");
  writeFileSync(file, "{broken");
  const recovered = store.recoverWorkspace({
    expectedBytes: sha256("{broken"),
    snapshotDigest: candidate.digest,
    expectedWorkspaceRevision: workspace.data.revision,
    reason: "workspace recovery",
    authorityRefs: [],
    processEvidence: recoveryEvidence(),
  });
  expect(recovered).toMatchObject({ ok: true, data: { writer: null } });
  void task;
});

test("recovery rejects malformed or mutated process evidence", () => {
  const { store, task } = startedStore();
  const changed = store.mutateTask(task.id, task.revision, identity);
  expect(changed.ok).toBe(true);
  const candidate = store.recoveryCandidates();
  if (!candidate.ok) throw new Error(candidate.error);
  const taskCandidate = candidate.data.find((item) => item.target === "task");
  if (!taskCandidate) throw new Error("missing task recovery candidate");
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  writeFileSync(
    join(store.root, ".workit", "metadata.lock"),
    JSON.stringify({ pid: 999999, processStart: "old", host: "test", nonce: "n" }),
  );
  expect(
    store.recoverTask(task.id, {
      expectedBytes: sha256("{broken"),
      snapshotDigest: taskCandidate.digest,
      expectedWorkspaceRevision: workspaceRevision(store),
      reason: "bad evidence",
      authorityRefs: [],
      processEvidence: (lock) => {
        try {
          if (lock) (lock as any).pid = 1;
        } catch {}
        return success(null, null, { state: "invalid", pid: 0 } as any);
      },
    }),
  ).toMatchObject({ ok: false, code: "recovery_required" });
});

test("recovery rejects symlink and cross-workspace candidates", () => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  const candidatePath = join(
    store.root,
    ".workit",
    "recovery",
    `task.${task.id}.${sha256("symlink")}.json`,
  );
  const target = join(store.root, ".workit", "tasks", "other.json");
  writeFileSync(target, "{broken");
  symlinkSync(target, candidatePath);
  writeFileSync(file, "{broken");
  expect(
    store.recoverTask(task.id, {
      expectedBytes: sha256("{broken"),
      snapshotDigest: sha256("symlink"),
      expectedWorkspaceRevision: workspaceRevision(store),
      reason: "symlink",
      authorityRefs: [],
      processEvidence: recoveryEvidence(),
    }),
  ).toMatchObject({ ok: false, code: "recovery_required" });
});

test("corrupt workspace recovery rejects an untrusted workspace identity", () => {
  const { store } = startedStore();
  const workspaceFile = join(store.root, ".workit", "workspace.json");
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const forged = JSON.parse(readFileSync(workspaceFile, "utf8")) as Record<string, unknown>;
  forged.id = "00000000-0000-4000-8000-000000000099";
  const forgedBytes = `${JSON.stringify(forged)}\n`;
  const digest = sha256(forgedBytes);
  writeFileSync(
    join(store.root, ".workit", "recovery", `workspace.workspace.${digest}.json`),
    forgedBytes,
  );
  writeFileSync(workspaceFile, "{broken");
  expect(
    store.recoverWorkspace({
      expectedBytes: sha256("{broken"),
      snapshotDigest: digest,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "forged workspace",
      authorityRefs: [],
      processEvidence: recoveryEvidence(),
    }),
  ).toMatchObject({ ok: false, code: "recovery_required" });
});

test("stale valid-lock recovery requires matching process identity evidence", () => {
  const { store, task } = startedStore();
  const changed = store.mutateTask(task.id, task.revision, identity);
  expect(changed.ok).toBe(true);
  const candidate = store.recoveryCandidates();
  if (!candidate.ok) throw new Error(candidate.error);
  const taskCandidate = candidate.data.find((item) => item.target === "task");
  if (!taskCandidate) throw new Error("missing task recovery candidate");
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  writeFileSync(
    join(store.root, ".workit", "metadata.lock"),
    JSON.stringify({ pid: 999999, processStart: "old", host: "test", nonce: "n" }),
  );
  const recovered = store.recoverTask(task.id, {
    expectedBytes: sha256("{broken"),
    snapshotDigest: taskCandidate.digest,
    expectedWorkspaceRevision: workspaceRevision(store),
    reason: "stale lock",
    authorityRefs: [],
    processEvidence: (lock) => {
      expect(lock).toMatchObject({ pid: 999999, processStart: "old", nonce: "n" });
      return success(null, null, {
        state: "stopped",
        pid: 999999,
        processStart: "old",
        ownerDigest: null,
      });
    },
  });
  expect(recovered.ok).toBe(true);
});

test("failed replacement retains exact prior bytes in recovery", () => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  const before = readFileSync(file);
  const result = store.mutateTask(task.id, task.revision, (current, context) => {
    unlinkSync(file);
    mkdirSync(file);
    return success(context.revision, null, current);
  });
  expect(result).toMatchObject({ ok: false, code: "storage_error" });
  const recovery = store.recoveryCandidates();
  if (!recovery.ok) throw new Error(recovery.error);
  const candidate = recovery.data.find((item) => item.target === "task");
  expect(candidate).toBeDefined();
  if (candidate) expect(readFileSync(candidate.path)).toEqual(before);
});

test("recovery rechecks bytes after reacquiring its lock", () => {
  const { store, task } = startedStore();
  const changed = store.mutateTask(task.id, task.revision, identity);
  expect(changed.ok).toBe(true);
  const candidate = store.recoveryCandidates();
  if (!candidate.ok) throw new Error(candidate.error);
  const taskCandidate = candidate.data.find((item) => item.target === "task");
  if (!taskCandidate) throw new Error("missing task recovery candidate");
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  const raced = "{another-writer-won}";
  const result = store.recoverTask(task.id, {
    expectedBytes: sha256("{broken"),
    snapshotDigest: taskCandidate.digest,
    expectedWorkspaceRevision: workspaceRevision(store),
    reason: "race",
    authorityRefs: [],
    processEvidence: () => {
      writeFileSync(file, raced);
      return recoveryEvidence()();
    },
  });
  expect(result).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(readFileSync(file, "utf8")).toBe(raced);
});

test("coupled mutation retains uncertain workspace ownership after task failure", () => {
  const { store, task } = startedStore();
  const workspace = store.readWorkspace();
  expect(workspace.ok).toBe(true);
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const result = store.mutateTaskAndWorkspace({
    taskId: task.id,
    expectedTaskRevision: task.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workspace: (current, context) =>
      success(context.revision, context.revision, {
        ...current,
        writer: {
          state: "held",
          acquiredAt: context.now,
          owner: {
            taskId: task.id,
            workerId: null,
            session: { kind: "host", host: "workit_cli", handle: "test" },
          },
        },
      }),
    task: () => {
      throw new Error("simulated task failure");
    },
  });
  expect(result).toMatchObject({ ok: false, code: "external_outcome_unknown" });
  expect(store.readWorkspace()).toMatchObject({
    ok: true,
    data: { writer: { state: "uncertain" } },
  });
});
