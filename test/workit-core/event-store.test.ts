// S15 (design §4.1; D3, D13, D17): the append-only task event store, the
// implicit task per branch/worktree, and the 2.x migration.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import {
  AUTO_COMPACT_BYTES,
  COMPACT_KEEP,
  SNAPSHOT_EVERY,
} from "@/packages/workit-core/src/core/task-store";
import {
  canonicalJson,
  parseStoredRecord,
  success,
  workspaceRecordSchema,
  type Provenance,
  type TaskRecord,
} from "@/packages/workit-core/src/core/task-contract";
import { apply, diff } from "@/packages/workit-core/src/store/patch";
import { resolveStore, resolveTaskKey } from "@/packages/workit-core/src/store/paths";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { caller, ref, scope, taskStartRequest } from "./task-fixtures";
import { eventsFileOf, eventsOf, storeDirOf, taskDirOf, workspaceFileOf } from "./store-files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  // The native resolver expands Windows short names, as the store does.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};
const repo = (branch = "feature/a") => {
  const root = tempDir("wk-s15-repo-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", branch);
  return root;
};

const provenance: Provenance = {
  kind: "agent_reported",
  host: "workit_cli",
  session: { kind: "host", host: "workit_cli", handle: "cli" },
  workerId: null,
  receipts: [],
};
const identity = (task: TaskRecord) => success(task.revision, null, task);
const coreFor = (root: string) =>
  new WorkitCore(new TaskStore(root), {
    root,
    caller: caller({ actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
const progress = (summary: string) => ({ summary, nextAction: null, blockers: [] });
const implicit = (root: string, create = true) => {
  const found = new TaskStore(root).implicitTask({ provenance, create });
  if (!found.ok) throw new Error(found.error);
  return found.data;
};
const cli = async (cwd: string, argv: string[], env: Record<string, string> = {}) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKFLOW_WORKSPACE_ROOT: "", ...env },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

// ---------------------------------------------------------------------------
// implicit task

test("Given a fresh branch, When the agent records evidence, Then a task exists for that branch without an explicit start call", () => {
  const root = repo("feature/fresh");
  expect(implicit(root, false)).toBeNull();
  const recorded = coreFor(root).evidence({
    schemaVersion: 1,
    action: "record",
    evidence: {
      kind: "investigation",
      claim: "looked at the parser",
      requirementIds: [],
      result: "passed",
      summary: "parser reads one line at a time",
      refs: [],
      exitCode: null,
      reviewContext: null,
    },
  });
  expect(recorded.ok).toBe(true);
  const found = implicit(root, false);
  expect(found).toMatchObject({
    created: false,
    key: { key: "feature/fresh", kind: "branch", branch: "feature/fresh" },
    task: { status: "active", intent: { data: { objective: "Work on branch feature/fresh" } } },
  });
  expect(found!.task.evidence).toHaveLength(1);
  // Reads never create it.
  const other = repo("feature/other");
  expect(coreFor(other).task({ schemaVersion: 1, action: "inspect" })).toMatchObject({
    ok: false,
    code: "not_found",
  });
  expect(implicit(other, false)).toBeNull();
});

test("Given two worktrees of one repo, Then they share the store root and get distinct implicit tasks per branch", () => {
  const root = repo("feature/a");
  const second = path.join(tempDir("wk-s15-wt-"), "wt");
  git(root, "worktree", "add", "-q", "-b", "feature/b", second);
  const first = implicit(root)!;
  const other = implicit(second)!;
  expect(first.created && other.created).toBe(true);
  expect(first.task.id).not.toBe(other.task.id);
  expect(first.key.key).toBe("feature/a");
  expect(other.key.key).toBe("feature/b");
  expect(storeDirOf(second)).toBe(storeDirOf(root));
  expect(storeDirOf(root)).toBe(path.join(root, ".git", "workit"));
  // Each checkout only carries the marker that makes 2.x readers fail closed.
  for (const dir of [root, second])
    expect(readdirSync(path.join(dir, ".workit")).toSorted()).toEqual([
      ".gitignore",
      "workspace.json",
    ]);
  // Each checkout lists its own tasks; the store lists both.
  const listed = new TaskStore(root).listTaskIndex();
  expect(listed.ok && listed.data.map((entry) => entry.id)).toEqual([first.task.id]);
  const all = new TaskStore(second).listStoreIndex();
  expect(all.ok && all.data.map((entry) => entry.id).toSorted()).toEqual(
    [first.task.id, other.task.id].toSorted(),
  );
  // Idempotent per branch.
  expect(implicit(root)).toMatchObject({ created: false, task: { id: first.task.id } });
  // A removed worktree's branch task follows the branch to another checkout.
  git(root, "worktree", "remove", "--force", second);
  git(root, "checkout", "-q", "feature/b");
  const moved = implicit(root)!;
  expect(moved).toMatchObject({ created: false, task: { id: other.task.id } });
  expect(eventsOf(root, other.task.id).at(-1)).toMatchObject({
    type: "task.bound",
    data: { key: { key: "feature/b" } },
  });
  expect(new TaskStore(root).readTask(other.task.id).ok).toBe(true);
});

test("detached HEAD keys by worktree and a non-git directory keys by directory", () => {
  const root = repo();
  git(root, "checkout", "-q", "--detach");
  const detached = implicit(root)!;
  expect(detached.key.kind).toBe("detached");
  expect(detached.key.key).toMatch(/^detached-[0-9a-f]{12}$/);
  expect(implicit(root)!.task.id).toBe(detached.task.id);
  const plain = tempDir("wk-s15-plain-");
  const dir = implicit(plain)!;
  expect(dir.key).toMatchObject({ kind: "dir", branch: null });
  expect(storeDirOf(plain)).toBe(path.join(plain, ".workit"));
  // A plain directory's store marks itself for 2.x readers.
  expect(
    JSON.parse(readFileSync(path.join(plain, ".workit", "workspace.json"), "utf8")),
  ).toMatchObject({ store: { format: "workit-store" }, critical: ["store"] });
});

test("an explicitly started task takes the branch over; a closed task frees it", () => {
  const root = repo();
  const first = implicit(root)!;
  const core = coreFor(root);
  const started = core.task(taskStartRequest({ expectedWorkspaceRevision: undefined }));
  if (!started.ok) throw new Error(started.error);
  const startedId = (started.data as { id: string }).id;
  expect(implicit(root, false)!.task.id).toBe(startedId);
  const all = new TaskStore(root).listStoreIndex();
  expect(all.ok && all.data.find((entry) => entry.id === first.task.id)?.key).toBeNull();
  const closed = core.task({
    schemaVersion: 1,
    action: "close",
    outcome: "stopped",
    summary: "superseded",
  });
  expect(closed.ok).toBe(true);
  const next = implicit(root)!;
  expect(next.created).toBe(true);
  expect(next.task.id).not.toBe(startedId);
});

// ---------------------------------------------------------------------------
// the log

test("Given 1,000 writes to one task, Then the task dir holds events.jsonl + snapshot only, size linear in the events, and gc bounds it without losing the latest state", () => {
  const root = tempDir("wk-s15-bounded-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  const sizes: number[] = [];
  let revision = task.revision;
  const started = performance.now();
  for (let index = 1; index <= 1000; index += 1) {
    const written = store.mutateTask(task.id, revision, (current) =>
      success(null, null, { ...current, progress: progress(`step ${index}`) }),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
    if (index === 500 || index === 1000) sizes.push(statSync(eventsFileOf(root, task.id)).size);
  }
  const perWriteMs = (performance.now() - started) / 1000;
  expect(readdirSync(taskDirOf(root, task.id)).toSorted()).toEqual([
    "events.jsonl",
    "snapshot.json",
  ]);
  const recordBytes = canonicalJson(store.readTask(task.id)).length;
  // Linear in the events (each a small patch), never a full-record copy per write.
  const [half, full] = sizes;
  expect(full / half).toBeGreaterThan(1.8);
  expect(full / half).toBeLessThan(2.2);
  expect((full - half) / 500).toBeLessThan(recordBytes);
  expect(eventsOf(root, task.id)).toHaveLength(1001);
  // gc folds old events into a checkpoint and keeps the recent ones.
  const before = store.readTask(task.id);
  const collected = store.collectGarbage();
  expect(collected).toMatchObject({ ok: true, data: { compacted: { tasks: [task.id] } } });
  const events = eventsOf(root, task.id);
  expect(events).toHaveLength(COMPACT_KEEP + 1);
  expect(events[0]).toMatchObject({ type: "task.checkpoint", seq: 1001 - COMPACT_KEEP });
  expect(statSync(eventsFileOf(root, task.id)).size).toBeLessThan(full / 5);
  expect(new TaskStore(root).readTask(task.id)).toEqual(before);
  rmSync(path.join(taskDirOf(root, task.id), "snapshot.json"));
  expect(new TaskStore(root).readTask(task.id)).toEqual(before);
  // Appends continue the sequence after compaction.
  const after = store.mutateTask(task.id, revision, identity);
  expect(after.ok).toBe(true);
  expect(eventsOf(root, task.id).at(-1)?.seq).toBe(1002);
  console.log(
    `S15 1,000 writes: ${(full / 1024).toFixed(1)} KB log (${Math.round((full - half) / 500)} B/event vs ${recordBytes} B record), ${perWriteMs.toFixed(2)} ms/write; after gc ${(statSync(eventsFileOf(root, task.id)).size / 1024).toFixed(1)} KB`,
  );
}, 60_000);

test("a snapshot is a cache: written every SNAPSHOT_EVERY events, ignored when it does not match the log", () => {
  const root = tempDir("wk-s15-snapshot-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  let revision = task.revision;
  for (let index = 0; index < SNAPSHOT_EVERY + 3; index += 1) {
    const written = store.mutateTask(task.id, revision, (current) =>
      success(null, null, { ...current, progress: progress(`n${index}`) }),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
  }
  const snapshotFile = path.join(taskDirOf(root, task.id), "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  expect(snapshot.seq).toBeGreaterThan(SNAPSHOT_EVERY);
  const expected = store.readTask(task.id);
  // A snapshot naming another event, or garbage, falls back to a full replay.
  writeFileSync(snapshotFile, JSON.stringify({ ...snapshot, lastId: "elsewhere" }));
  expect(new TaskStore(root).readTask(task.id)).toEqual(expected);
  writeFileSync(snapshotFile, "{garbage");
  expect(new TaskStore(root).readTask(task.id)).toEqual(expected);
  // A log rewritten under a stale snapshot (same seq at the same offset, another
  // event) is replayed from the log, never from the snapshot.
  // (One more write re-anchors the snapshot replaced above.)
  expect(store.mutateTask(task.id, revision, identity).ok).toBe(true);
  const current = JSON.parse(readFileSync(snapshotFile, "utf8"));
  const file = eventsFileOf(root, task.id);
  const bytes = readFileSync(file);
  const replaced = {
    v: 1,
    seq: current.seq,
    at: "2026-01-01T00:00:00Z",
    id: "rewritten",
    task: task.id,
    actor: null,
    type: "task.noted",
    data: { ops: [{ op: "set", path: ["progress", "summary"], value: "rewritten history" }] },
  };
  writeFileSync(
    file,
    Buffer.concat([
      bytes.subarray(0, current.lastStart),
      Buffer.from(`${JSON.stringify(replaced)}\n`),
    ]),
  );
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { progress: { summary: "rewritten history" } },
  });
});

test("Given a torn last line, Then reads ignore it and the next append truncates it; the replay stays consistent", () => {
  const root = tempDir("wk-s15-torn-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  const file = eventsFileOf(root, task.id);
  const intact = readFileSync(file, "utf8");
  appendFileSync(file, '{"v":1,"seq":2,"at":"2026-01-01T00:00:00Z","id":"x","task":"');
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { revision: task.revision },
  });
  const written = store.mutateTask(task.id, task.revision, (current) =>
    success(null, null, { ...current, progress: progress("after the crash") }),
  );
  expect(written.ok).toBe(true);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith(intact)).toBe(true);
  expect(text.endsWith("\n")).toBe(true);
  expect(eventsOf(root, task.id).map((event) => event.seq)).toEqual([1, 2]);
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { progress: { summary: "after the crash" } },
  });
});

const STORE_MODULE = path.resolve(
  import.meta.dir,
  "../../packages/workit-core/src/core/task-store.ts",
);
test("Given writers killed with SIGKILL mid-append, Then the log never corrupts and writes continue", async () => {
  const root = tempDir("wk-s15-kill-");
  const task = implicit(root)!.task;
  const script = `
    import { TaskStore } from ${JSON.stringify(STORE_MODULE)};
    const store = new TaskStore(${JSON.stringify(root)}, { lockTimeoutMs: 2000 });
    const big = "x".repeat(20000);
    for (let index = 0; ; index += 1) {
      const current = store.readTask(${JSON.stringify(task.id)});
      if (!current.ok) { console.error(current.error); process.exit(3); }
      const written = store.mutateTask(current.data.id, current.data.revision, (value) => ({
        ok: true, revision: null, workspaceRevision: null,
        data: { ...value, progress: { summary: big + index, nextAction: null, blockers: [] } },
      }));
      if (written.ok) process.stdout.write("w\\n");
    }
  `;
  const lock = path.join(taskDirOf(root, task.id), "lock");
  // A writer killed while writing the lock file leaves it unreadable, which
  // S1 treats as being written until its TTL (retryable busy, never damage);
  // let that TTL pass between rounds.
  const ageLock = () => {
    if (!existsSync(lock)) return;
    const old = new Date(Date.now() - 15 * 60_000);
    utimesSync(lock, old, old);
  };
  for (let round = 0; round < 6; round += 1) {
    let writes = 0;
    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk: Buffer) => (writes += String(chunk).split("w").length - 1));
      return child;
    });
    // Kill mid-stream: once writes are landing (startup speed varies by
    // runner), after a random extra delay.
    const until = Date.now() + 15_000;
    while (writes < 2 && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
    await new Promise((done) => setTimeout(done, Math.floor(Math.random() * 60)));
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => new Promise((done) => child.on("close", done))));
    const read = new TaskStore(root).readTask(task.id);
    expect(read.ok, read.ok ? "" : read.error).toBe(true);
    ageLock();
  }
  const events = eventsOf(root, task.id);
  expect(events.length).toBeGreaterThan(2);
  // Consecutive from the first event (large writes may have compacted the log).
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => events[0].seq + index));
  const current = new TaskStore(root).readTask(task.id);
  if (!current.ok) throw new Error(current.error);
  const after = new TaskStore(root).mutateTask(task.id, current.data.revision, identity);
  expect(after.ok, after.ok ? "" : `${after.code}: ${after.error}`).toBe(true);
}, 60_000);

test("updates that edit the record in place are still recorded", () => {
  const root = tempDir("wk-s15-inplace-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  const written = store.mutateTask(task.id, task.revision, (current) => {
    current.progress.summary = "edited in place";
    current.progress.blockers.push({ reason: "r", dependentAction: "d", refs: [] });
    return success(null, null, current);
  });
  expect(written.ok).toBe(true);
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { progress: { summary: "edited in place", blockers: [{ reason: "r" }] } },
  });
});

test("stored candidates are content-addressed blobs, written once and collected when unreferenced", () => {
  const root = tempDir("wk-s15-blobs-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  for (let index = 0; index < 200; index += 1)
    writeFileSync(path.join(root, `file-${index}.ts`), `export const v${index} = ${index};\n`);
  const captured = captureCandidate(root, scope(), []);
  if (!captured.ok) throw new Error(captured.error);
  const candidate = captured.data;
  let revision = task.revision;
  for (let index = 0; index < 3; index += 1) {
    const written = store.mutateTask(task.id, revision, (current) =>
      success(null, null, { ...current, candidates: [...current.candidates, candidate] } as never),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
  }
  const blobs = path.join(storeDirOf(root), "blobs", "candidates");
  expect(readdirSync(blobs)).toHaveLength(1);
  expect(statSync(eventsFileOf(root, task.id)).size).toBeLessThan(4000);
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { candidates: [candidate, candidate, candidate] },
  });
  // An unreferenced blob older than the grace period is collected.
  const orphan = path.join(blobs, `${"e".repeat(64)}.json`);
  writeFileSync(orphan, "{}");
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  utimesSync(orphan, old, old);
  expect(store.collectGarbage()).toMatchObject({ ok: true, data: { blobs: { removed: 1 } } });
  expect(readdirSync(blobs)).toHaveLength(1);
});

test("reader tolerance: unknown events are ignored, a critical unknown event fails closed with an upgrade message", () => {
  const root = tempDir("wk-s15-unknown-");
  const task = implicit(root)!.task;
  const file = eventsFileOf(root, task.id);
  const event = (seq: number, extra: Record<string, unknown>) =>
    `${JSON.stringify({ v: 1, seq, at: "2026-01-01T00:00:00Z", id: `e${seq}`, task: task.id, actor: null, type: "stack.linked", data: { pr: 7 }, futureKey: true, ...extra })}\n`;
  appendFileSync(file, event(2, {}));
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { revision: task.revision },
  });
  appendFileSync(file, event(3, { critical: true }));
  const read = new TaskStore(root).readTask(task.id);
  expect(read).toMatchObject({ ok: false, code: "recovery_required" });
  expect(!read.ok && read.error).toContain("upgrade Workit");
  // A newer event format is refused the same way.
  writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
  appendFileSync(file, `${JSON.stringify({ v: 2, seq: 3 })}\n`);
  rmSync(path.join(taskDirOf(root, task.id), "snapshot.json"), { force: true });
  const newer = new TaskStore(root).readTask(task.id);
  expect(!newer.ok && newer.error).toContain("upgrade Workit");
});

test("structural patches round-trip", () => {
  const before = { a: 1, list: [{ x: 1 }, { x: 2 }], nested: { keep: true, drop: 1 } };
  const after = { a: 2, list: [{ x: 1 }, { x: 3 }, { x: 4 }], nested: { keep: true }, added: [1] };
  const ops = diff(before, after);
  expect(apply(structuredClone(before), ops)).toEqual(after);
  expect(apply(structuredClone(after), diff(after, before))).toEqual(before);
  expect(diff(before, structuredClone(before))).toEqual([]);
});

// ---------------------------------------------------------------------------
// 2.x migration

/** Turn a 3.x store in `root` (non-git) into the 2.x layout of the same records. */
const asV2Store = (root: string) => {
  const store = new TaskStore(root);
  const workspace = store.readWorkspace();
  const tasks = store.listTasks();
  if (!workspace.ok || !workspace.data || !tasks.ok) throw new Error("fixture state missing");
  const workit = path.join(root, ".workit");
  rmSync(workit, { recursive: true, force: true });
  mkdirSync(path.join(workit, "tasks"), { recursive: true });
  mkdirSync(path.join(workit, "recovery"), { recursive: true });
  writeFileSync(path.join(workit, ".gitignore"), "*\n");
  writeFileSync(path.join(workit, "workspace.json"), `${canonicalJson(workspace.data)}\n`);
  for (const task of tasks.data) {
    const bytes = `${canonicalJson(task)}\n`;
    writeFileSync(path.join(workit, "tasks", `${task.id}.json`), bytes);
    for (const copy of [0, 1, 2])
      writeFileSync(
        path.join(workit, "recovery", `task.${task.id}.${String(copy).repeat(64)}.json`),
        bytes,
      );
  }
  writeFileSync(path.join(workit, "index.json"), JSON.stringify({ version: 1, tasks: {} }));
  return tasks.data.map((task) => task.id);
};

const inspectAll = (root: string, ids: string[]) =>
  ids.map((taskId) => {
    const core = coreFor(root);
    const summary = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    const full = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "full" });
    return { summary, full };
  });

test("Given a 2.x .workit store with tasks and recovery copies, When 3.0 runs twice, Then the tasks migrate once (inspect unchanged), a backup is kept, recovery stays until pruned, and a 2.x reader fails closed", async () => {
  const root = tempDir("wk-s15-migrate-");
  const core = coreFor(root);
  const ids: string[] = [];
  for (const objective of ["first", "second", "third"]) {
    const started = core.task(
      taskStartRequest({
        expectedWorkspaceRevision: undefined,
        intent: { objective, scope: scope(), authorityRefs: [ref()] },
      }),
    );
    if (!started.ok) throw new Error(started.error);
    ids.push((started.data as { id: string }).id);
  }
  expect(
    core.task({ schemaVersion: 1, action: "progress", taskId: ids[1], progress: progress("half") })
      .ok,
  ).toBe(true);
  expect(
    core.task({
      schemaVersion: 1,
      action: "close",
      taskId: ids[2],
      outcome: "stopped",
      summary: "not needed",
    }).ok,
  ).toBe(true);
  const expected = inspectAll(root, ids);
  expect(asV2Store(root).toSorted()).toEqual([...ids].toSorted());

  // First 3.0 run (the CLI) migrates and says so once, on stderr.
  const status = await cli(root, ["task", "status", "--all", "--json"]);
  expect(status.code).toBe(0);
  expect(status.stderr).toContain("workit: migrated 3 tasks from");
  const listed = status.json().data.tasks as Array<{ id: string; legacy: boolean; key: unknown }>;
  expect(listed.map((task) => task.id).toSorted()).toEqual([...ids].toSorted());
  expect(listed.every((task) => task.legacy && task.key === null)).toBe(true);
  expect(inspectAll(root, ids)).toEqual(expected);
  for (const id of ids) expect(eventsOf(root, id)[0].type).toBe("migrated.from_v2");

  // Backup kept; 2.x task files gone; recovery left in place.
  const backup = path.join(root, ".workit", "legacy");
  const backedUp = readdirSync(backup, { recursive: true }).map(String);
  for (const id of ids) expect(backedUp.some((name) => name.endsWith(`${id}.json`))).toBe(true);
  // Each 2.x task file is now a marker a 2.x reader fails closed on.
  const stub = JSON.parse(
    readFileSync(path.join(root, ".workit", "tasks", `${ids[0]}.json`), "utf8"),
  );
  expect(stub).toMatchObject({
    id: ids[0],
    critical: ["store"],
    runtime: { updatedWith: "3.0.0" },
  });
  expect(readdirSync(path.join(root, ".workit", "recovery"))).toHaveLength(9);

  // Second run: a no-op.
  const logs = ids.map((id) => readFileSync(eventsFileOf(root, id), "utf8"));
  const again = await cli(root, ["task", "status", "--all", "--json"]);
  expect(again.stderr).not.toContain("migrated");
  expect(ids.map((id) => readFileSync(eventsFileOf(root, id), "utf8"))).toEqual(logs);

  // A legacy task is adopted onto the current key explicitly.
  const adopted = await cli(root, ["task", "adopt", ids[1], "--json"]);
  expect(adopted.json()).toMatchObject({ ok: true, data: { task: { id: ids[1] } } });
  expect(implicit(root, false)!.task.id).toBe(ids[1]);

  // gc reports the recovery copies and removes them only when asked.
  const report = await cli(root, ["gc", "--json"]);
  expect(report.json().data.legacyRecovery).toMatchObject({ files: 9, removed: false });
  expect(existsSync(path.join(root, ".workit", "recovery"))).toBe(true);
  expect((await cli(root, ["gc", "--prune-recovery"])).code).toBe(3);
  expect(existsSync(path.join(root, ".workit", "recovery"))).toBe(true);
  const pruned = await cli(root, ["gc", "--prune-recovery", "--yes", "--json"]);
  expect(pruned.json().data.legacyRecovery).toMatchObject({ files: 9, removed: true });
  expect(existsSync(path.join(root, ".workit", "recovery"))).toBe(false);

  // A 2.x reader sees only the marker at .workit/workspace.json and fails
  // closed: the field it cannot read is declared critical (2.7 rule), and
  // runtimes before that rule see a record written by a newer Workit.
  const marker = JSON.parse(readFileSync(path.join(root, ".workit", "workspace.json"), "utf8"));
  expect(parseStoredRecord(workspaceRecordSchema, marker)).toMatchObject({
    success: false,
    critical: ["store"],
  });
  expect(workspaceRecordSchema.strict().safeParse(marker).success).toBe(false);
  expect(marker.runtime.updatedWith).toBe("3.0.0");
});

test("Given a 2.x store in a git checkout, Then it migrates into the git common dir and other worktrees see it", async () => {
  const root = repo();
  const core = coreFor(root);
  const started = core.task(taskStartRequest({ expectedWorkspaceRevision: undefined }));
  if (!started.ok) throw new Error(started.error);
  const id = (started.data as { id: string }).id;
  const expected = inspectAll(root, [id]);
  // Rebuild it as a 2.x per-checkout store.
  const record = new TaskStore(root).readTask(id);
  const workspace = new TaskStore(root).readWorkspace();
  if (!record.ok || !workspace.ok || !workspace.data) throw new Error("fixture");
  rmSync(path.join(root, ".git", "workit"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".workit", "tasks"), { recursive: true });
  writeFileSync(path.join(root, ".workit", "workspace.json"), canonicalJson(workspace.data));
  writeFileSync(path.join(root, ".workit", "tasks", `${id}.json`), canonicalJson(record.data));
  // Reads outside the CLI never migrate; they name the command that does.
  const pending = new TaskStore(root, { migrateOnRead: false }).listTaskIndex();
  expect(pending).toMatchObject({ ok: false, code: "needs_input" });
  expect(!pending.ok && pending.error).toContain("workit task status");
  expect((await cli(root, ["task", "status"])).stderr).toContain("workit: migrated 1 task");
  expect(inspectAll(root, [id])).toEqual(expected);
  expect(existsSync(eventsFileOf(root, id))).toBe(true);
  expect(eventsFileOf(root, id).startsWith(path.join(root, ".git", "workit"))).toBe(true);
  expect(existsSync(workspaceFileOf(root))).toBe(true);
  expect(
    JSON.parse(readFileSync(path.join(root, ".workit", "workspace.json"), "utf8")).store,
  ).toMatchObject({ format: "workit-store", path: path.join(root, ".git", "workit") });
});

test("a directory that becomes a git repository moves its store into the git common dir", () => {
  const root = tempDir("wk-s15-gitinit-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  git(root, "init", "-q");
  expect(store.readTask(task.id)).toMatchObject({ ok: true, data: { id: task.id } });
  expect(existsSync(eventsFileOf(root, task.id))).toBe(true);
  expect(eventsFileOf(root, task.id).startsWith(path.join(root, ".git", "workit"))).toBe(true);
  expect(existsSync(path.join(root, ".workit", "store.moved.json"))).toBe(true);
});

// ---------------------------------------------------------------------------
// CLI

test("workit task start|note|status|close: idempotent per branch, no ids needed", async () => {
  const root = repo("feature/cli");
  const none = await cli(root, ["task", "status", "--json"]);
  expect(none.json()).toMatchObject({
    ok: true,
    data: { task: null, key: { key: "feature/cli" } },
  });
  const started = await cli(root, ["task", "start", "Ship the parser", "--json"]);
  expect(started.json()).toMatchObject({
    ok: true,
    data: { created: true, task: { objective: "Ship the parser" } },
  });
  const id = started.json().data.task.id;
  const again = await cli(root, ["task", "start", "Ship the parser", "--json"]);
  expect(again.json()).toMatchObject({ ok: true, data: { created: false, task: { id } } });
  const noted = await cli(root, ["task", "note", "parser done", "--next", "write docs", "--json"]);
  expect(noted.json()).toMatchObject({
    ok: true,
    data: { task: { id, progress: { summary: "parser done", nextAction: "write docs" } } },
  });
  const status = await cli(root, ["task", "status"]);
  expect(status.stdout).toContain(id);
  expect(status.stdout).toContain("next: write docs");
  // Closing needs consent, like the family close.
  const refused = await cli(root, ["task", "close", "--outcome", "stopped", "--json"]);
  expect(refused.code).not.toBe(0);
  const closed = await cli(root, ["task", "close", "--outcome", "stopped", "--confirm", "--json"]);
  expect(closed.code).toBe(0);
  expect((await cli(root, ["task", "status", "--json"])).json().data.task).toBeNull();
  // The closed task stays listed.
  const all = await cli(root, ["task", "status", "--all", "--json"]);
  expect(all.json().data.tasks).toEqual([expect.objectContaining({ id, status: "closed" })]);
});

test("ledger and commit verbs create the branch's implicit task", async () => {
  const root = repo("feature/ledger");
  const recorded = await cli(root, [
    "ledger",
    "decision",
    "use the event log",
    "--why",
    "bounded state",
    "--json",
  ]);
  expect(recorded.code).toBe(0);
  expect(implicit(root, false)).toMatchObject({ key: { key: "feature/ledger" } });
});

test("the filesystem fast path finds the same store and key as git", () => {
  const root = repo("feature/fast");
  const linked = path.join(tempDir("wk-s15-fast-"), "linked");
  git(root, "worktree", "add", "-q", "-b", "feature/linked", linked);
  const subdir = path.join(root, "sub");
  mkdirSync(subdir);
  const viaGit = (cwd: string) =>
    path.join(
      realpathSync.native(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")),
      "workit",
    );
  for (const cwd of [root, linked, subdir]) {
    const fast = resolveStore(cwd);
    if (fast instanceof Error) throw fast;
    expect(fast.git).toBeDefined();
    expect(fast.dir).toBe(viaGit(cwd));
    const branch = git(cwd, "symbolic-ref", "--short", "HEAD");
    expect(resolveTaskKey(cwd, fast)).toEqual({ key: branch, kind: "branch", branch });
    // Without the fast path (a GIT_* override) git answers the same.
    process.env.GIT_CEILING_DIRECTORIES = "/nonexistent";
    try {
      const slow = resolveStore(cwd);
      if (slow instanceof Error) throw slow;
      expect(slow.git).toBeUndefined();
      expect(slow.dir).toBe(fast.dir);
      expect(resolveTaskKey(cwd, slow)).toEqual(resolveTaskKey(cwd, fast));
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  }
  git(linked, "checkout", "-q", "--detach");
  const fast = resolveStore(linked);
  if (fast instanceof Error) throw fast;
  process.env.GIT_CEILING_DIRECTORIES = "/nonexistent";
  try {
    const slow = resolveStore(linked);
    if (slow instanceof Error) throw slow;
    expect(resolveTaskKey(linked, fast)).toEqual(resolveTaskKey(linked, slow));
    expect(resolveTaskKey(linked, fast).kind).toBe("detached");
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
  expect(resolveStore(tempDir("wk-s15-nogit-"))).toMatchObject({ shared: false });
});

test("a log past the watermark compacts itself on append, without a gc run", () => {
  const root = tempDir("wk-s15-auto-");
  const store = new TaskStore(root);
  const task = implicit(root)!.task;
  const big = "y".repeat(40_000);
  let revision = task.revision;
  for (let index = 0; index < 80; index += 1) {
    const written = store.mutateTask(task.id, revision, (current) =>
      success(null, null, { ...current, progress: progress(`${big}${index}`) }),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
  }
  expect(statSync(eventsFileOf(root, task.id)).size).toBeLessThanOrEqual(AUTO_COMPACT_BYTES);
  expect(eventsOf(root, task.id)[0].type).toBe("task.checkpoint");
  expect(new TaskStore(root).readTask(task.id)).toMatchObject({
    ok: true,
    data: { progress: { summary: `${big}79` } },
  });
});
