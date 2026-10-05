import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import {
  localLockHost,
  lockPathFor,
  parseProcStatStart,
  processStartOf,
} from "@/packages/workit-core/src/core/store-lock";
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
  // A task write takes the task's lock; workspace writes take the checkout's.
  return {
    store,
    task: created.data,
    lockPath: join(store.root, ".workit", "tasks", created.data.id, "lock"),
    checkoutLock: lockPathFor(store.root),
  };
};

const processStart = processStartOf;

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
  writeLock(lockPath, {
    pid: deadPid(),
    processStart: "1",
    host: localLockHost(),
    nonce: "dead",
  });
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
      host: localLockHost(),
      nonce: "reused",
    });
    expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  },
);

test("Given a lock from another host older than the TTL, When a write runs, Then the lock is reclaimed and the write succeeds", () => {
  const { store, task, lockPath } = startedStore();
  writeLock(lockPath, {
    pid: 999999,
    processStart: "old",
    host: "another-host",
    nonce: "x",
  });
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
    writeLock(lockPath, {
      pid,
      processStart: processStart(pid),
      host: localLockHost(),
      nonce: "live",
    });
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
  writeLock(lockPath, {
    pid,
    processStart: processStart(pid),
    host: localLockHost(),
    nonce: "brief",
  });
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
  const file = join(store.root, ".workit", "tasks", task.id, "events.jsonl");
  writeFileSync(file, "{broken}\n{broken");
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "recovery_required",
  });
  expect(readFileSync(file, "utf8")).toBe("{broken}\n{broken");
});

const storeModule = resolve(import.meta.dir, "../../packages/workit-core/src/core/task-store.ts");
const workerScript = (root: string, taskId: string, calls: number) => `
import { TaskStore } from ${JSON.stringify(storeModule)};
const store = new TaskStore(${JSON.stringify(root)});
const codes = {};
const errors = [];
const expected = new Set(["ok", "busy", "revision_conflict"]);
for (let call = 0; call < ${calls}; call += 1) {
  let code = "revision_conflict";
  for (let attempt = 0; attempt < 50 && code === "revision_conflict"; attempt += 1) {
    const current = store.readTask(${JSON.stringify(taskId)});
    let result = current;
    if (current.ok)
      result = store.mutateTask(current.data.id, current.data.revision, (task) => ({
        ok: true, revision: task.revision, workspaceRevision: null, data: task,
      }));
    code = result.ok ? "ok" : result.code;
    // Keep the detail of anything unexpected so a CI failure names the fs op.
    if (!expected.has(code) && errors.length < 10)
      errors.push({ step: current.ok ? "mutate" : "read", code, error: result.error, details: result.details });
    if (!current.ok) break;
  }
  codes[code] = (codes[code] ?? 0) + 1;
}
process.stdout.write(JSON.stringify({ codes, errors }));
`;

test("Given three processes each making 40 writes to one task, When they contend, Then none returns recovery_required", async () => {
  const { store, task } = startedStore();
  const runs = await Promise.all(
    [0, 1, 2].map(
      () =>
        new Promise<{ codes: Record<string, number>; errors: unknown[] }>((done, fail) => {
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
    for (const [code, count] of Object.entries(run.codes))
      totals[code] = (totals[code] ?? 0) + count;
  const errors = JSON.stringify(runs.flatMap((run) => run.errors));
  // The invariant: contention never reports recovery_required, and every
  // non-ok result is a retryable code. How many calls exhaust the short
  // in-process wait budget (busy) depends on runner speed (a windows-latest
  // run measured 84 ok / 36 busy), so the progress floor is deliberately
  // weak: at least one process's worth of writes must land.
  expect(totals.recovery_required ?? 0, errors).toBe(0);
  const retryable = new Set(["ok", "busy", "revision_conflict"]);
  expect(
    Object.keys(totals).filter((code) => !retryable.has(code)),
    errors,
  ).toEqual([]);
  expect(Object.values(totals).reduce((sum, count) => sum + count, 0)).toBe(120);
  expect(totals.ok ?? 0).toBeGreaterThanOrEqual(40);
}, 60_000);

const storeModule2 = resolve(import.meta.dir, "../../packages/workit-core/src/core/store-lock.ts");

test("Given a lock from a container that shares the hostname but not the pid namespace, When a write runs, Then its pid is not checked here and the write is busy", () => {
  const { store, task, lockPath } = startedStore({ lockTimeoutMs: 150 });
  // pid 1 is alive on this host too; the namespace suffix marks it as foreign.
  const bytes = `${JSON.stringify({
    pid: 1,
    processStart: "1",
    host: `${hostname()}#4026599999:other-boot`,
    nonce: "container",
  })}\n`;
  writeFileSync(lockPath, bytes);
  expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
    ok: false,
    code: "busy",
  });
  expect(readFileSync(lockPath, "utf8")).toBe(bytes);
  // Past the foreign TTL the same lock is reclaimable.
  utimesSync(lockPath, new Date(0), new Date(0));
  expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
});

test.skipIf(process.platform !== "linux")(
  "Given a lock written by an older Workit without namespace identity, When a write runs, Then it is treated as foreign until its TTL",
  () => {
    const { store, task, lockPath } = startedStore({ lockTimeoutMs: 150 });
    writeLock(lockPath, {
      pid: deadPid(),
      processStart: null,
      host: hostname(),
      nonce: "legacy",
    });
    expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
      code: "busy",
    });
    utimesSync(lockPath, new Date(0), new Date(0));
    expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
  },
);

test("Given a process name with spaces and parentheses, When /proc stat is parsed, Then the start time is read after the last parenthesis", () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  expect(parseProcStatStart(`4242 (we ird) (name) ${fields.join(" ")}`)).toBe("22");
});

test("Given an in-process host with the default budget, When a live holder keeps the lock, Then busy returns within the short budget", async () => {
  const { store, task, lockPath } = startedStore();
  const fresh = new TaskStore(store.root);
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await new Promise((done) => setTimeout(done, 50));
    const pid = holder.pid!;
    writeLock(lockPath, {
      pid,
      processStart: processStart(pid),
      host: localLockHost(),
      nonce: "x",
    });
    const started = performance.now();
    expect(fresh.mutateTask(task.id, task.revision, identity)).toMatchObject({
      code: "busy",
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("Given doctor --fix-lock is preempted while a writer reclaims the same stale lock, Then the two never hold the lock at once", async () => {
  const { store, checkoutLock: lockPath } = startedStore();
  writeLock(lockPath, {
    pid: deadPid(),
    processStart: null,
    host: localLockHost(),
    nonce: "x",
  });
  const run = (script: string) =>
    new Promise<string>((done) => {
      const child = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", () => done(out));
    });
  // The doctor pauses 400 ms right before removing the lock (models preemption).
  const doctor = run(`
    import fs from "node:fs";
    const rm = fs.rmSync;
    fs.rmSync = (p, ...rest) => {
      if (String(p).endsWith("metadata.lock")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return rm(p, ...rest);
    };
    const { clearStaleMetadataLock } = await import(${JSON.stringify(storeModule2)});
    console.log(JSON.stringify(clearStaleMetadataLock(${JSON.stringify(store.root)})));
  `);
  const writer = (label: string, holdMs: number) => `
    const { TaskStore } = await import(${JSON.stringify(storeModule)});
    const s = new TaskStore(${JSON.stringify(store.root)}, { lockTimeoutMs: 5000 });
    const w = s.readWorkspace();
    let span = [0, 0];
    const r = s.mutateWorkspace(w.data.revision, (x) => {
      span[0] = Date.now();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      span[1] = Date.now();
      return { ok: true, revision: x.revision, workspaceRevision: null, data: x };
    });
    console.log(JSON.stringify({ label: ${JSON.stringify(label)}, code: r.ok ? "ok" : r.code, span }));
  `;
  await new Promise((done) => setTimeout(done, 150));
  const first = run(writer("W", 800));
  await new Promise((done) => setTimeout(done, 500));
  const second = run(writer("X", 100));
  const [doctorOut, w, x] = await Promise.all([doctor, first, second]);
  const spans = [w, x].map((out) => JSON.parse(out.trim().split("\n").at(-1)!));
  expect(JSON.parse(doctorOut.trim())).toMatchObject({ cleared: true });
  // Revision conflicts are fine; overlapping critical sections are not.
  const held = spans.filter((item) => item.span[0] > 0).toSorted((a, b) => a.span[0] - b.span[0]);
  for (let index = 1; index < held.length; index += 1)
    expect(held[index].span[0]).toBeGreaterThanOrEqual(held[index - 1].span[1]);
  expect(spans.every((item) => item.code === "ok" || item.code === "revision_conflict")).toBe(true);
}, 30_000);

// Linux only: where there is no pid-namespace identity (macOS, Windows) a
// plain-hostname lock is this host's own format and pid checks apply.
test.skipIf(!localLockHost().includes("#"))(
  "Given a plain-hostname lock naming live pid 1 with a mismatched start time (a container's lock), When a write runs, Then it stays busy and is not reclaimed",
  () => {
    const { store, task, lockPath } = startedStore({ lockTimeoutMs: 150 });
    // Pre-namespace locks carried only hostname(); judging pid 1 against this
    // host's process table would steal a live container's lock.
    const bytes = `${JSON.stringify({ pid: 1, processStart: "1", host: hostname(), nonce: "c" })}\n`;
    writeFileSync(lockPath, bytes);
    expect(store.mutateTask(task.id, task.revision, identity)).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(readFileSync(lockPath, "utf8")).toBe(bytes);
  },
);

test.skipIf(!localLockHost().includes("#"))(
  "Given a lock from the same host and pid namespace but an earlier boot, When a write runs, Then it is reclaimed immediately",
  () => {
    const { store, task, lockPath } = startedStore({ lockTimeoutMs: 150 });
    const [name, space] = localLockHost().split("#");
    const [namespace] = space.split(":");
    writeLock(lockPath, {
      pid: process.pid,
      processStart: processStart(process.pid),
      host: `${name}#${namespace}:00000000-0000-0000-0000-000000000000`,
      nonce: "before-reboot",
    });
    expect(store.mutateTask(task.id, task.revision, identity).ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  },
);

// Permission denials are not contention: with nothing holding the lock, a
// read-only .workit must fail fast with storage_error and a permissions hint,
// never spend the budget and report busy. Windows reports these as
// EPERM/EACCES, so the Windows path is exercised by simulating the platform.
const readOnlyWorkit = !(
  process.platform === "win32" ||
  (typeof process.getuid === "function" && process.getuid() === 0)
);
for (const simulateWindows of [false, true])
  test.skipIf(!readOnlyWorkit)(
    `Given a read-only .workit and no lock holder${simulateWindows ? " (simulated Windows)" : ""}, When a write runs, Then it fails fast with storage_error and a permissions hint`,
    () => {
      const { store, task } = startedStore({ lockTimeoutMs: 2_000 });
      const workit = join(store.root, ".workit", "tasks", task.id);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      chmodSync(workit, 0o555);
      try {
        if (simulateWindows) Object.defineProperty(process, "platform", { value: "win32" });
        const started = performance.now();
        const result = store.mutateTask(task.id, task.revision, identity);
        const elapsed = performance.now() - started;
        Object.defineProperty(process, "platform", platform);
        expect(result).toMatchObject({ ok: false, code: "storage_error" });
        if (simulateWindows)
          expect(result).toMatchObject({
            details: {
              guidance: expect.stringContaining("read-only attribute"),
            },
          });
        expect(elapsed).toBeLessThan(1_000);
      } finally {
        Object.defineProperty(process, "platform", platform);
        chmodSync(workit, 0o755);
      }
    },
  );
