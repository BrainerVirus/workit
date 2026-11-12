import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_PENDING, TaskReader } from "@/packages/workit-core/src/core/task-read";
import { TaskStore } from "@/packages/workit-core/src/core/task-store";
import { canonicalJson } from "@/packages/workit-core/src/core/task-contract";
import { storeDirOf } from "./store-files";
import { ref, scope } from "./task-fixtures";

const dirs: string[] = [];
const SLOT = Symbol.for("workit.migrationReporter");
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workit-read-")));
  dirs.push(root);
  const run = spawnSync("git", ["init", "-q", "-b", "feature/read", root], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return root;
};

const provenance = {
  kind: "host_observed" as const,
  host: "workit_cli" as const,
  session: null,
  workerId: null,
};

const created = (root: string) => {
  const store = new TaskStore(root);
  const task = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "read me", scope: scope(), authorityRefs: [ref()] },
  });
  if (!task.ok) throw new Error(task.error);
  return { store, task: task.data };
};

// Every public TaskStore method that appends an event or writes a record.
const WRITES = [
  "create",
  "importTask",
  "mutateTask",
  "mutateWorkspace",
  "mutateTaskAndWorkspace",
  "collectGarbage",
  "implicitTask",
  "adoptTask",
];

test("Given a TaskReader, Then it has none of TaskStore's write methods, and a TaskStore is a TaskReader", () => {
  const reader = new TaskReader(repo()) as unknown as Record<string, unknown>;
  for (const name of WRITES) expect(typeof reader[name], name).toBe("undefined");
  const store = new TaskStore(repo()) as unknown as Record<string, unknown>;
  for (const name of WRITES) expect(typeof store[name], name).toBe("function");
  expect(store).toBeInstanceOf(TaskReader);
});

test("Given a task TaskStore wrote, When a TaskReader reads the checkout, Then it sees the same task, index, workspace and key", () => {
  const root = repo();
  const { store, task } = created(root);
  const reader = new TaskReader(root);
  expect(reader.root).toBe(store.root);
  expect(reader.readTask(task.id)).toEqual(store.readTask(task.id));
  expect(reader.readStoreTask(task.id)).toEqual(store.readStoreTask(task.id));
  expect(reader.listTaskIndex()).toEqual(store.listTaskIndex());
  expect(reader.listTasks()).toEqual(store.listTasks());
  expect(reader.readWorkspace()).toEqual(store.readWorkspace());
  expect(reader.currentKey()).toEqual(store.currentKey());
  expect(reader.originTaskEntry()).toEqual(store.originTaskEntry());
});

/** Turn the checkout's 3.x store into a pending 2.x `.workit` store. */
const pendingV2 = (root: string): string => {
  const { store, task } = created(root);
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("fixture");
  rmSync(storeDirOf(root), { recursive: true, force: true });
  mkdirSync(join(root, ".workit", "tasks"), { recursive: true });
  writeFileSync(join(root, ".workit", "workspace.json"), `${canonicalJson(workspace.data)}\n`);
  writeFileSync(join(root, ".workit", "tasks", `${task.id}.json`), `${canonicalJson(task)}\n`);
  return task.id;
};

test("Given a pending 2.x store and a host that reports migrations, When a TaskReader lists tasks, Then it reports the migration as pending and leaves the 2.x store in place, while TaskStore migrates it", () => {
  const root = repo();
  const id = pendingV2(root);
  (globalThis as Record<symbol, unknown>)[SLOT] = () => {};
  const listed = new TaskReader(root).listTaskIndex();
  expect(listed).toMatchObject({ ok: false, code: "needs_input" });
  expect(listed.ok ? "" : listed.error).toStartWith(MIGRATION_PENDING);
  expect(existsSync(join(root, ".workit", "workspace.json"))).toBe(true);
  const migrated = new TaskStore(root).listTaskIndex();
  expect(migrated.ok && migrated.data.map((entry) => entry.id)).toEqual([id]);
  expect(existsSync(join(root, ".workit", "workspace.json"))).toBe(false);
  expect(new TaskReader(root).readTask(id)).toMatchObject({ ok: true, data: { id } });
});
