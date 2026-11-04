// A git checkout's `.workit/` holds only committed team config: the task store
// writes nothing there and moves what older runtimes left (2.x task files and
// recovery copies, the 3.x marker) once into the store's backup.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "@/packages/workit-core/src/core/task-store";
import { checkoutSlug } from "@/packages/workit-core/src/store/paths";
import { ref, scope } from "./task-fixtures";

const dirs: string[] = [];
const SLOT = Symbol.for("workit.migrationReporter");
const slots = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete slots[SLOT];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-leftovers-")));
  dirs.push(dir);
  return dir;
};
const repo = () => {
  const root = tempDir();
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
};
const provenance = {
  kind: "host_observed" as const,
  host: "workit_cli" as const,
  session: null,
  workerId: null,
};
const write = (root: string) =>
  new TaskStore(root).create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "test", scope: scope(), authorityRefs: [ref()] },
  });
const backupOf = (root: string) =>
  path.join(root, ".git", "workit", "legacy", checkoutSlug(root), "v2");

const TASK_ID = "01J0000000000000000000000A";
const tombstone = {
  schemaVersion: 1,
  id: TASK_ID,
  revision: "r1",
  root: "/old",
  runtime: { createdWith: "3.0.0", updatedWith: "3.0.0" },
  writer: null,
  store: { format: "workit-store", version: 1, path: "/old/.git/workit" },
  critical: ["store"],
};
const stub = {
  schemaVersion: 1,
  id: TASK_ID,
  runtime: { createdWith: "3.0.0", updatedWith: "3.0.0" },
  store: { format: "workit-store", version: 1, path: "/old/.git/workit" },
  critical: ["store"],
};

test("Given a git checkout, When the store writes, Then nothing lands in .workit/", () => {
  const root = repo();
  expect(write(root).ok).toBe(true);
  expect(existsSync(path.join(root, ".workit"))).toBe(false);
});

test("Given a non-git directory, When the store writes, Then .workit is the store and keeps its 2.x tombstone", () => {
  const root = tempDir();
  expect(write(root).ok).toBe(true);
  const marker = JSON.parse(readFileSync(path.join(root, ".workit", "workspace.json"), "utf8"));
  expect(marker).toMatchObject({
    store: { format: "workit-store" },
    critical: ["store"],
  });
  expect(readFileSync(path.join(root, ".workit", ".gitignore"), "utf8")).toBe("*\n");
});

test("Given leftover .workit/tasks data, When the store opens, Then it moves once into the git store's backup, markers go, and a second open does nothing", () => {
  const root = repo();
  const workit = path.join(root, ".workit");
  mkdirSync(path.join(workit, "tasks"), { recursive: true });
  mkdirSync(path.join(workit, "recovery"), { recursive: true });
  writeFileSync(path.join(workit, ".gitignore"), "*\n");
  writeFileSync(path.join(workit, "workspace.json"), JSON.stringify(tombstone));
  writeFileSync(path.join(workit, "tasks", `${TASK_ID}.json`), JSON.stringify(stub));
  writeFileSync(path.join(workit, "tasks", "orphan.json"), '{"objective":"keep me"}\n');
  writeFileSync(path.join(workit, "recovery", "task.copy.json"), '{"copy":1}\n');
  const reports: unknown[] = [];
  slots[SLOT] = (report: unknown) => reports.push(report);

  expect(new TaskStore(root).listTasks().ok).toBe(true);
  expect(existsSync(workit)).toBe(false);
  const backup = backupOf(root);
  expect(readFileSync(path.join(backup, "tasks", "orphan.json"), "utf8")).toBe(
    '{"objective":"keep me"}\n',
  );
  expect(readFileSync(path.join(backup, "recovery", "task.copy.json"), "utf8")).toBe(
    '{"copy":1}\n',
  );
  // Known markers are deleted, not backed up.
  expect(existsSync(path.join(backup, "workspace.json"))).toBe(false);
  expect(existsSync(path.join(backup, "tasks", `${TASK_ID}.json`))).toBe(false);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ from: workit, backup });

  const before = readdirSync(backup, { recursive: true }).map(String).toSorted();
  expect(write(root).ok).toBe(true);
  expect(new TaskStore(root).listTasks().ok).toBe(true);
  expect(reports).toHaveLength(1);
  expect(existsSync(workit)).toBe(false);
  expect(readdirSync(backup, { recursive: true }).map(String).toSorted()).toEqual(before);
});

test("Given a marker-like workspace.json with extra content and team config beside it, When the store opens, Then the file is backed up, not deleted, and the config stays", () => {
  const root = repo();
  const workit = path.join(root, ".workit");
  mkdirSync(workit, { recursive: true });
  const edited = { ...tombstone, note: "someone wrote here" };
  writeFileSync(path.join(workit, "workspace.json"), JSON.stringify(edited));
  writeFileSync(path.join(workit, "checks.json"), '{"checks":{"test":"true"}}');
  writeFileSync(path.join(workit, ".gitignore"), "*\n");
  expect(write(root).ok).toBe(true);
  expect(
    JSON.parse(readFileSync(path.join(backupOf(root), "workspace.json"), "utf8")),
  ).toMatchObject({ note: "someone wrote here" });
  // Team config and its (still generated) ignore file are ensureWorkitDir's to change.
  expect(readdirSync(workit).toSorted()).toEqual([".gitignore", "checks.json"]);
});

test("Given a backup file of the same name with other bytes, When a leftover moves, Then both are kept", () => {
  const root = repo();
  const backup = backupOf(root);
  mkdirSync(path.join(backup, "tasks"), { recursive: true });
  writeFileSync(path.join(backup, "tasks", "orphan.json"), "older\n");
  mkdirSync(path.join(root, ".workit", "tasks"), { recursive: true });
  writeFileSync(path.join(root, ".workit", "tasks", "orphan.json"), "newer\n");
  expect(write(root).ok).toBe(true);
  const kept = readdirSync(path.join(backup, "tasks"))
    .map((name) => readFileSync(path.join(backup, "tasks", name), "utf8"))
    .toSorted();
  expect(kept).toEqual(["newer\n", "older\n"]);
});
