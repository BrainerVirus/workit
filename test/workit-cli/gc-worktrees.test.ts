import "@/test/shared/state-isolation";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as workit } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { run as gc } from "@/packages/workit-cli/src/verbs/gc";
import { samePath } from "@/test/helpers/same-path";
import { useConfigHome } from "../shared/grant-home";

// #653: `workit gc --worktrees` lists what finished changes left on disk (a
// dry run by default) and removes it with --apply. The verb is called
// directly: the registry's gc usage line (out of this change's scope) does not
// list --worktrees/--apply yet, so `main` would refuse them.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** <root>/proj on main, a merged worktree at <root>/proj-wt/a and an unmerged one at <root>/proj-wt/b. */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-gcwt-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(path.join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  const merged = path.join(root, "proj-wt", "a");
  const unmerged = path.join(root, "proj-wt", "b");
  git(main, "worktree", "add", "-q", "-b", "feature/a", merged, "main");
  git(main, "worktree", "add", "-q", "-b", "feature/b", unmerged, "main");
  writeFileSync(path.join(merged, "a2.txt"), "a2\n");
  git(merged, "add", "-A");
  git(merged, "commit", "-q", "-m", "merged a");
  git(main, "merge", "-q", "--ff-only", "feature/a");
  writeFileSync(path.join(unmerged, "b.txt"), "b\n");
  git(unmerged, "add", "-A");
  git(unmerged, "commit", "-q", "-m", "unmerged b");
  return { root, main, merged, unmerged };
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  const io: Io = {
    cwd,
    json: argv.includes("--json"),
    env: { ...process.env, XDG_CACHE_HOME: path.join(cwd, "..", "cache") },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await gc(argv.slice(1), io);
  return { code, stdout };
};

test("gc --worktrees is a dry run: it lists the merged worktree with its size and keeps the unmerged one", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees"], env.main);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("dry run");
  // Paths print as git gives them (`/`, long names), so match on their tails.
  expect(result.stdout).toMatch(
    /would remove \S+[/\\]proj-wt[/\\]a \[feature\/a\]: merged, \d+\.\d MB/u,
  );
  expect(result.stdout).toMatch(/kept \S+[/\\]proj-wt[/\\]b \[feature\/b\]: not merged into/u);
  expect(result.stdout).not.toMatch(/would remove \S+[/\\]proj-wt[/\\]b/u);
  expect(existsSync(env.merged)).toBe(true);
});

test("gc --worktrees --apply removes the merged worktree, its branch and nothing unmerged", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees", "--apply", "--json"], env.main);
  expect(result.code, result.stdout).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.removed).toHaveLength(1);
  expect(samePath(data.removed[0], env.merged)).toBe(true);
  expect(data.deletedBranches).toEqual(["feature/a"]);
  expect(existsSync(env.merged)).toBe(false);
  expect(existsSync(env.unmerged)).toBe(true);
  expect(git(env.main, "branch", "--list", "feature/b")).not.toBe("");
});

test("gc --worktrees refuses an unknown argument", async () => {
  const env = setup();
  const result = await run(["gc", "--worktrees", "--force"], env.main);
  expect(result.code).toBe(2);
  expect(existsSync(env.merged)).toBe(true);
});

/** `workit <argv> --json` in-process as the lead; its data. */
const lead = async (cwd: string, argv: string[]) => {
  let stdout = "";
  const code = await workit([...argv, "--json"], {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "lead-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  });
  if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
  return JSON.parse(stdout).data;
};

test("gc --worktrees --apply removes a merged fanout worktree with its out-of-tree worker scratch, never following a symlink put in a scratch's place, and an in-tree judge .workit-scratch goes with the worktree", async () => {
  const home = useConfigHome("wk-gcwt-config-");
  try {
    const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-gcwt-")));
    roots.push(root);
    const main = path.join(root, "gcscratch");
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    git(main, "config", "user.email", "t@t");
    git(main, "config", "user.name", "t");
    git(main, "config", "commit.gpgsign", "false");
    git(main, "config", "core.hooksPath", path.join(root, "no-hooks"));
    writeFileSync(path.join(main, "a.txt"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "base");
    const slice = (id: string) => ({
      id,
      branch: `feature/${id}`,
      tier: "standard",
      reason: "parallel",
      scope: [`${id}.ts`],
      goal: `ship ${id}`,
      acceptance: [`Given the app, When ${id} runs, Then it works`],
      verify: ["workit check test"],
      forbidden: ["no edits outside SCOPE"],
    });
    const planFile = path.join(root, "plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({ name: "gc", trunk: "main", slices: [slice("a"), slice("b")] }),
    );
    await lead(main, ["fanout", "plan", planFile]);
    const made = [
      await lead(main, ["fanout", "worktree", "create", "a"]),
      await lead(main, ["fanout", "worktree", "create", "b"]),
    ];
    for (const { path: wt, scratch, slice: id } of made) {
      expect(path.relative(wt, scratch).startsWith("..")).toBe(true);
      writeFileSync(path.join(scratch, "draft.md"), "draft\n");
      writeFileSync(path.join(wt, `${id}.ts`), `export const ${id} = 1;\n`);
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", `feat: ${id}`);
      git(main, "merge", "-q", "--no-edit", `feature/${id}`);
      // A judge's probes in the candidate worktree, hidden through info/exclude.
      mkdirSync(path.join(wt, ".workit-scratch"));
      writeFileSync(path.join(wt, ".workit-scratch", "probe.txt"), "probe\n");
    }
    const [a, b] = made;
    // A race attempt at slice a ran in a's worktree with its own scratch.
    const attempt = `${a.scratch}+try1`;
    mkdirSync(attempt);
    writeFileSync(path.join(attempt, "draft.md"), "try 1\n");
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    rmSync(b.scratch, { recursive: true });
    symlinkSync(outside, b.scratch, "junction");

    const result = await run(["gc", "--worktrees", "--apply", "--json"], main);
    expect(result.code, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.removed).toHaveLength(2);
    expect(data.removedScratch).toEqual([a.scratch, attempt]);
    expect(existsSync(attempt)).toBe(false);
    for (const wt of [a.path, b.path]) expect(existsSync(wt)).toBe(false);
    expect(existsSync(a.scratch)).toBe(false);
    expect(lstatSync(b.scratch).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    const human = await run(["gc", "--worktrees", "--apply"], main);
    expect(human.stdout).toContain("nothing to remove");
    rmSync(b.scratch);
  } finally {
    home.restore();
  }
});
