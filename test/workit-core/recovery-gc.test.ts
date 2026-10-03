import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RECOVERY_COPIES_PER_RECORD, TaskStore } from "@/packages/workit-core/src/core/task-store";
import {
  boundedOperationJsonSchema,
  candidateDigest,
  operationJsonSchema,
  parseOperation,
  sha256,
  success,
  type Candidate,
  type TaskRecord,
} from "@/packages/workit-core/src/core/task-contract";
import { ref, scope } from "./task-fixtures";

// Bounded recovery (spec "Bounded state"): recovery copies are capped per
// record, `workit gc` prunes what older versions left behind, and nothing a
// current read needs is ever deleted.

const provenance = {
  kind: "host_observed" as const,
  host: "workit_cli" as const,
  session: null,
  workerId: null,
  receipts: [],
};

const startedStore = () => {
  const store = new TaskStore(mkdtempSync(join(tmpdir(), "workit-gc-")));
  const created = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "gc test", scope: scope(), authorityRefs: [ref()] },
  });
  if (!created.ok) throw new Error(created.error);
  return { store, task: created.data };
};

const recoveryDir = (store: TaskStore) => join(store.root, ".workit", "recovery");
const copiesFor = (store: TaskStore, prefix: string) =>
  readdirSync(recoveryDir(store)).filter((name) => name.startsWith(prefix));

const touch = (task: TaskRecord, summary: string) =>
  success(task.revision, null, { ...task, progress: { ...task.progress, summary } });

const writesLeaveBoundedCopies = (writes: number) => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  let revision = task.revision;
  let previous = "";
  for (let write = 0; write < writes; write += 1) {
    previous = readFileSync(file, "utf8");
    const result = store.mutateTask(task.id, revision, (current) => touch(current, `w${write}`));
    if (!result.ok) throw new Error(result.error);
    revision = result.data.revision;
  }
  const copies = copiesFor(store, `task.${task.id}.`);
  expect(copies.length).toBeLessThanOrEqual(RECOVERY_COPIES_PER_RECORD);
  expect(copies).toContain(`task.${task.id}.${sha256(previous)}.json`);
};

// 20 writes already exceed the cap several times over; the 1,000-write
// version is an opt-in soak (WORKIT_SOAK=1) because it is fsync-bound.
test(`Given 20 writes to one task, Then at most ${RECOVERY_COPIES_PER_RECORD} recovery copies remain and the latest prior bytes are kept`, () =>
  writesLeaveBoundedCopies(20));

test.skipIf(process.env.WORKIT_SOAK !== "1")(
  `Given 1,000 writes to one task (soak), Then at most ${RECOVERY_COPIES_PER_RECORD} recovery copies remain`,
  () => writesLeaveBoundedCopies(1000),
  300_000,
);

const seedStaleCopies = (store: TaskStore, prefix: string, count: number) => {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = `{"stale":${index}}\n`;
    const name = `${prefix}${sha256(bytes)}.json`;
    writeFileSync(join(recoveryDir(store), name), bytes);
    // Oldest first: index 0 is the oldest copy.
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    utimesSync(join(recoveryDir(store), name), when, when);
    names.push(name);
  }
  return names;
};

test("Given a recovery dir with N stale copies per record, When gc runs, Then each record keeps only the newest copies up to the cap", () => {
  const { store, task } = startedStore();
  const taskCopies = seedStaleCopies(store, `task.${task.id}.`, 40);
  const workspaceCopies = seedStaleCopies(store, "workspace.workspace.", 25);
  const before = readdirSync(recoveryDir(store)).length;
  const result = store.collectGarbage();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(copiesFor(store, `task.${task.id}.`).sort()).toEqual(taskCopies.slice(-3).sort());
  expect(copiesFor(store, "workspace.workspace.").sort()).toEqual(workspaceCopies.slice(-3).sort());
  expect(result.data.recovery.removed).toBe(before - readdirSync(recoveryDir(store)).length);
});

test("Given gc --dry-run, Then it reports what it would remove and writes nothing at all", () => {
  const { store, task } = startedStore();
  seedStaleCopies(store, `task.${task.id}.`, 10);
  const workit = join(store.root, ".workit");
  // No lock, no storage initialization: the .gitignore stays deleted.
  rmSync(join(workit, ".gitignore"));
  const listing = () =>
    readdirSync(workit, { recursive: true })
      .map(String)
      .sort()
      .map((name) => `${name}:${statSync(join(workit, name)).mtimeMs}`);
  const before = listing();
  const result = store.collectGarbage({ dryRun: true });
  expect(result).toMatchObject({ ok: true, data: { dryRun: true } });
  if (!result.ok) throw new Error(result.error);
  expect(result.data.recovery.removed).toBeGreaterThan(0);
  expect(listing()).toEqual(before);
  expect(existsSync(join(workit, ".gitignore"))).toBe(false);
  expect(existsSync(join(workit, "metadata.lock"))).toBe(false);
});

test("Given gc runs, Then every current read returns the same records", () => {
  const { store, task } = startedStore();
  seedStaleCopies(store, `task.${task.id}.`, 12);
  const tasksDir = join(store.root, ".workit", "tasks");
  const bytesBefore = readdirSync(tasksDir).map((name) => readFileSync(join(tasksDir, name)));
  const workspaceBefore = readFileSync(join(store.root, ".workit", "workspace.json"));
  const listBefore = store.listTasks();
  expect(store.collectGarbage().ok).toBe(true);
  expect(store.listTasks()).toEqual(listBefore);
  expect(store.readTask(task.id)).toMatchObject({ ok: true, data: { revision: task.revision } });
  expect(readdirSync(tasksDir).map((name) => readFileSync(join(tasksDir, name)))).toEqual(
    bytesBefore,
  );
  expect(readFileSync(join(store.root, ".workit", "workspace.json"))).toEqual(workspaceBefore);
});

const candidate = (head: string): Candidate => {
  const value = {
    id: "0".repeat(64),
    scope: scope(),
    completeness: "known" as const,
    files: [],
    environment: [],
    head,
  };
  return { ...value, id: candidateDigest(value) };
};

test("Given paused, active, and closed tasks with duplicate stored candidates, When gc runs, Then only the paused task collapses to its latest positions", () => {
  const { store, task } = startedStore();
  const [a, b] = [candidate("a"), candidate("b")];
  const paused = store.mutateTask(task.id, task.revision, (current) =>
    success(current.revision, null, {
      ...current,
      status: "paused",
      pauseReason: "fixture",
      candidates: [a, b, a, b, a],
    }),
  );
  if (!paused.ok) throw new Error(paused.error);
  const active = store.create({
    expectedWorkspaceRevision: store.readWorkspace().ok
      ? ((store.readWorkspace() as any).data.revision as string)
      : null,
    provenance,
    intent: { objective: "active", scope: scope(), authorityRefs: [ref()] },
  });
  if (!active.ok) throw new Error(active.error);
  const activeWithDuplicates = store.mutateTask(active.data.id, active.data.revision, (current) =>
    success(current.revision, null, { ...current, candidates: [a, a] }),
  );
  if (!activeWithDuplicates.ok) throw new Error(activeWithDuplicates.error);
  const workspace = store.readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
  const closedTask = store.create({
    expectedWorkspaceRevision: workspace.data.revision,
    provenance,
    intent: { objective: "closed", scope: scope(), authorityRefs: [ref()] },
  });
  if (!closedTask.ok) throw new Error(closedTask.error);
  const closed = store.mutateTask(closedTask.data.id, closedTask.data.revision, (current) =>
    success(current.revision, null, { ...current, status: "closed", candidates: [b, b] }),
  );
  if (!closed.ok) throw new Error(closed.error);
  const closedFile = join(store.root, ".workit", "tasks", `${closedTask.data.id}.json`);
  const closedBytes = readFileSync(closedFile);

  const result = store.collectGarbage();
  if (!result.ok) throw new Error(result.error);
  expect(result.data.candidates).toMatchObject({
    removed: 3,
    skippedActive: [active.data.id],
    skippedClosed: [closedTask.data.id],
  });
  expect(readFileSync(closedFile)).toEqual(closedBytes);
  const after = store.readTask(task.id);
  if (!after.ok) throw new Error(after.error);
  expect(after.data.candidates.map((item) => item.head)).toEqual(["b", "a"]);
  expect(after.data.candidates.at(-1)).toEqual(paused.data.candidates.at(-1));
  const untouched = store.readTask(active.data.id);
  if (!untouched.ok) throw new Error(untouched.error);
  expect(untouched.data.candidates).toHaveLength(2);
});

test("Given a stale leftover temp file, When gc runs, Then it is removed while fresh temp files stay", () => {
  const { store, task } = startedStore();
  const stale = join(recoveryDir(store), `task.${task.id}.${"a".repeat(64)}.json.1.x.tmp`);
  const fresh = join(recoveryDir(store), `task.${task.id}.${"b".repeat(64)}.json.1.y.tmp`);
  writeFileSync(stale, "partial");
  writeFileSync(fresh, "partial");
  utimesSync(stale, new Date(0), new Date(0));
  const result = store.collectGarbage();
  expect(result).toMatchObject({ ok: true, data: { temporary: { removed: 1 } } });
  expect(() => statSync(stale)).toThrow();
  expect(statSync(fresh).isFile()).toBe(true);
});

const cliEntry = resolve(import.meta.dir, "../../packages/workit-cli/src/index.tsx");

test("Given stale recovery copies, When `workit gc --json` runs, Then it prunes to the cap and reports the count", () => {
  const { store, task } = startedStore();
  seedStaleCopies(store, `task.${task.id}.`, 9);
  const run = spawnSync(process.execPath, [cliEntry, "gc", "--json"], {
    cwd: store.root,
    encoding: "utf8",
    env: { ...process.env, HOME: store.root },
  });
  expect(run.status, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({ ok: true, data: { recovery: { removed: 6 } } });
  expect(copiesFor(store, `task.${task.id}.`)).toHaveLength(3);
});

test("Given no host supplies native recovery authority, Then state.recover is not advertised but stays parseable for the engine", () => {
  const advertised = JSON.stringify(operationJsonSchema("state"));
  expect(advertised).not.toContain('"recover"');
  expect(advertised).toContain('"export"');
  expect(JSON.stringify(boundedOperationJsonSchema("state"))).not.toContain('"recover"');
  expect(
    parseOperation("state", {
      schemaVersion: 1,
      action: "recover",
      target: "workspace",
      expectedBytes: "a".repeat(64),
      snapshotDigest: "b".repeat(64),
      reason: "engine path",
      authorityRefs: [],
    }).ok,
  ).toBe(true);
});
