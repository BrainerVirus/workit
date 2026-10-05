import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@/packages/workit-core/src/core/task-store";
import { eventsOf, eventsFileOf, rewriteTaskLog, workspaceFileOf } from "./store-files";
import { success, type TaskRecord } from "@/packages/workit-core/src/core/task-contract";
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

test("workspace root binding accepts another path to the same directory", () => {
  const root = fixtureRoot();
  const store = new TaskStore(root);
  const created = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "test", scope: scope(), authorityRefs: [ref()] },
  });
  if (!created.ok) throw new Error(created.error);
  const workspacePath = workspaceFileOf(store.root);
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8")) as Record<string, unknown>;
  const alias = `${root}-alias`;
  try {
    if (process.platform === "win32") workspace.root = root.toUpperCase();
    else symlinkSync(root, alias, "dir");
    if (process.platform !== "win32") workspace.root = alias;
    writeFileSync(workspacePath, JSON.stringify(workspace));
    expect(store.readWorkspace().ok).toBe(true);
  } finally {
    if (process.platform !== "win32") rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const identity = (task: TaskRecord) => success(task.revision, null, task);

test("creates snapshots atomically and writes the ignore file only on mutation", () => {
  const { store, task } = startedStore();
  expect(store.readTask(task.id)).toMatchObject({
    ok: true,
    data: { id: task.id },
  });
  expect(store.readWorkspace()).toMatchObject({
    ok: true,
    data: { id: task.workspaceId },
  });
  expect(existsSync(join(store.root, ".workit", ".gitignore"))).toBe(true);
});

test("new tasks preserve the workspace identity while advancing its CAS revision", () => {
  const root = fixtureRoot();
  const store = new TaskStore(root);
  const first = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "first", scope: scope(), authorityRefs: [ref()] },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  const before = store.readWorkspace();
  expect(before.ok).toBe(true);
  if (!before.ok || !before.data) throw new Error("workspace missing");
  const second = store.create({
    expectedWorkspaceRevision: before.data.revision,
    provenance,
    intent: { objective: "second", scope: scope(), authorityRefs: [ref()] },
  });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.error);
  const after = store.readWorkspace();
  expect(after.ok).toBe(true);
  if (!after.ok || !after.data) throw new Error("workspace missing after second task");
  expect(second.data.workspaceId).toBe(before.data.id);
  expect(after.data.id).toBe(before.data.id);
  expect(after.data.revision).not.toBe(before.data.revision);
  expect(store.listTasks()).toMatchObject({
    ok: true,
    data: expect.arrayContaining([
      expect.objectContaining({ id: first.data.id }),
      expect.objectContaining({ id: second.data.id }),
    ]),
  });
});

test("a stale task revision cannot overwrite a newer snapshot", () => {
  const { store, task } = startedStore();
  const first = store.mutateTask(task.id, task.revision, identity);
  expect(first.ok).toBe(true);
  const stale = store.mutateTask(task.id, task.revision, identity);
  expect(stale).toMatchObject({ ok: false, code: "revision_conflict" });
});

test("a task bound to another checkout is not this checkout's: reads and writes say where it belongs", () => {
  const { store, task } = startedStore();
  rewriteTaskLog(store.root, task.id, {
    ...task,
    workspaceId: "00000000-0000-4000-8000-000000000099",
  });
  const read = store.readTask(task.id);
  expect(read).toMatchObject({ ok: false, code: "not_found" });
  expect(!read.ok && read.error).toContain(`workit task adopt ${task.id}`);
  expect(store.listTasks()).toMatchObject({ ok: true, data: [] });
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "not_found",
  });
});

test("an unreadable event before the last line is damage: reported, never rewritten", () => {
  const { store, task } = startedStore();
  const file = eventsFileOf(store.root, task.id);
  const bytes = `{broken}\n${readFileSync(file, "utf8")}`;
  writeFileSync(file, bytes);
  rmSync(join(store.root, ".workit", "tasks", task.id, "snapshot.json"), {
    force: true,
  });
  expect(store.readTask(task.id)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

test("unsupported snapshots stay inspectable and a leftover stale lock no longer blocks writes", () => {
  const { store, task } = startedStore();
  const workspaceFile = workspaceFileOf(store.root);
  const workspaceBytes = readFileSync(workspaceFile, "utf8");
  writeFileSync(workspaceFile, JSON.stringify({ schemaVersion: 2 }));
  expect(store.readWorkspace()).toMatchObject({
    ok: false,
    code: "unsupported_version",
  });
  expect(readFileSync(workspaceFile, "utf8")).toBe(JSON.stringify({ schemaVersion: 2 }));
  writeFileSync(workspaceFile, workspaceBytes);
  const lockPath = join(store.root, ".workit", "tasks", task.id, "lock");
  const lockBytes = JSON.stringify({
    pid: 999999,
    processStart: "old",
    host: "test",
    nonce: "x",
  });
  writeFileSync(lockPath, lockBytes);
  utimesSync(lockPath, new Date(0), new Date(0));
  expect(store.readTask(task.id)).toMatchObject({ ok: true });
  expect(readFileSync(lockPath, "utf8")).toBe(lockBytes);
  // A foreign-host lock past its TTL has no provable owner: the write reclaims it.
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: true,
  });
  expect(existsSync(lockPath)).toBe(false);
});

test("coupled mutation reports an unknown outcome when the task step throws", () => {
  const { store, task } = startedStore();
  const workspace = store.readWorkspace();
  expect(workspace.ok).toBe(true);
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const result = store.mutateTaskAndWorkspace({
    taskId: task.id,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: workspace.data.revision,
    workspace: (current, context) => success(context.revision, context.revision, current),
    task: () => {
      throw new Error("simulated task failure");
    },
  });
  expect(result).toMatchObject({ ok: false, code: "external_outcome_unknown" });
});

test("unknown fields in a logged record survive later appends; critical ones fail closed", () => {
  const { store, task } = startedStore();
  const stored = store.readTask(task.id);
  if (!stored.ok) throw new Error(stored.error);
  rewriteTaskLog(store.root, task.id, { ...stored.data, futureField: 1 });
  // Reads tolerate the unknown field (D17)...
  const read = store.readTask(task.id);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(read.error);
  // ...and an append is a patch, so the field this runtime cannot represent is kept.
  expect(store.mutateTask(task.id, read.data.revision, identity).ok).toBe(true);
  const events = eventsOf(store.root, task.id);
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events[1].data.ops)).not.toContain("futureField");
  // A field the writer declares critical makes this reader fail closed.
  rewriteTaskLog(store.root, task.id, {
    ...stored.data,
    futureField: 1,
    critical: ["futureField"],
  });
  const refused = store.readTask(task.id);
  expect(refused).toMatchObject({ ok: false, code: "recovery_required" });
  expect(!refused.ok && refused.error).toContain("upgrade Workit");
  expect(store.mutateTask(task.id, stored.data.revision, identity)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
});
