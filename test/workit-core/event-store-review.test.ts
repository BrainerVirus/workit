// S15 review (#186): migration never loses 2.x writes, one checkout per
// worktree, one implicit task per key, and the git layouts the store must read.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { localLockHost, processStartOf } from "@/packages/workit-core/src/core/store-lock";
import {
  canonicalJson,
  success,
  type Provenance,
  type TaskRecord,
} from "@/packages/workit-core/src/core/task-contract";
import { resolveStore, resolveTaskKey } from "@/packages/workit-core/src/store/paths";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { caller, ref, scope, taskStartRequest } from "./task-fixtures";
import { eventsOf, storeDirOf } from "./store-files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
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
  const root = tempDir("wk-s15r-repo-");
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
const coreFor = (root: string, store = new TaskStore(root)) =>
  new WorkitCore(store, {
    root,
    caller: caller({ actor: "agent" }),
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
const cli = async (cwd: string, argv: string[]) => {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "s-agent", WORKFLOW_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** A 2.x `.workit` store with `count` tasks in `root`, built from 3.x records. */
const v2Fixture = (root: string, count: number): string[] => {
  const core = coreFor(root);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = core.task(
      taskStartRequest({
        expectedWorkspaceRevision: undefined,
        intent: { objective: `task ${index}`, scope: scope(), authorityRefs: [ref()] },
      }),
    );
    if (!started.ok) throw new Error(started.error);
    ids.push((started.data as { id: string }).id);
  }
  const store = new TaskStore(root);
  const workspace = store.readWorkspace();
  const tasks = store.listTasks();
  if (!workspace.ok || !workspace.data || !tasks.ok) throw new Error("fixture");
  rmSync(storeDirOf(root), { recursive: true, force: true });
  rmSync(path.join(root, ".workit"), { recursive: true, force: true });
  mkdirSync(path.join(root, ".workit", "tasks"), { recursive: true });
  writeFileSync(path.join(root, ".workit", "workspace.json"), `${canonicalJson(workspace.data)}\n`);
  for (const task of tasks.data)
    writeFileSync(
      path.join(root, ".workit", "tasks", `${task.id}.json`),
      `${canonicalJson(task)}\n`,
    );
  return ids;
};
/** What a 2.x writer does: rewrite one task file with a new revision. */
const v2Write = (root: string, id: string, summary: string) => {
  const file = path.join(root, ".workit", "tasks", `${id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8")) as TaskRecord;
  writeFileSync(
    file,
    `${canonicalJson({
      ...record,
      revision: crypto.randomUUID(),
      progress: { summary, nextAction: null, blockers: [] },
    })}\n`,
  );
};

// ---------------------------------------------------------------------------
// H1: migration

test("Given a migration interrupted after some tasks and a 2.x write to a migrated task, When 3.0 runs again, Then the 2.x write is migrated, not skipped", async () => {
  const root = repo("feature/mig");
  const ids = v2Fixture(root, 6);
  const pristine = path.join(tempDir("wk-s15r-copy-"), "workit");
  cpSync(path.join(root, ".workit"), pristine, { recursive: true });
  // A run that migrated everything, then "died" before stubbing and marking:
  // put the untouched 2.x files back and drop the logs of the last tasks.
  expect((await cli(root, ["task", "status"])).code).toBe(0);
  rmSync(path.join(root, ".workit"), { recursive: true, force: true });
  cpSync(pristine, path.join(root, ".workit"), { recursive: true });
  for (const id of ids.slice(4))
    rmSync(path.join(storeDirOf(root), "tasks", id), { recursive: true, force: true });
  // The 2.x runtime is still in charge of the checkout and writes.
  v2Write(root, ids[1], "written by 2.x after the interrupted run");
  const again = await cli(root, ["task", "status", "--all", "--json"]);
  expect(again.code).toBe(0);
  expect(again.stderr).toContain("workit: migrated 3 tasks");
  const read = new TaskStore(root).readTask(ids[1]);
  expect(read).toMatchObject({
    ok: true,
    data: { progress: { summary: "written by 2.x after the interrupted run" } },
  });
  expect(eventsOf(root, ids[1]).map((event) => event.type)).toEqual([
    "migrated.from_v2",
    "migrated.from_v2",
  ]);
  for (const id of ids) expect(new TaskStore(root).readTask(id).ok).toBe(true);
  // The backup holds the latest 2.x bytes.
  const backup = readdirSync(path.join(storeDirOf(root), "legacy"), { recursive: true })
    .map(String)
    .find((name) => name.endsWith(`${ids[1]}.json`))!;
  expect(readFileSync(path.join(storeDirOf(root), "legacy", backup), "utf8")).toContain(
    "written by 2.x after the interrupted run",
  );
  // A third run is a no-op.
  const logs = ids.map((id) =>
    readFileSync(path.join(storeDirOf(root), "tasks", id, "events.jsonl"), "utf8"),
  );
  expect((await cli(root, ["task", "status"])).stderr).not.toContain("migrated");
  expect(
    ids.map((id) => readFileSync(path.join(storeDirOf(root), "tasks", id, "events.jsonl"), "utf8")),
  ).toEqual(logs);
});

test("Given a live 2.x writer holding .workit/metadata.lock, Then 3.0 does not migrate under it (busy, nothing changed), and migrates once it is gone", async () => {
  const root = tempDir("wk-s15r-live-");
  const ids = v2Fixture(root, 2);
  const lock = path.join(root, ".workit", "metadata.lock");
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      processStart: processStartOf(process.pid),
      host: localLockHost(),
      nonce: "live-2x",
    }),
  );
  const before = readFileSync(path.join(root, ".workit", "tasks", `${ids[0]}.json`), "utf8");
  const busy = await cli(root, ["task", "status", "--json"]);
  expect(busy.code).toBe(4);
  expect(busy.json()).toMatchObject({ ok: false, code: "busy" });
  expect(existsSync(path.join(storeDirOf(root), "tasks", ids[0]))).toBe(false);
  expect(readFileSync(path.join(root, ".workit", "tasks", `${ids[0]}.json`), "utf8")).toBe(before);
  expect(readFileSync(lock, "utf8")).toContain("live-2x");
  rmSync(lock);
  expect((await cli(root, ["task", "status"])).stderr).toContain("workit: migrated 2 tasks");
});

test("hooks and other non-CLI reads never migrate; writes do", () => {
  const root = tempDir("wk-s15r-hook-");
  const ids = v2Fixture(root, 1);
  const store = new TaskStore(root, { migrateOnRead: false });
  const read = store.listTaskIndex();
  expect(read).toMatchObject({ ok: false, code: "needs_input" });
  expect(existsSync(path.join(storeDirOf(root), "tasks", ids[0]))).toBe(false);
  const write = store.implicitTask({ provenance, create: true });
  expect(write.ok).toBe(true);
  expect(new TaskStore(root, { migrateOnRead: false }).readTask(ids[0]).ok).toBe(true);
});

test("a 2.x store created after 3.0 (e.g. after git clean) joins the checkout's existing workspace", async () => {
  const root = tempDir("wk-s15r-join-");
  const first = new TaskStore(root).implicitTask({ provenance, create: true });
  if (!first.ok || !first.data) throw new Error("setup");
  const workspace = new TaskStore(root).readWorkspace();
  if (!workspace.ok || !workspace.data) throw new Error("workspace");
  // A 2.x runtime starts its own store with its own workspace id.
  rmSync(path.join(root, ".workit", "workspace.json"));
  const record = { ...first.data.task, id: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
  mkdirSync(path.join(root, ".workit", "tasks"), { recursive: true });
  writeFileSync(
    path.join(root, ".workit", "workspace.json"),
    canonicalJson({ ...workspace.data, id: record.workspaceId }),
  );
  writeFileSync(path.join(root, ".workit", "tasks", `${record.id}.json`), canonicalJson(record));
  expect((await cli(root, ["task", "status"])).code).toBe(0);
  const listed = new TaskStore(root).listTasks();
  expect(listed.ok && listed.data.map((task) => task.id).toSorted()).toEqual(
    [first.data.task.id, record.id].toSorted(),
  );
});

test("3.0 writes the 2.x marker into every git checkout it writes for", () => {
  const root = repo();
  new TaskStore(root).implicitTask({ provenance, create: true });
  const marker = JSON.parse(readFileSync(path.join(root, ".workit", "workspace.json"), "utf8"));
  expect(marker).toMatchObject({ store: { format: "workit-store" }, critical: ["store"] });
  expect(readFileSync(path.join(root, ".workit", ".gitignore"), "utf8")).toBe("*\n");
  expect(git(root, "status", "--porcelain")).toBe("");
});

// ---------------------------------------------------------------------------
// H2, M1: one checkout per worktree, one task per key

test("a subdirectory is the same checkout as its worktree top; a lookup never binds or moves a task", () => {
  const root = repo();
  const sub = path.join(root, "pkg", "deep");
  mkdirSync(sub, { recursive: true });
  const top = new TaskStore(root);
  const below = new TaskStore(sub);
  expect(below.root).toBe(top.root);
  const created = top.implicitTask({ provenance, create: true });
  if (!created.ok || !created.data) throw new Error("create");
  const looked = below.implicitTask({ provenance, create: false });
  expect(looked).toMatchObject({
    ok: true,
    data: { created: false, task: { id: created.data.task.id } },
  });
  expect(eventsOf(root, created.data.task.id)).toHaveLength(1);
  // The same task is mutable from both, with the same revision.
  expect(
    top.mutateTask(created.data.task.id, created.data.task.revision, (task) =>
      success(null, null, task),
    ).ok,
  ).toBe(true);
  // An engine context in the subdirectory serves the same checkout.
  expect(coreFor(sub, below).task({ schemaVersion: 1, action: "inspect" })).toMatchObject({
    ok: true,
  });
});

const STORE_MODULE = path.resolve(
  import.meta.dir,
  "../../packages/workit-core/src/core/task-store.ts",
);
test("Given concurrent first recordings on one branch from two checkouts, Then exactly one task is created", async () => {
  const root = repo("main-race");
  // Two worktrees on one branch (`--force`): different checkouts, one key.
  const sub = path.join(tempDir("wk-s15r-race-"), "twin");
  git(root, "worktree", "add", "-q", "--detach", sub);
  for (let round = 0; round < 5; round += 1) {
    git(root, "checkout", "-qb", `race-${round}`);
    git(sub, "checkout", "-q", "--force", "--ignore-other-worktrees", `race-${round}`);
    const at = Date.now() + 400;
    const run = (cwd: string) =>
      new Promise<string>((done) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `import { TaskStore } from ${JSON.stringify(STORE_MODULE)};
             const s = new TaskStore(${JSON.stringify(cwd)}, { lockTimeoutMs: 5000 });
             s.currentKey();
             while (Date.now() < ${at}) {}
             const r = s.implicitTask({ provenance: ${JSON.stringify(provenance)}, create: true });
             process.stdout.write(r.ok ? r.data.task.id : "ERR " + r.error);`,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("close", () => done(out));
      });
    const [a, b] = await Promise.all([run(root), run(sub)]);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
  }
  const all = new TaskStore(root).listStoreIndex();
  const perKey = new Map<string, number>();
  for (const entry of all.ok ? all.data : [])
    perKey.set(entry.key!, (perKey.get(entry.key!) ?? 0) + 1);
  expect([...perKey.values()].every((count) => count === 1)).toBe(true);
}, 60_000);

test("duplicate open tasks on one key: the oldest is used and task status names the others with a close command", async () => {
  const root = repo("feature/dup");
  const first = new TaskStore(root).implicitTask({ provenance, create: true });
  if (!first.ok || !first.data) throw new Error("setup");
  // A duplicate as an older (2.x-era) race could leave it: same key, newer.
  const copy = { ...first.data.task, id: crypto.randomUUID(), createdAt: "2099-01-01T00:00:00Z" };
  const dir = path.join(storeDirOf(root), "tasks", copy.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify({ v: 1, seq: 1, at: "2099-01-01T00:00:00Z", id: "dup", task: copy.id, actor: null, type: "task.opened", data: { record: copy, key: first.data.key } })}\n`,
  );
  expect(new TaskStore(root).implicitTask({ provenance, create: false })).toMatchObject({
    ok: true,
    data: { task: { id: first.data.task.id } },
  });
  const status = await cli(root, ["task", "status", "--json"]);
  expect(status.json().data.notes).toEqual([
    expect.objectContaining({
      id: copy.id,
      kind: "duplicate",
      hint: expect.stringContaining(`--task ${copy.id}`),
    }),
  ]);
});

// ---------------------------------------------------------------------------
// M3–M6: git layouts

const viaGit = (cwd: string) =>
  path.join(
    realpathSync.native(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    "workit",
  );

test("a symlink into a repository subdirectory and a bare repository resolve like git", () => {
  const root = repo();
  mkdirSync(path.join(root, "pkg"));
  const link = path.join(tempDir("wk-s15r-link-"), "pkg-link");
  symlinkSync(path.join(root, "pkg"), link, "dir");
  const linked = resolveStore(link);
  if (linked instanceof Error) throw linked;
  expect(linked.dir).toBe(viaGit(link));
  expect(new TaskStore(link).root).toBe(new TaskStore(root).root);
  const bare = path.join(tempDir("wk-s15r-bare-"), "repo.git");
  git(path.dirname(bare), "init", "-q", "--bare", bare);
  const located = resolveStore(bare);
  if (located instanceof Error) throw located;
  expect(located).toMatchObject({
    shared: true,
    dir: path.join(realpathSync.native(bare), "workit"),
  });
  expect(located.dir).toBe(viaGit(bare));
});

test("a reftable HEAD stub is never read as a branch; the key comes from git", () => {
  const root = repo("feature/real");
  const location = resolveStore(root);
  if (location instanceof Error) throw location;
  // reftable leaves `ref: refs/heads/.invalid` in HEAD and the refs elsewhere.
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
  expect(resolveTaskKey(root, location).key).not.toBe(".invalid");
  git(root, "config", "extensions.refStorage", "reftable");
  const flagged = resolveStore(root);
  if (flagged instanceof Error) throw flagged;
  expect(flagged.git?.reftable).toBe(true);
  expect(resolveTaskKey(root, flagged).key).not.toBe(".invalid");
});

test("during a rebase (detached HEAD) the key is the branch being rebased", () => {
  const root = repo("feature/rebase");
  writeFileSync(path.join(root, "b.txt"), "two\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "two");
  const before = new TaskStore(root).currentKey();
  git(root, "checkout", "-q", "--detach");
  mkdirSync(path.join(root, ".git", "rebase-merge"));
  writeFileSync(
    path.join(root, ".git", "rebase-merge", "head-name"),
    "refs/heads/feature/rebase\n",
  );
  const during = new TaskStore(root).currentKey();
  expect(during).toMatchObject({ ok: true, data: { key: "feature/rebase", kind: "branch" } });
  expect(before.ok && during.ok && before.data.key).toBe(during.ok ? during.data.key : "");
});

test("after a branch rename, task status offers the exact adopt command; closed tasks are never reused", async () => {
  const root = repo("feature/old");
  const old = new TaskStore(root).implicitTask({ provenance, create: true });
  if (!old.ok || !old.data) throw new Error("setup");
  git(root, "branch", "-m", "feature/new");
  const status = await cli(root, ["task", "status", "--json"]);
  expect(status.json().data).toMatchObject({
    task: null,
    notes: [
      { id: old.data.task.id, kind: "renamed", hint: `workit task adopt ${old.data.task.id}` },
    ],
  });
  expect((await cli(root, ["task", "adopt", old.data.task.id])).code).toBe(0);
  expect(new TaskStore(root).implicitTask({ provenance, create: false })).toMatchObject({
    ok: true,
    data: { task: { id: old.data.task.id } },
  });
});

// ---------------------------------------------------------------------------
// L1: blobs

test("a reused blob is refreshed, so gc's grace period protects it", () => {
  const root = tempDir("wk-s15r-blob-");
  writeFileSync(path.join(root, "f.ts"), "export {};\n");
  const store = new TaskStore(root);
  const task = store.implicitTask({ provenance, create: true });
  if (!task.ok || !task.data) throw new Error("setup");
  const captured = captureCandidate(store.root, scope(), []);
  if (!captured.ok) throw new Error(captured.error);
  const blobs = path.join(storeDirOf(root), "blobs", "candidates");
  let revision = task.data.task.revision;
  const push = () => {
    const written = store.mutateTask(task.data!.task.id, revision, (current) =>
      success(null, null, { ...current, candidates: [...current.candidates, captured.data] }),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
  };
  push();
  const [name] = readdirSync(blobs);
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(path.join(blobs, name), old, old);
  push();
  expect(Date.now() - statSync(path.join(blobs, name)).mtimeMs).toBeLessThan(60_000);
  expect(store.collectGarbage()).toMatchObject({
    ok: true,
    data: { blobs: { removed: 0, kept: 1 } },
  });
});

// ---------------------------------------------------------------------------
// L2: compaction holds the task lock only to swap

test("an append between building a checkpoint and swapping it is carried over", () => {
  const root = tempDir("wk-s15r-compact-");
  const store = new TaskStore(root);
  const created = store.implicitTask({ provenance, create: true });
  if (!created.ok || !created.data) throw new Error("setup");
  const id = created.data.task.id;
  let revision = created.data.task.revision;
  for (let index = 0; index < 120; index += 1) {
    const written = store.mutateTask(id, revision, (current) =>
      success(null, null, {
        ...current,
        progress: { summary: `n${index}`, nextAction: null, blockers: [] },
      }),
    );
    if (!written.ok) throw new Error(written.error);
    revision = written.data.revision;
  }
  // Another writer appends after the checkpoint was built, before the swap.
  const other = new TaskStore(root);
  const internals = store as unknown as {
    withLock: (lockPath: string, operation: () => unknown) => unknown;
  };
  const withLock = internals.withLock.bind(store);
  let raced = false;
  internals.withLock = (lockPath, operation) => {
    if (!raced && lockPath.endsWith(`${id}${path.sep}lock`)) {
      raced = true;
      const written = other.mutateTask(id, revision, (current) =>
        success(null, null, {
          ...current,
          progress: { summary: "raced", nextAction: null, blockers: [] },
        }),
      );
      if (!written.ok) throw new Error(written.error);
    }
    return withLock(lockPath, operation);
  };
  expect(store.collectGarbage({ compactAbove: 100 })).toMatchObject({
    ok: true,
    data: { compacted: { tasks: [id] } },
  });
  expect(raced).toBe(true);
  expect(new TaskStore(root).readTask(id)).toMatchObject({
    ok: true,
    data: { progress: { summary: "raced" } },
  });
  expect(eventsOf(root, id).at(-1)?.seq).toBe(122);
});
