// #329 part 1: the per-user threads store (docs/specs/threads.md). Real
// processes on both runtimes: Bun runs the store's source, Node runs it
// bundled for Node the way the CLI ships (`bun build --target node`).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProc, upsertProc } from "@/packages/workit-core/src/store/threads/procs";
import {
  openThreadsStore,
  ThreadsBusyError,
  ThreadsSchemaError,
  ThreadsUnsafeError,
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

if (mode === "open" || mode === "open-as") {
  // open-as: this process claims another uid, as if the file were someone else's.
  if (mode === "open-as") process.getuid = () => Number(args[0]);
  try {
    const store = openThreadsStore({ env });
    const row = store.db.get("SELECT value FROM meta WHERE key = 'schema_version'");
    console.log(JSON.stringify({ file: store.file, version: row.value }));
    store.close();
  } catch (error) {
    console.error(error.name + ": " + error.message);
    process.exitCode = 3;
  }
} else if (mode === "open-together") {
  signal("waiting-" + args[0]);
  waitFor("go");
  openThreadsStore({ env }).close();
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

/** Waits for `file`; fails naming the worker's output when it exits first (a hang otherwise). */
const waitForFile = async (file: string, child: Promise<Run>): Promise<void> => {
  let exited: Run | undefined;
  void child.then(
    (result) => (exited = result),
    (error: unknown) => (exited = { code: null, stdout: "", stderr: String(error) }),
  );
  while (!existsSync(file)) {
    if (exited)
      throw new Error(
        `the worker exited (code ${exited.code}) before writing ${path.basename(file)}: ${exited.stderr}`,
      );
    await Bun.sleep(5);
  }
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

    // Read-write: after the node child's last close, SQLite has removed the
    // -wal and -shm files, and macOS's system SQLite (Bun's there) cannot open
    // such a WAL file read-only ("unable to open database file").
    const db = new Database(file);
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
    await waitForFile(path.join(state, "ready-a"), racers[0]);
    await waitForFile(path.join(state, "ready-b"), racers[1]);
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
    await waitForFile(path.join(state, "holding"), holder);

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
  // A newer Workit makes its file private too.
  chmodSync(file, 0o600);
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

// Opening an existing threads.db: the store decides which processes the
// registry signals, so it never follows, repairs or reuses an unsafe file.
type UnsafeCase = {
  name: string;
  /** Builds the unsafe layout; returns what the refusal must say and the uid the opener claims. */
  setup: (state: string) => { message: (file: string) => string; claimUid?: number };
  /** What must still hold after the refusal. */
  after: (state: string) => void;
};

const fixAside = (file: string) => `move it aside (\`mv ${file} ${file}.unsafe\`)`;
const refusal = (file: string, detail: string, fix: string) =>
  `ThreadsUnsafeError: ${file} is not safe to open: ${detail}. Fix: ${fix}. Nothing was opened.`;
const linkRefusal = (file: string) =>
  refusal(
    file,
    "it is a symbolic link, which Workit never follows",
    `remove the link (\`rm ${file}\`); Workit then creates its own file`,
  );
const modeOf = (file: string) => statSync(file).mode & 0o777;
const dbIn = (state: string) => path.join(state, "threads.db");
const elsewhere = () => tempDir("wk-threads-elsewhere-");
const GARBAGE = "this is not a sqlite file\n".repeat(20);

// Windows has no POSIX mode or uid, and making a symbolic link there needs a
// privilege CI does not hold: those cases run on Linux and macOS only.
const POSIX_CASES: UnsafeCase[] = [
  {
    name: "a symbolic link to another file",
    setup: (state) => {
      const target = path.join(elsewhere(), "target.db");
      writeFileSync(target, "kept");
      symlinkSync(target, dbIn(state));
      writeFileSync(path.join(state, "target-path"), target);
      return { message: linkRefusal };
    },
    after: (state) =>
      expect(readFileSync(readFileSync(path.join(state, "target-path"), "utf8"), "utf8")).toBe(
        "kept",
      ),
  },
  {
    name: "a dangling symbolic link",
    setup: (state) => {
      const target = path.join(elsewhere(), "never.db");
      symlinkSync(target, dbIn(state));
      writeFileSync(path.join(state, "target-path"), target);
      return { message: linkRefusal };
    },
    after: (state) =>
      expect(existsSync(readFileSync(path.join(state, "target-path"), "utf8"))).toBe(false),
  },
  {
    name: "a file with mode 0666",
    setup: (state) => {
      writeFileSync(dbIn(state), "");
      chmodSync(dbIn(state), 0o666);
      return {
        message: (file) =>
          refusal(file, "its mode is 0666, open to group or other", `\`chmod 600 ${file}\``),
      };
    },
    after: (state) => expect(modeOf(dbIn(state))).toBe(0o666),
  },
  {
    name: "another user's file",
    setup: (state) => {
      writeFileSync(dbIn(state), "", { mode: 0o600 });
      return {
        claimUid: 4242,
        message: (file) =>
          refusal(
            file,
            `it is owned by uid ${os.userInfo().uid}, not by this user (uid 4242)`,
            fixAside(file),
          ),
      };
    },
    after: (state) => expect(readFileSync(dbIn(state), "utf8")).toBe(""),
  },
  {
    name: "a -wal file with mode 0666",
    setup: (state) => {
      openThreadsStore({ env: { WORKIT_STATE_DIR: state } }).close();
      writeFileSync(`${dbIn(state)}-wal`, "");
      chmodSync(`${dbIn(state)}-wal`, 0o666);
      return {
        message: (file) =>
          refusal(
            `${file}-wal`,
            "its mode is 0666, open to group or other",
            `\`chmod 600 ${file}-wal\``,
          ),
      };
    },
    after: (state) => expect(modeOf(`${dbIn(state)}-wal`)).toBe(0o666),
  },
  {
    name: "a -shm symbolic link",
    setup: (state) => {
      openThreadsStore({ env: { WORKIT_STATE_DIR: state } }).close();
      // Bun keeps the -shm after close: put the link in its place.
      rmSync(`${dbIn(state)}-shm`, { force: true });
      const target = path.join(elsewhere(), "never.shm");
      symlinkSync(target, `${dbIn(state)}-shm`);
      writeFileSync(path.join(state, "target-path"), target);
      return { message: (file) => linkRefusal(`${file}-shm`) };
    },
    after: (state) =>
      expect(existsSync(readFileSync(path.join(state, "target-path"), "utf8"))).toBe(false),
  },
];

const EVERY_OS_CASES: UnsafeCase[] = [
  {
    name: "a directory",
    setup: (state) => {
      mkdirSync(dbIn(state));
      return {
        message: (file) => refusal(file, "it is not a regular file", fixAside(file)),
      };
    },
    after: (state) => expect(readdirSync(dbIn(state))).toEqual([]),
  },
  {
    name: "a file that is not a database",
    setup: (state) => {
      writeFileSync(dbIn(state), GARBAGE, { mode: 0o600 });
      return {
        message: (file) =>
          refusal(
            file,
            "it is not a SQLite database, or it is damaged",
            `${fixAside(file)}; Workit then creates a new one`,
          ),
      };
    },
    after: (state) => expect(readFileSync(dbIn(state), "utf8")).toBe(GARBAGE),
  },
];

const unsafeRuns = (cases: UnsafeCase[]) =>
  cases.flatMap((unsafe) =>
    (["bun", "node"] as const).map((runtime) => [unsafe.name, runtime, unsafe] as const),
  );

const refuses = async (runtime: Runtime, unsafe: UnsafeCase) => {
  const state = tempDir("wk-threads-unsafe-");
  const { message, claimUid } = unsafe.setup(state);
  const opened =
    claimUid === undefined
      ? await worker(runtime, "open", state)
      : await worker(runtime, "open-as", state, String(claimUid));
  expect(opened.code).toBe(3);
  expect(opened.stderr.trim()).toBe(message(dbIn(state)));
  unsafe.after(state);
};

test.skipIf(process.platform === "win32").each(unsafeRuns(POSIX_CASES))(
  "Given %s at threads.db, When a %s process opens the store, Then it refuses with ThreadsUnsafeError and changes nothing",
  async (_name, runtime, unsafe) => refuses(runtime, unsafe),
);

test.each(unsafeRuns(EVERY_OS_CASES))(
  "Given %s at threads.db, When a %s process opens the store, Then it refuses with ThreadsUnsafeError and changes nothing",
  async (_name, runtime, unsafe) => refuses(runtime, unsafe),
);

test("Given an unsafe threads.db, When opened in process, Then the error is a ThreadsUnsafeError carrying the path and reason", () => {
  const state = tempDir("wk-threads-unsafe-");
  mkdirSync(dbIn(state));
  let failure: unknown;
  try {
    openThreadsStore({ env: { WORKIT_STATE_DIR: state } });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ThreadsUnsafeError);
  expect(failure).toMatchObject({ file: dbIn(state), reason: "not-file" });
});

test.each(["node", "bun"] as const)(
  "Given no DB, When two %s processes open it at the same moment, Then both open it at v1 in WAL",
  async (runtime) => {
    // Switching a fresh file to WAL fails at once while another process has
    // it open; before the retry, about half of these rounds lost one opener.
    for (let round = 0; round < 6; round++) {
      const state = tempDir("wk-threads-open-");
      const openers = [
        worker(runtime, "open-together", state, "a"),
        worker(runtime, "open-together", state, "b"),
      ];
      await waitForFile(path.join(state, "waiting-a"), openers[0]);
      await waitForFile(path.join(state, "waiting-b"), openers[1]);
      writeFileSync(path.join(state, "go"), "");
      for (const opened of await Promise.all(openers))
        expect(opened).toMatchObject({ code: 0, stderr: "" });
      const db = new Database(dbIn(state));
      try {
        expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
          value: "1",
        });
      } finally {
        db.close();
      }
    }
  },
);

// Only threads.db itself must not be a link: macOS's temp dirs sit under
// /var, itself a link to /private/var.
test.skipIf(process.platform === "win32").each(["bun", "node"] as const)(
  "Given a state dir reached through a symbolic link, When a %s process opens the store, Then it opens",
  async (runtime) => {
    const linked = path.join(tempDir("wk-threads-via-"), "state");
    symlinkSync(tempDir("wk-threads-real-"), linked);
    const opened = await worker(runtime, "open", linked);
    expect(opened.stderr).toBe("");
    expect(JSON.parse(opened.stdout)).toEqual({
      file: path.join(linked, "threads.db"),
      version: "1",
    });
  },
);
