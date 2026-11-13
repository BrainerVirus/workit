import "@/test/shared/state-isolation";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BranchForge } from "@/packages/workit-core/src/core/cleanup";
import { readLedger } from "@/packages/workit-core/src/ledger";
import type { Io } from "@/packages/workit-cli/src/output";
import { gcDeps, run as gc } from "@/packages/workit-cli/src/verbs/gc";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { spawnHeavyTimeout } from "@/test/shared/timeouts";

// #835: `workit gc --branches [--apply]` lists (and deletes) local branches
// whose work is on the trunk. Every gc form refuses an argument it does not
// know with exit 2, so no caller falls through to the task-store gc. The verb
// is called directly, so the test reaches gc's own argument check (`main`'s
// help parser refuses an option missing from the usage line before it).

setDefaultTimeout(spawnHeavyTimeout());

let home: ConfigHome;
const original = { ...gcDeps };
beforeAll(() => {
  home = useConfigHome("wk-gcbr-cli-config-");
});
afterAll(() => home.restore());

const roots: string[] = [];
afterEach(() => {
  Object.assign(gcDeps, original);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, file: string) => {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `add ${file}`);
};

/**
 * <root>/proj on main; feature/s (two commits) squash-merged onto main;
 * feature/u with a commit main never got. Both were committed on, so
 * neither is fresh.
 */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-gcbr-cli-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  commit(main, "a.txt");
  git(main, "switch", "-q", "-c", "feature/s");
  commit(main, "s1.txt");
  commit(main, "s2.txt");
  const tip = git(main, "rev-parse", "HEAD");
  git(main, "switch", "-q", "-c", "feature/u", "main");
  commit(main, "u.txt");
  git(main, "switch", "-q", "main");
  git(main, "merge", "-q", "--squash", "feature/s");
  git(main, "commit", "-q", "-m", "squash feature/s (#12)");
  return { root, main, tip };
};

const fakeForge = (tip: string): BranchForge => ({
  headRepo: "o/r",
  headProjectId: null,
  forge: {
    findPr: (head) => ({
      ok: true,
      data:
        head === "feature/s"
          ? { number: 12, url: "", state: "merged", headBranch: head, headSha: tip }
          : null,
    }),
    prMeta: (n) => ({
      ok: true,
      data: {
        number: n,
        url: "",
        state: "merged",
        draft: false,
        title: "t",
        base: "main",
        headBranch: "feature/s",
        author: null,
        fork: false,
      },
    }),
  },
});

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  const io: Io = {
    cwd,
    json: argv.includes("--json"),
    env: { ...process.env, WORKIT_SESSION_ID: "lead-gc" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await gc(argv.slice(1), io);
  return { code, stdout };
};

const branches = (main: string) =>
  git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").toSorted();

test("Given a branch squash-merged by a PR at its tip (fake forge), When gc --branches runs, Then it is listed would delete … merged PR #12 and nothing changes", async () => {
  const env = setup();
  gcDeps.forge = () => fakeForge(env.tip);
  const result = await run(["gc", "--branches"], env.main);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("dry run");
  expect(result.stdout).toContain("would delete branch feature/s: merged PR #12");
  expect(result.stdout).toContain(
    "kept branch feature/u: 1 commit not on refs/heads/main by patch id",
  );
  expect(result.stdout).not.toContain("skipped");
  expect(branches(env.main)).toEqual(["feature/s", "feature/u", "main"]);
});

test("gc --branches --apply deletes the proven branch, keeps the unmerged one, and records one cleanup.removed row", async () => {
  const env = setup();
  gcDeps.forge = () => fakeForge(env.tip);
  const result = await run(["gc", "--branches", "--apply", "--json"], env.main);
  expect(result.code, result.stdout).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.deleted).toEqual(["feature/s"]);
  expect(data.kept).toEqual([
    { name: "feature/u", reason: "1 commit not on refs/heads/main by patch id" },
  ]);
  expect(branches(env.main)).toEqual(["feature/u", "main"]);
  const ledger = readLedger(env.main);
  if (!ledger.ok) throw new Error(ledger.error);
  const rows = ledger.value.rows.filter((row) => row.type === "cleanup.removed");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ trigger: "gc --branches", branches: ["feature/s"] });
});

test("Given no forge access (no push remote), Then the output says the merged-PR check was skipped and only git proofs apply", async () => {
  const env = setup();
  const result = await run(["gc", "--branches"], env.main);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("merged-PR check skipped:");
  expect(result.stdout).toContain("would delete branch feature/s: squash-merged");
  expect(result.stdout).toContain("kept branch feature/u");
});

const REFUSED = [
  { form: "the task-store gc", argv: ["gc", "--procs", "--apply", "--quiet"], named: "--procs" },
  { form: "the task-store gc", argv: ["gc", "--dry-run", "--force"], named: "--force" },
  { form: "--worktrees", argv: ["gc", "--worktrees", "--apply", "--quiet"], named: "--quiet" },
  { form: "--branches", argv: ["gc", "--branches", "--apply", "--quiet"], named: "--quiet" },
  { form: "--branches", argv: ["gc", "--branches", "--procs"], named: "--procs" },
] as const;

for (const item of REFUSED)
  test(`Given \`workit ${item.argv.join(" ")}\` (${item.form}), Then it exits 2 naming ${item.named} and changes nothing`, async () => {
    const env = setup();
    gcDeps.forge = () => fakeForge(env.tip);
    const before = branches(env.main);
    const result = await run([...item.argv, "--json"], env.main);
    expect(result.code, result.stdout).toBe(2);
    expect(JSON.parse(result.stdout).error).toContain(`unknown argument ${item.named}`);
    expect(branches(env.main)).toEqual(before);
  });

test("gc --worktrees --branches together exits 2", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees", "--branches"], env.main);
  expect(result.code).toBe(2);
  expect(branches(env.main)).toEqual(["feature/s", "feature/u", "main"]);
});
