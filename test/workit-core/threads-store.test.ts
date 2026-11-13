// #329 part 1: the per-user threads store (docs/specs/threads.md). Real
// processes on both runtimes: Bun runs the store's source, Node runs it
// bundled for Node the way the CLI ships (`bun build --target node`).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProc, upsertProc } from "@/packages/workit-core/src/store/threads/procs";
import {
  openThreadsStore,
  ThreadsBusyError,
  ThreadsSchemaError,
} from "@/packages/workit-core/src/store/threads/store";
import { spawnHeavyTimeout } from "../shared/timeouts";

setDefaultTimeout(spawnHeavyTimeout() * 2);

const ROOT = path.resolve(import.meta.dir, "../..");
const STORE = path.join(ROOT, "packages/workit-core/src/store/threads/store.ts");
const PROCS = path.join(ROOT, "packages/workit-core/src/store/threads/procs.ts");

// One worker script, run as `<mode> <state dir> ...args`.
const WORKER = `
import fs from "node:fs";
import path from "node:path";
import { openThreadsStore } from ${JSON.stringify(STORE)};
import { upsertProc } from ${JSON.stringify(PROCS)};

const [mode, dir, ...args] = process.argv.slice(2);
const env = { WORKIT_STATE_DIR: dir };
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (name) => {
  while (!fs.existsSync(path.join(dir, name))) Atomics.wait(pause, 0, 0, 2);
};
const signal = (name) => fs.writeFileSync(path.join(dir, name), "");

if (mode === "open") {
  try {
    const store = openThreadsStore({ env });
    const row = store.db.get("SELECT value FROM meta WHERE key = 'schema_version'");
    console.log(JSON.stringify({ file: store.file, version: row.value }));
    store.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 3;
  }
} else if (mode === "race") {
  const [name, count] = args;
  const store = openThreadsStore({ env });
  signal("ready-" + name);
  waitFor("go");
  for (let i = 0; i < Number(count); i++)
    upsertProc(store, "p1", (row) =>
      row
        ? { rss: row.rss + 1 }
        : { cwd: "/w", cmd: "vite", kind: "server", startedAt: "2026-11-13T00:00:00Z", rss: 1 },
    );
  store.close();
} else if (mode === "hold") {
  const store = openThreadsStore({ env });
  store.write((db) => {
    db.run(
      "INSERT INTO procs (id, cwd, cmd, kind, started_at) VALUES ('held', '/w', 'vite', 'server', '2026-11-13T00:00:00Z')",
    );
    signal("holding");
    waitFor("release");
  });
  store.close();
} else if (mode === "warnings") {
  // Node releases before node:sqlite went stable print its ExperimentalWarning
  // when the module loads: make this Node do the same, plus an unrelated one.
  const load = process.getBuiltinModule;
  process.getBuiltinModule = function (id) {
    if (id === "node:sqlite") {
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      process.emitWarning("Another feature is experimental", "ExperimentalWarning");
    }
    return load.call(process, id);
  };
  openThreadsStore({ env }).close();
  process.emitWarning("a later warning", "Warning");
}
`;

type Run = { code: number | null; stdout: string; stderr: string };
type Runtime = "bun" | "node";

let tools: string;
let bunWorker: string;
let nodeWorker: string;
const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: process.env.PATH,
  // The worker's own WORKIT_STATE_DIR argument is the only state it may touch.
  WORKIT_STATE_DIR: path.join(tools, "unused-state"),
});

const run = (command: string, args: string[]): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const worker = (runtime: Runtime, ...args: string[]): Promise<Run> =>
  runtime === "bun"
    ? run(process.execPath, [bunWorker, ...args])
    : run("node", [nodeWorker, ...args]);

const waitForFile = async (file: string): Promise<void> => {
  while (!existsSync(file)) await Bun.sleep(5);
};

const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

beforeAll(async () => {
  tools = tempDir("wk-threads-tools-");
  bunWorker = path.join(tools, "worker.ts");
  writeFileSync(bunWorker, WORKER);
  const built = await Bun.build({
    entrypoints: [bunWorker],
    target: "node",
    format: "esm",
    outdir: path.join(tools, "node"),
  });
  if (!built.success) throw new AggregateError(built.logs, "cannot bundle the worker for node");
  nodeWorker = path.join(tools, "node", "worker.js");
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each(["bun", "node"] as const)(
  "Given no DB, When the store opens on %s, Then threads.db is created mode 0600 at schema v1 under WORKIT_STATE_DIR",
  async (runtime) => {
    const state = path.join(tempDir("wk-threads-"), "nested", "state");
    const opened = await worker(runtime, "open", state);
    expect(opened.stderr).toBe("");
    expect(JSON.parse(opened.stdout)).toEqual({
      file: path.join(state, "threads.db"),
      version: "1",
    });
    const file = path.join(state, "threads.db");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const db = new Database(file, { readonly: true });
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      const columns = db
        .query("SELECT name FROM pragma_table_info('procs') ORDER BY cid")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual([
        "id",
        "session",
        "lead",
        "host",
        "host_pid",
        "repo",
        "cwd",
        "branch",
        "pgid",
        "pid",
        "pid_start",
        "cmd",
        "kind",
        "port",
        "started_at",
        "rss",
        "rss_at",
        "keep",
        "keep_ref",
        "ended_at",
        "end_reason",
      ]);
    } finally {
      db.close();
    }
  },
);

test.each([
  ["node", "node"],
  ["bun", "bun"],
  ["node", "bun"],
] as const)(
  "Given a %s and a %s process upserting the same procs row at once, Then every update lands",
  async (first, second) => {
    const state = tempDir("wk-threads-race-");
    const count = 150;
    const racers = [
      worker(first, "race", state, "a", String(count)),
      worker(second, "race", state, "b", String(count)),
    ];
    await waitForFile(path.join(state, "ready-a"));
    await waitForFile(path.join(state, "ready-b"));
    writeFileSync(path.join(state, "go"), "");
    const results = await Promise.all(racers);
    for (const result of results) expect(result).toMatchObject({ code: 0, stderr: "" });

    const store = openThreadsStore({ env: { WORKIT_STATE_DIR: state } });
    try {
      // A lost read-modify-write would leave fewer than 300.
      expect(readProc(store, "p1")?.rss).toBe(300);
    } finally {
      store.close();
    }
  },
);

test.each(["bun", "node"] as const)(
  "Given a %s process holding the write lock, When another writer outwaits its busy timeout, Then it reports busy and its retry loses no write",
  async (runtime) => {
    const state = tempDir("wk-threads-busy-");
    const env = { WORKIT_STATE_DIR: state };
    openThreadsStore({ env }).close();
    const holder = worker(runtime, "hold", state);
    await waitForFile(path.join(state, "holding"));

    const store = openThreadsStore({ env, busyTimeoutMs: 50 });
    try {
      const add = () =>
        upsertProc(store, "mine", () => ({
          cwd: "/w",
          cmd: "next dev",
          kind: "server",
          startedAt: "2026-11-13T00:00:01Z",
        }));
      let failure: unknown;
      try {
        add();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ThreadsBusyError);
      expect((failure as Error).message).toContain(
        `${path.join(state, "threads.db")} is busy: another Workit process held its write lock`,
      );

      writeFileSync(path.join(state, "release"), "");
      expect(await holder).toMatchObject({ code: 0, stderr: "" });
      add();
      expect(readProc(store, "held")?.cmd).toBe("vite");
      expect(readProc(store, "mine")?.cmd).toBe("next dev");
    } finally {
      store.close();
    }
  },
);

/** A file a newer Workit wrote: schema v2, still in rollback-journal mode. */
const newerDb = (state: string): string => {
  const file = path.join(state, "threads.db");
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("INSERT INTO meta VALUES ('schema_version', '2')");
  db.exec("CREATE TABLE future (id TEXT PRIMARY KEY)");
  db.close();
  return file;
};

const REFUSAL =
  /threads\.db is at schema v2, and this Workit knows only up to v1: it was written by a newer Workit\. Upgrade Workit \(`workit upgrade`\) to open it; nothing was written\./u;

test("Given a DB at schema v2 and this build knowing v1, When it opens in process, Then it refuses naming both versions and the upgrade, and the bytes are unchanged", () => {
  const state = tempDir("wk-threads-v2-");
  const file = newerDb(state);
  const before = sha(file);

  let failure: unknown;
  try {
    openThreadsStore({ env: { WORKIT_STATE_DIR: state } });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ThreadsSchemaError);
  expect((failure as Error).message).toMatch(REFUSAL);
  expect(sha(file)).toBe(before);
  expect(readdirSync(state)).toEqual(["threads.db"]);
});

test.each(["bun", "node"] as const)(
  "Given a DB at schema v2, When a %s process opens it, Then it exits refusing and the bytes are unchanged",
  async (runtime) => {
    const state = tempDir("wk-threads-v2-");
    const file = newerDb(state);
    const before = sha(file);
    const opened = await worker(runtime, "open", state);
    expect(opened.code).toBe(3);
    expect(opened.stderr).toMatch(REFUSAL);
    expect(sha(file)).toBe(before);
  },
);

test("Given node 24, When the store opens, Then SQLite's ExperimentalWarning is not printed and other warnings still are", async () => {
  const state = tempDir("wk-threads-warn-");
  const opened = await worker("node", "warnings", state);
  expect(opened.code).toBe(0);
  expect(opened.stderr).not.toContain("SQLite is an experimental feature");
  expect(opened.stderr).toContain("ExperimentalWarning: Another feature is experimental");
  expect(opened.stderr).toContain("Warning: a later warning");
});

// docs/specs/threads.md#hooks: per-turn hooks stay off SQLite in this wave.
const HOOK_ENTRIES = [
  "packages/workit-claude-code/src/hook.ts",
  "packages/workit-claude-code/src/run.ts",
  "packages/workit-codex/hooks/workit-hook.ts",
  "packages/workit-codex/hooks/launcher.ts",
  "packages/workit-cursor/hooks/workit-hook.ts",
  "packages/workit-cursor/hooks/session-start.ts",
];

test.each(HOOK_ENTRIES)(
  "Given the hook entry %s, When bundled, Then it reaches neither the threads store nor SQLite",
  async (entry) => {
    const out = tempDir("wk-threads-hook-");
    const built = await Bun.build({
      entrypoints: [path.join(ROOT, entry)],
      target: "node",
      outdir: out,
      metafile: true,
    });
    if (!built.success) throw new AggregateError(built.logs, `cannot bundle ${entry}`);
    const inputs = Object.keys(built.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(0);
    expect(
      inputs.filter((input) => input.split(path.sep).join("/").includes("store/threads/")),
    ).toEqual([]);
    const code = built.outputs.map((output) => readFileSync(output.path, "utf8")).join("\n");
    expect(code).not.toMatch(/(?:node|bun):sqlite/u);
  },
);
