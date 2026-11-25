// Outside every git repository Workit keeps a folder's state in the state dir,
// keyed by the folder, never in `<folder>/.workit` (#892); an older one there
// moves once, and `workit doctor` names any still in the cwd or its parents.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { main } from "@/packages/workit-cli/src/main";
import { folderStoreDir, stateDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { recordDecision } from "@/packages/workit-core/src/ledger";
import {
  MOVED_POINTER,
  TEST_RUN_REFUSALS,
  folderStoreIo,
  migrateFolderStore,
  testRunFolderRefusal,
} from "@/packages/workit-core/src/store/folder-store";
import { resolveStore } from "@/packages/workit-core/src/store/paths";

// The doctor run spawns many probes; a loaded machine needs the room.
setDefaultTimeout(120_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-outside-repo-")));
  dirs.push(dir);
  return dir;
};

const cli = async (cwd: string, argv: string[]) => {
  let stdout = "";
  const notes: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    notes.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv, {
      cwd,
      env: { ...process.env, WORKIT_WORKSPACE_ROOT: "" },
      stdout: (text) => void (stdout += text),
      stderr: () => {},
    });
    return { code, stdout, notes: notes.join("") };
  } finally {
    spy.mockRestore();
  }
};

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A `.workit` as an older Workit left it in a non-git folder. */
const oldStore = (folder: string) => {
  const workit = path.join(folder, ".workit");
  write(path.join(workit, "store.json"), '{"format":"workit-store","version":1}\n');
  write(path.join(workit, "ledger", "ledger.jsonl"), '{"type":"decision","what":"old"}\n');
  write(path.join(workit, "checkouts", "x-1", "workspace.json"), '{"id":"w"}\n');
  write(path.join(workit, "keys", "k.lock"), "");
  write(path.join(workit, "hooks", "seen.json"), "{}\n");
  write(path.join(workit, "retros", "r1.md"), "# retro\n");
  write(path.join(workit, ".gitignore"), "*\n");
  write(
    path.join(workit, "workspace.json"),
    JSON.stringify({ store: { format: "workit-store" }, critical: ["store"] }),
  );
  write(path.join(workit, "checks.json"), '{"checks":{"test":"true"}}\n');
  return workit;
};

test("Given a non-git folder, When `workit dir retros` runs and a decision is recorded, Then both resolve under the state dir keyed by the folder and the folder gets no .workit", async () => {
  const folder = tempDir();
  const store = folderStoreDir(folder);
  expect(store).toStartWith(path.join(stateDir(process.env), "folders"));
  const result = await cli(folder, ["dir", "retros"]);
  expect(result).toMatchObject({ code: 0, stdout: `${path.join(store, "retros")}\n` });
  expect(existsSync(path.join(store, "retros"))).toBe(true);
  const recorded = recordDecision(
    { cwd: folder, actor: { host: "cli", session: null, agentId: null } },
    { what: "keep it out of the folder", why: "#892" },
  );
  expect(recorded.ok).toBe(true);
  expect(readFileSync(path.join(store, "ledger", "ledger.jsonl"), "utf8")).toContain(
    "keep it out of the folder",
  );
  expect(existsSync(path.join(folder, ".workit"))).toBe(false);
  // The same folder by another spelling keys to the same store.
  const link = path.join(tempDir(), "link");
  spawnSync("ln", ["-s", folder, link]);
  if (existsSync(link)) expect(folderStoreDir(link)).toBe(store);
});

test("Given an older <folder>/.workit store outside git, When Workit runs there twice, Then it moves once with a note naming both paths, keeps the folder's config and loses nothing", async () => {
  const folder = tempDir();
  const workit = oldStore(folder);
  const store = folderStoreDir(folder);
  const first = await cli(folder, ["dir", "retros"]);
  expect(first.code).toBe(0);
  expect(first.notes).toContain(`workit: moved ${workit} to ${store}`);
  expect(first.notes.trim().split("\n")).toHaveLength(1);
  // Moved: every state entry, byte for byte.
  expect(readFileSync(path.join(store, "ledger", "ledger.jsonl"), "utf8")).toContain('"old"');
  expect(readFileSync(path.join(store, "retros", "r1.md"), "utf8")).toBe("# retro\n");
  for (const entry of ["store.json", "checkouts/x-1/workspace.json", "keys/k.lock", "hooks"])
    expect(existsSync(path.join(store, entry)), entry).toBe(true);
  // Kept: the folder's own config, and nothing else.
  expect(readdirSync(workit)).toEqual(["checks.json"]);
  const second = await cli(folder, ["dir", "retros"]);
  expect(second.code).toBe(0);
  expect(second.notes).not.toContain("workit: moved");
});

test("Given an older <folder>/.workit and a store that already has some of its files, When Workit runs, Then nothing is replaced, the rest moves and a pointer names the store", async () => {
  const folder = tempDir();
  const workit = oldStore(folder);
  const store = folderStoreDir(folder);
  write(path.join(store, "ledger", "ledger.jsonl"), '{"type":"decision","what":"new"}\n');
  const result = await cli(folder, ["dir", "notes"]);
  expect(result.code).toBe(0);
  expect(result.notes).toContain(`see ${path.join(workit, MOVED_POINTER)}`);
  expect(readFileSync(path.join(store, "ledger", "ledger.jsonl"), "utf8")).toContain('"new"');
  expect(readFileSync(path.join(workit, "ledger", "ledger.jsonl"), "utf8")).toContain('"old"');
  expect(readFileSync(path.join(workit, MOVED_POINTER), "utf8")).toContain(store);
  expect(existsSync(path.join(store, "retros", "r1.md"))).toBe(true);
  expect(existsSync(path.join(workit, "retros"))).toBe(false);
  // A rerun leaves it as it is, without another note.
  expect((await cli(folder, ["dir", "notes"])).notes).not.toContain("workit: moved");
});

const doctorRow = (cwd: string) => {
  const home = tempDir();
  return runDoctor({
    host: "cli",
    home,
    cwd,
    configDir: path.join(home, "config"),
    stateDir: path.join(home, "state"),
    dev: path.join(home, "no-dev"),
    env: { HOME: home, PATH: path.join(home, "empty-bin") },
  }).checks.find((check) => check.id === "stray_workit")!;
};

test("Given a stray .workit in a parent folder outside git, When doctor runs below it, Then stray_workit lists it with the command that moves it; a repo's .workit is not listed", () => {
  const parent = tempDir();
  const workit = oldStore(parent);
  const child = path.join(parent, "child");
  mkdirSync(child);
  const found = doctorRow(child);
  expect(found.status).toBe("warn");
  expect(found.detail).toContain(workit);
  expect(found.detail).toContain(folderStoreDir(parent));
  expect(found.fix).toContain(`workit --cwd ${parent} dir notes`);

  const repo = tempDir();
  spawnSync("git", ["init", "-q"], { cwd: repo });
  write(path.join(repo, ".workit", "plan.md"), "# plan\n");
  // (Only the folder's own row: a stray in a shared temp parent may be listed too.)
  expect(doctorRow(repo).detail).not.toContain(path.join(repo, ".workit"));
  // Team config alone is not state.
  const config = tempDir();
  write(path.join(config, ".workit", "checks.json"), "{}\n");
  expect(doctorRow(config).detail).not.toContain(path.join(config, ".workit"));
});

test("Given a test run, When a .workit would move from the temp dir itself, a parent of it, or a folder outside it, Then it fails loudly instead of moving anything", () => {
  const tmp = tempDir();
  const own = path.join(tmp, "own");
  mkdirSync(own);
  const env = { WORKIT_TEST_RUN: "1" };
  // A test's own dir inside the temp root: allowed.
  expect(testRunFolderRefusal(own, true, env, tmp)).toBeNull();
  // The temp root itself, a parent of it, or a folder outside it: refused once there is a .workit to move.
  for (const folder of [tmp, path.dirname(tmp), tempDir()]) {
    expect(testRunFolderRefusal(folder, false, env, tmp)).toBeNull();
    expect(testRunFolderRefusal(folder, true, env, tmp)).toContain("refusing to move");
  }
  // Outside a test run nothing is refused.
  expect(testRunFolderRefusal(tmp, true, {}, tmp)).toBeNull();

  // Through resolveStore: a stray .workit in what the run calls its temp root stays put.
  const root = tempDir();
  const workit = oldStore(root);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    expect(os.tmpdir()).toBe(root);
    expect(() => resolveStore(root)).toThrow("refusing to move");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  expect(readFileSync(path.join(workit, "ledger", "ledger.jsonl"), "utf8")).toContain('"old"');
  expect(existsSync(folderStoreDir(root))).toBe(false);
  // Recorded for the preload, which fails the test that tripped it (hooks fail open);
  // taken back here, since this test tripped it on purpose.
  const recorded = path.join(process.env.WORKIT_TEST_RUN!, TEST_RUN_REFUSALS);
  expect(readFileSync(recorded, "utf8")).toContain(
    `refusing to move ${path.join(root, ".workit")}`,
  );
  rmSync(recorded);
});

/** Every file under `dir`, relative path to bytes. */
const snapshot = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(dir, file)] = readFileSync(file, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
};

test("Given a move that falls back to copying and fails midway, Then no final path holds a truncated file, temps are gone, and a rerun finishes with nothing kept", () => {
  const folder = tempDir();
  const workit = oldStore(folder);
  for (let index = 0; index < 6; index += 1)
    write(path.join(workit, "retros", `r${index}.md`), `# retro ${index}\n${"x".repeat(4096)}\n`);
  const before = snapshot(workit);
  const target = folderStoreDir(folder);
  const real = { ...folderStoreIo };
  let copies = 0;
  // Renames out of .workit fail (another device); the third file copy writes half and dies.
  folderStoreIo.rename = (from, to) => {
    if (from.startsWith(workit)) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
    real.rename(from, to);
  };
  folderStoreIo.copyFile = (from, to) => {
    copies += 1;
    if (copies === 3) {
      const bytes = readFileSync(from);
      writeFileSync(to, bytes.subarray(0, Math.floor(bytes.length / 2)));
      throw new Error("disk gone");
    }
    real.copyFile(from, to);
  };
  let first;
  try {
    first = migrateFolderStore(folder, target, () => {});
  } finally {
    Object.assign(folderStoreIo, real);
  }
  expect(first?.kept.length).toBeGreaterThan(0);
  const copied = snapshot(target);
  expect(Object.keys(copied).filter((rel) => rel.includes(".workit-move-"))).toEqual([]);
  // Every file at a final path is whole, and whatever did not land is still at the source.
  for (const [rel, text] of Object.entries(copied)) expect(text, rel).toBe(before[rel]);
  for (const rel of Object.keys(before))
    if (!["workspace.json", ".gitignore"].includes(rel))
      expect(copied[rel] ?? snapshot(workit)[rel], rel).toBe(before[rel]);

  const second = migrateFolderStore(folder, target, () => {});
  expect(second?.kept).toEqual([]);
  expect(readdirSync(workit)).toEqual(["checks.json"]);
  const after = snapshot(target);
  for (const [rel, text] of Object.entries(before))
    if (!["workspace.json", ".gitignore", "checks.json"].includes(rel))
      expect(after[rel], rel).toBe(text);
  expect(existsSync(`${target}.lock`)).toBe(false);
});

test("Given two processes resolving the same folder at once, Then one moves it, the other skips or finds it done, and nothing is kept and no pointer appears", async () => {
  const folder = tempDir();
  const workit = oldStore(folder);
  for (let index = 0; index < 1500; index += 1)
    write(path.join(workit, "retros", `r${index}.md`), `# retro ${index}\n`);
  const before = snapshot(workit);
  // The store already has a retros dir, so both movers go file by file.
  write(path.join(folderStoreDir(folder), "retros", "kept-there.md"), "# already there\n");
  const go = path.join(tempDir(), "go");
  const script = path.join(tempDir(), "resolve.ts");
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
import { resolveStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../../packages/workit-core/src/store/paths.ts"))};
const [folder, go] = process.argv.slice(2);
while (!existsSync(go)) {}
const found = resolveStore(folder);
if (found instanceof Error) throw found;
`,
  );
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, script, folder, go], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  await Bun.sleep(300);
  writeFileSync(go, "");
  const codes = await Promise.all(children.map((child) => child.exited));
  expect(codes).toEqual([0, 0]);
  const target = folderStoreDir(folder);
  expect(readdirSync(workit)).toEqual(["checks.json"]);
  expect(existsSync(path.join(workit, MOVED_POINTER))).toBe(false);
  const after = snapshot(target);
  for (const [rel, text] of Object.entries(before))
    if (!["workspace.json", ".gitignore", "checks.json"].includes(rel))
      expect(after[rel], rel).toBe(text);
  expect(existsSync(`${target}.lock`)).toBe(false);
});
