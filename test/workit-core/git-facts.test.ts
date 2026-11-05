// git/facts.ts caches the facts that cannot change inside one workit call,
// and git/default-base.ts reads every candidate ref with one git call (#284
// N6). The base decides which commits a verdict and a patch-id are keyed
// against, so the batched lookup must agree with the old one-probe-per-
// candidate algorithm on every ref shape, including the odd ones.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBase } from "@/packages/workit-core/src/git/default-base";
import { forgetGitDirs, gitDirs } from "@/packages/workit-core/src/git/facts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const repo = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-facts-")));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "work");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "f"), "1\n");
  git(dir, "add", "f");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
};

// The algorithm defaultBase replaced, with one real `rev-parse` per probe.
const oldDefaultBase = (cwd: string): string | null => {
  const exists = (ref: string) =>
    spawnSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd }).status === 0;
  const head = spawnSync("git", ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const originHead = head.status === 0 ? head.stdout.trim() : "";
  if (originHead && exists(originHead)) return originHead;
  for (const candidate of [
    "origin/main",
    "origin/master",
    "main",
    "master",
    "origin/develop",
    "develop",
  ])
    if (exists(candidate)) return candidate;
  return null;
};

const shapes: Record<string, (dir: string) => void> = {
  "no candidate at all": () => {},
  "a local master only": (dir) => git(dir, "branch", "master"),
  "local main and master": (dir) => {
    git(dir, "branch", "master");
    git(dir, "branch", "main");
  },
  "origin/HEAD names origin/develop over a local main": (dir) => {
    git(dir, "branch", "main");
    git(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  },
  "origin/HEAD dangling, origin/master present": (dir) => {
    git(dir, "update-ref", "refs/remotes/origin/master", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
  },
  "a tag named main peeling to a commit": (dir) => git(dir, "tag", "-a", "main", "-m", "t"),
  "a tag named main on a tree, not a commit": (dir) =>
    git(dir, "tag", "main", git(dir, "rev-parse", "HEAD^{tree}")),
  "a tag named main on a tree beside a branch main (the tag wins, so main is no base)": (dir) => {
    git(dir, "branch", "main");
    git(dir, "tag", "main", git(dir, "rev-parse", "HEAD^{tree}"));
    git(dir, "branch", "master");
  },
  "a ref naming a missing object (for-each-ref refuses the repo)": (dir) => {
    git(dir, "branch", "main");
    writeFileSync(path.join(dir, ".git", "refs", "heads", "zbroken"), `${"1".repeat(40)}\n`);
  },
  "origin/HEAD on origin/main with a local branch origin/main (git shortens to remotes/origin/main)":
    (dir) => {
      git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      git(dir, "branch", "origin/main");
    },
  "origin/HEAD on origin/main with a tag origin/main": (dir) => {
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(dir, "tag", "origin/main");
  },
  "origin/HEAD pointing at a tag outside refs/remotes": (dir) => {
    git(dir, "tag", "v1");
    git(dir, "branch", "master");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/tags/v1");
  },
  "a ref directly under refs/ (refs/develop) and nothing else": (dir) =>
    git(dir, "update-ref", "refs/develop", "HEAD"),
  "a remote named main/HEAD only (refs/remotes/main/HEAD)": (dir) => {
    git(dir, "update-ref", "refs/remotes/main/x", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/main/HEAD", "refs/remotes/main/x");
  },
};

for (const [shape, build] of Object.entries(shapes))
  test(`Given ${shape}, Then defaultBase picks what the per-candidate probes picked`, () => {
    const dir = repo();
    build(dir);
    expect({ shape, base: defaultBase(dir) }).toEqual({ shape, base: oldDefaultBase(dir) });
  });

test("Given a directory outside any repository, Then defaultBase and gitDirs are null", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-facts-none-")));
  dirs.push(dir);
  expect(defaultBase(dir)).toBeNull();
  expect(gitDirs(dir)).toBeNull();
});

test("Given a checkout, a linked worktree and a bare repository, Then gitDirs matches git's own answers", () => {
  const dir = repo();
  const absolute = (cwd: string, flag: string) =>
    git(cwd, "rev-parse", "--path-format=absolute", flag);
  expect(gitDirs(dir)).toEqual({
    top: absolute(dir, "--show-toplevel"),
    gitDir: absolute(dir, "--git-dir"),
    commonDir: absolute(dir, "--git-common-dir"),
  });
  const linked = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  dirs.push(linked);
  git(dir, "worktree", "add", "-q", "-b", "side", linked);
  const sub = path.join(linked, "sub");
  mkdirSync(sub);
  expect(gitDirs(sub)).toEqual({
    top: absolute(linked, "--show-toplevel"),
    gitDir: absolute(linked, "--git-dir"),
    commonDir: absolute(dir, "--git-common-dir"),
  });
  // worktreeTree reads the index at <git dir>/index: git's own `--git-path index`.
  for (const at of [dir, linked])
    expect(`${gitDirs(at)!.gitDir}/index`).toBe(
      git(at, "rev-parse", "--path-format=absolute", "--git-path", "index"),
    );
  const bare = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-facts-bare-")));
  dirs.push(bare);
  git(bare, "init", "-q", "--bare");
  expect(gitDirs(bare)).toEqual({
    top: null,
    gitDir: absolute(bare, "--git-dir"),
    commonDir: absolute(bare, "--git-common-dir"),
  });
});

test("Given a directory asked once, Then gitDirs answers again without git; once its git dir is gone, it asks again", () => {
  const dir = repo();
  forgetGitDirs();
  const first = gitDirs(dir);
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    // No git on PATH: only the cache can answer.
    expect(gitDirs(dir)).toEqual(first);
  } finally {
    process.env.PATH = saved;
  }
  rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  expect(gitDirs(dir)).toBeNull();
});

test("Given a linked worktree removed and re-added at the same path while its old admin dir name went to another worktree, Then gitDirs reads the new one", () => {
  const dir = repo();
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-facts-wt-")));
  dirs.push(parent);
  const at = (name: string) => path.join(parent, name, "wt");
  for (const name of ["a", "b", "c"]) mkdirSync(path.join(parent, name));
  git(dir, "worktree", "add", "-q", "--detach", at("a"));
  git(dir, "worktree", "add", "-q", "--detach", at("b"));
  forgetGitDirs();
  const before = gitDirs(at("a"));
  git(dir, "worktree", "remove", "--force", at("a"));
  git(dir, "worktree", "add", "-q", "--detach", at("c")); // takes a's old admin dir name
  git(dir, "worktree", "add", "-q", "--detach", at("a"));
  const truth = git(at("a"), "rev-parse", "--path-format=absolute", "--git-dir");
  expect(truth).not.toBe(before?.gitDir);
  expect(gitDirs(at("a"))?.gitDir).toBe(truth);
});

test("Given a linked worktree whose directory was deleted and recreated empty, Then gitDirs is null again", () => {
  const dir = repo();
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-gone`);
  dirs.push(wt);
  git(dir, "worktree", "add", "-q", "--detach", wt);
  forgetGitDirs();
  expect(gitDirs(wt)?.top).toBe(git(wt, "rev-parse", "--show-toplevel"));
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(wt);
  expect(gitDirs(wt)).toBeNull();
});

test("Given a directory that becomes a repository later, Then gitDirs finds it (a miss is never cached)", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-facts-later-")));
  dirs.push(dir);
  expect(gitDirs(dir)).toBeNull();
  git(dir, "init", "-q");
  expect(gitDirs(dir)?.top).toBe(git(dir, "rev-parse", "--show-toplevel"));
});
