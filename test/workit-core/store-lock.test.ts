import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskStore } from "@/packages/workit-core/src/core/task-store";
import { success, type TaskRecord } from "@/packages/workit-core/src/core/task-contract";
import { ref, scope } from "./task-fixtures";

// Lock reclaim and contention (spec "Stale lock" / "Contention"): a lock held
// by a dead or replaced process is reclaimed automatically, while contention
// between live writers is retryable `busy`, never `recovery_required`.

const provenance = {
  kind: "host_observed" as const,
  host: "workit_cli" as const,
  session: null,
  workerId: null,
  receipts: [],
};
const identity = (task: TaskRecord) => success(task.revision, null, task);

const startedStore = (options?: { lockTimeoutMs?: number }) => {
  const store = new TaskStore(mkdtempSync(join(tmpdir(), "workit-lock-")), options);
  const created = store.create({
    expectedWorkspaceRevision: null,
    provenance,
    intent: { objective: "lock test", scope: scope(), authorityRefs: [ref()] },
  });
  if (!created.ok) throw new Error(created.error);
  return { store, task: created.data, lockPath: join(store.root, ".workit", "metadata.lock") };
};

const processStart = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null;
  } catch {
    return null;
  }
};

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
};

const writeLock = (lockPath: string, payload: Record<string, unknown>) =>
  writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`);

test("Given a lock held by a dead pid, When a write runs, Then the lock is reclaimed and the write succeeds", () => {
  const { store, task, lockPath } = startedStore();
  writeLock(lockPath, { pid: deadPid(), processStart: "1", host: hostname(), nonce: "dead" });
  const result = store.mutateTask(task.id, task.revision, identity);
  expect(result.ok).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test.skipIf(process.platform !== "linux")(
  "Given a lock whose pid now belongs to a different process, When a write runs, Then the lock is reclaimed and the write succeeds",
  () => {
    const { store, task, lockPath } = startedStore();
    writeLock(lockPath, {
      pid: process.pid,
      processStart: `${processStart(process.pid)}0`,
      host: hostname(),
      nonce: "reused",
    });
    expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  },
);

test("Given a lock from another host older than the TTL, When a write runs, Then the lock is reclaimed and the write succeeds", () => {
  const { store, task, lockPath } = startedStore();
  writeLock(lockPath, { pid: 999999, processStart: "old", host: "another-host", nonce: "x" });
  utimesSync(lockPath, new Date(0), new Date(0));
  expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
});

test("Given a fresh lock from another host, When a write runs, Then it returns busy and keeps the lock", () => {
  const { store, task, lockPath } = startedStore({ lockTimeoutMs: 150 });
  const bytes = `${JSON.stringify({ pid: 1, processStart: "x", host: "another-host", nonce: "y" })}\n`;
  writeFileSync(lockPath, bytes);
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "busy",
  });
  expect(readFileSync(lockPath, "utf8")).toBe(bytes);
});

test("Given a lock held by a live writer, When another write runs, Then it returns retryable busy, not recovery_required, and the lock stays", async () => {
  const { store, task, lockPath } = startedStore({ lockTimeoutMs: 200 });
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await new Promise((done) => setTimeout(done, 50));
    const pid = holder.pid!;
    writeLock(lockPath, { pid, processStart: processStart(pid), host: hostname(), nonce: "live" });
    const bytes = readFileSync(lockPath, "utf8");
    const result = store.mutateTask(task.id, task.revision, identity);
    expect(result).toMatchObject({ ok: false, code: "busy" });
    expect(readFileSync(lockPath, "utf8")).toBe(bytes);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("Given a live writer that releases its lock within the retry window, When another write runs, Then the write succeeds", async () => {
  const { store, task, lockPath } = startedStore({ lockTimeoutMs: 3000 });
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((done) => setTimeout(done, 50));
  const pid = holder.pid!;
  writeLock(lockPath, { pid, processStart: processStart(pid), host: hostname(), nonce: "brief" });
  const releaser = spawn(
    process.execPath,
    ["-e", `setTimeout(() => require("node:fs").rmSync(${JSON.stringify(lockPath)}), 300)`],
    { stdio: "ignore" },
  );
  try {
    // The synchronous retry loop blocks this event loop, so the release comes
    // from another process.
    expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
  } finally {
    holder.kill("SIGKILL");
    releaser.kill("SIGKILL");
  }
});

test("Given an abandoned reclaim guard older than the TTL, When a write runs, Then the guard is cleared and the write succeeds", () => {
  const { store, task, lockPath } = startedStore({ lockTimeoutMs: 200 });
  mkdirSync(`${lockPath}.reclaim`);
  utimesSync(`${lockPath}.reclaim`, new Date(0), new Date(0));
  expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
  expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
});

test("Given a corrupt task record, When a write runs, Then recovery_required still surfaces", () => {
  const { store, task } = startedStore();
  const file = join(store.root, ".workit", "tasks", `${task.id}.json`);
  writeFileSync(file, "{broken");
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
  expect(readFileSync(file, "utf8")).toBe("{broken");
});

const storeModule = resolve(import.meta.dir, "../../packages/workit-core/src/core/task-store.ts");
const workerScript = (root: string, taskId: string, calls: number) => `
import { TaskStore } from ${JSON.stringify(storeModule)};
const store = new TaskStore(${JSON.stringify(root)});
const codes = {};
for (let call = 0; call < ${calls}; call += 1) {
  let code = "revision_conflict";
  for (let attempt = 0; attempt < 50 && code === "revision_conflict"; attempt += 1) {
    const current = store.readTask(${JSON.stringify(taskId)});
    if (!current.ok) { code = current.code; break; }
    const result = store.mutateTask(current.data.id, current.data.revision, (task) => ({
      ok: true, revision: task.revision, workspaceRevision: null, data: task,
    }));
    code = result.ok ? "ok" : result.code;
  }
  codes[code] = (codes[code] ?? 0) + 1;
}
process.stdout.write(JSON.stringify(codes));
`;

test("Given three processes each making 40 writes to one task, When they contend, Then none returns recovery_required", async () => {
  const { store, task } = startedStore();
  const runs = await Promise.all(
    [0, 1, 2].map(
      () =>
        new Promise<Record<string, number>>((done, fail) => {
          const child = spawn(process.execPath, ["-e", workerScript(store.root, task.id, 40)], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err += chunk));
          child.on("close", () => {
            try {
              done(JSON.parse(out));
            } catch {
              fail(new Error(`worker output: ${out} ${err}`));
            }
          });
        }),
    ),
  );
  const totals: Record<string, number> = {};
  for (const run of runs)
    for (const [code, count] of Object.entries(run)) totals[code] = (totals[code] ?? 0) + count;
  expect(totals.recovery_required ?? 0).toBe(0);
  expect(totals.ok).toBe(120);
}, 60_000);
