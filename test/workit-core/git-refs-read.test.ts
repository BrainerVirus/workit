// git/refs-read.ts answers HEAD and branch tips from the git files instead of
// spawning git (#284 N6). A wrong answer would mis-key a SHA-keyed verdict, so
// every read must equal git's own answer or be null (ask git), on every
// layout. Real git is the oracle throughout: each case compares the file read
// with `git rev-parse --verify -q HEAD^{commit}`, `git symbolic-ref --short -q
// HEAD` and `git rev-parse --verify -q refs/heads/<b>^{commit}`.
import { afterAll, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetGitDirs } from "@/packages/workit-core/src/git/facts";
import {
  readBranchCommit,
  readHeadBranch,
  readHeadCommit,
} from "@/packages/workit-core/src/git/refs-read";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => forgetGitDirs());

const run = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });

const git = (cwd: string, ...args: string[]): string => {
  const result = run(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const answer = (cwd: string, args: string[]): string | null => {
  const result = run(cwd, args);
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || null;
};

/** git's own answers, the oracle. */
const oracle = {
  head: (cwd: string) => answer(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]),
  branch: (cwd: string) => answer(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
  tip: (cwd: string, name: string) =>
    answer(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${name}^{commit}`]),
};

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const repo = (branch = "main"): string => {
  const dir = tmp("wk-refs-");
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
};

let counter = 0;
const commit = (dir: string): string => {
  counter += 1;
  writeFileSync(path.join(dir, "f"), `${counter}\n`);
  git(dir, "add", "f");
  git(dir, "commit", "-q", "-m", `c${counter}`);
  return git(dir, "rev-parse", "HEAD");
};

/** Every file read equals git or is null; returns how many reads answered. */
const agreeWithGit = (cwd: string, names: readonly string[] = []): number => {
  let answered = 0;
  const head = readHeadCommit(cwd);
  if (head !== null) {
    answered += 1;
    expect(head).toBe(oracle.head(cwd) as string);
  }
  const branch = readHeadBranch(cwd);
  if (branch !== null) {
    answered += 1;
    expect(branch.branch).toBe(oracle.branch(cwd));
  }
  for (const name of names) {
    const tip = readBranchCommit(cwd, name);
    if (tip !== null) {
      answered += 1;
      expect(tip).toBe(oracle.tip(cwd, name) as string);
    }
  }
  return answered;
};

test("Given a checkout on a branch with a loose ref, Then every read is git's answer", () => {
  const dir = repo();
  git(dir, "switch", "-q", "-c", "feature/x");
  const sha = commit(dir);
  expect(readHeadCommit(dir)).toBe(sha);
  expect(readHeadBranch(dir)).toEqual({ branch: "feature/x" });
  expect(readBranchCommit(dir, "feature/x")).toBe(sha);
  expect(agreeWithGit(dir, ["feature/x"])).toBe(3);
});

test("Given a branch only in packed-refs and its commit in a pack, Then the reads find it", () => {
  const dir = repo();
  const sha = commit(dir);
  git(dir, "pack-refs", "--all");
  git(dir, "repack", "-adq");
  git(dir, "prune-packed");
  expect(() => readFileSync(path.join(dir, ".git", "refs", "heads", "main"))).toThrow();
  expect(readFileSync(path.join(dir, ".git", "packed-refs"), "utf8")).toContain(
    `${sha} refs/heads/main`,
  );
  expect(readHeadCommit(dir)).toBe(sha);
  expect(readBranchCommit(dir, "main")).toBe(sha);
  expect(readHeadBranch(dir)).toEqual({ branch: "main" });
});

test("Given a detached HEAD, Then HEAD reads its commit and no branch", () => {
  const dir = repo();
  const first = commit(dir);
  commit(dir);
  git(dir, "checkout", "-q", "--detach", first);
  expect(readHeadCommit(dir)).toBe(first);
  expect(readHeadBranch(dir)).toEqual({ branch: null });
  expect(oracle.branch(dir)).toBeNull();
});

test("Given a linked worktree, Then its own HEAD and the shared branch tips are read", () => {
  const dir = repo();
  const main = commit(dir);
  const linked = path.join(tmp("wk-refs-wt-"), "wt");
  git(dir, "worktree", "add", "-q", "-b", "other", linked);
  const other = commit(linked);
  expect(readHeadCommit(linked)).toBe(other);
  expect(readHeadBranch(linked)).toEqual({ branch: "other" });
  expect(readBranchCommit(linked, "main")).toBe(main);
  expect(readHeadCommit(dir)).toBe(main);
  expect(readBranchCommit(dir, "other")).toBe(other);
});

test("Given an unborn branch, Then HEAD has no commit to read and the branch is named", () => {
  const dir = repo("start");
  expect(readHeadCommit(dir)).toBeNull();
  expect(oracle.head(dir)).toBeNull();
  expect(readHeadBranch(dir)).toEqual({ branch: "start" });
  expect(readBranchCommit(dir, "start")).toBeNull();
});

test("Given HEAD a symref outside refs/heads, Then the reads leave it to git", () => {
  const dir = repo();
  commit(dir);
  git(dir, "tag", "v1");
  git(dir, "symbolic-ref", "HEAD", "refs/tags/v1");
  expect(oracle.branch(dir)).toBe("v1");
  expect(readHeadCommit(dir)).toBeNull();
  expect(readHeadBranch(dir)).toBeNull();
});

test("Given a tag with the branch's name, Then the short branch name is left to git (it prints heads/<b>)", () => {
  const dir = repo();
  commit(dir);
  git(dir, "tag", "main");
  expect(oracle.branch(dir)).toBe("heads/main");
  expect(readHeadBranch(dir)).toBeNull();
  expect(readHeadCommit(dir)).toBe(oracle.head(dir) as string);
});

test("Given a branch file naming a tree or a missing object, Then no commit is read", () => {
  const dir = repo();
  commit(dir);
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  const heads = path.join(dir, ".git", "refs", "heads");
  writeFileSync(path.join(heads, "tree"), `${tree}\n`);
  writeFileSync(path.join(heads, "gone"), `${"1".repeat(40)}\n`);
  expect(oracle.tip(dir, "tree")).toBeNull();
  expect(oracle.tip(dir, "gone")).toBeNull();
  expect(readBranchCommit(dir, "tree")).toBeNull();
  expect(readBranchCommit(dir, "gone")).toBeNull();
  git(dir, "symbolic-ref", "HEAD", "refs/heads/tree");
  expect(readHeadCommit(dir)).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "Given HEAD as a symlink (git reads it as a symref), Then the reads leave it to git",
  () => {
    const dir = repo();
    commit(dir);
    const head = path.join(dir, ".git", "HEAD");
    unlinkSync(head);
    symlinkSync("refs/heads/main", head);
    expect(oracle.branch(dir)).toBe("main");
    expect(readHeadBranch(dir)).toBeNull();
    expect(readHeadCommit(dir)).toBeNull();
  },
);

test("Given replace refs, Then no commit is read from the files", () => {
  const dir = repo();
  const first = commit(dir);
  const second = commit(dir);
  git(dir, "replace", first, second);
  expect(readHeadCommit(dir)).toBeNull();
  expect(readBranchCommit(dir, "main")).toBeNull();
});

test("Given GIT_DIR or GIT_INDEX_FILE in the environment, Then the reads leave it to git", () => {
  const dir = repo();
  commit(dir);
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
    const prior = process.env[name];
    process.env[name] = name === "GIT_INDEX_FILE" ? path.join(dir, "other-index") : dir;
    try {
      expect(readHeadCommit(dir)).toBeNull();
      expect(readHeadBranch(dir)).toBeNull();
      expect(readBranchCommit(dir, "main")).toBeNull();
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});

test("Given reftable ref storage in the config or on disk, Then the reads leave it to git", () => {
  const configured = repo();
  commit(configured);
  const config = path.join(configured, ".git", "config");
  writeFileSync(config, `${readFileSync(config, "utf8")}[extensions]\n\trefStorage = reftable\n`);
  expect(readHeadCommit(configured)).toBeNull();
  expect(readHeadBranch(configured)).toBeNull();
  const onDisk = repo();
  commit(onDisk);
  mkdirSync(path.join(onDisk, ".git", "reftable"));
  expect(readHeadCommit(onDisk)).toBeNull();
  expect(readBranchCommit(onDisk, "main")).toBeNull();
});

const reftableSupported =
  spawnSync("git", ["init", "-h"], { encoding: "utf8" }).stdout.includes("--ref-format") ||
  spawnSync("git", ["init", "-h"], { encoding: "utf8" }).stderr.includes("--ref-format");

test.skipIf(!reftableSupported)(
  "Given a reftable repository, Then the file reads return null and git answers",
  () => {
    const dir = tmp("wk-refs-reftable-");
    git(dir, "init", "-q", "--ref-format=reftable", "-b", "main");
    git(dir, "config", "user.email", "t@example.test");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    const sha = commit(dir);
    expect(oracle.head(dir)).toBe(sha);
    expect(readHeadCommit(dir)).toBeNull();
    expect(readHeadBranch(dir)).toBeNull();
    expect(readBranchCommit(dir, "main")).toBeNull();
  },
);

test("Given HEAD moved by a commit between two reads, Then the second read sees the new commit", () => {
  const dir = repo();
  const before = commit(dir);
  expect(readHeadCommit(dir)).toBe(before);
  expect(readBranchCommit(dir, "main")).toBe(before);
  const after = commit(dir);
  expect(after).not.toBe(before);
  expect(readHeadCommit(dir)).toBe(after);
  expect(readBranchCommit(dir, "main")).toBe(after);
  git(dir, "switch", "-q", "-c", "next");
  expect(readHeadBranch(dir)).toEqual({ branch: "next" });
});

// ---------------------------------------------------------------------------
// Parity property: random layouts, git as the oracle after every step.

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const NAMES = ["main", "feature/x", "fix/a-b", "release/1.2", "x", "heads", "origin", "v1"];

type Layout = { dir: string; checkouts: string[]; log: string[] };

/** One random step; returns its description. Hand edits model what git would never write itself. */
const steps: Array<(layout: Layout, pick: <T>(items: readonly T[]) => T) => string> = [
  (layout, pick) => {
    const at = pick(layout.checkouts);
    commit(at);
    return `commit in ${path.basename(at)}`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    const at = pick(layout.checkouts);
    const ok = run(at, ["switch", "-q", "-C", name]).status === 0;
    return `switch -C ${name} (${ok ? "ok" : "refused"})`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    run(layout.dir, ["branch", "-f", name]);
    return `branch -f ${name}`;
  },
  (layout, pick) => {
    const at = pick(layout.checkouts);
    run(at, ["checkout", "-q", "--detach"]);
    return "detach";
  },
  (layout) => {
    const ok = run(layout.dir, ["pack-refs", "--all"]).status === 0;
    return `pack-refs --all (${ok ? "ok" : "refused"})`;
  },
  (layout) => {
    // A hand-written broken ref makes git refuse: the layout stays as it was.
    const ok = run(layout.dir, ["repack", "-adq"]).status === 0;
    if (ok) git(layout.dir, "prune-packed");
    return `repack -ad (${ok ? "ok" : "refused"})`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    const annotated = pick([true, false]);
    run(layout.dir, ["tag", "-f", ...(annotated ? ["-a", "-m", "t"] : []), name]);
    return `tag ${annotated ? "-a " : ""}${name}`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    run(layout.dir, ["update-ref", `refs/remotes/${name}`, "HEAD"]);
    return `update-ref refs/remotes/${name}`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    const at = pick(layout.checkouts);
    run(at, ["switch", "-q", "--orphan", `${name}-orphan`]);
    return `switch --orphan ${name}-orphan`;
  },
  (layout, pick) => {
    const name = pick(NAMES);
    run(layout.dir, ["branch", "-D", name]);
    return `branch -D ${name}`;
  },
  (layout, pick) => {
    const target = pick(["refs/tags/v1", "refs/remotes/origin/main", "refs/heads/main"]);
    const at = pick(layout.checkouts);
    run(at, ["symbolic-ref", "HEAD", target]);
    return `symbolic-ref HEAD ${target}`;
  },
  (layout, pick) => {
    // Hand edit: a branch file naming a tree, a blob, a tag object or garbage.
    const name = pick(["hand", "feature/hand"]);
    const kind = pick(["tree", "tag", "garbage", "missing", "symref"]);
    const tag = answer(layout.dir, ["rev-parse", "-q", "--verify", "refs/tags/v1"]);
    const content = {
      tree: answer(layout.dir, ["rev-parse", "-q", "--verify", "HEAD^{tree}"]),
      tag,
      garbage: "not a sha",
      missing: "2".repeat(40),
      symref: "ref: refs/heads/main",
    }[kind];
    if (content === null) return `hand ${kind}: skipped`;
    const file = path.join(layout.dir, ".git", "refs", "heads", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${content}\n`);
    return `hand-write refs/heads/${name} = ${kind}`;
  },
  (layout, pick) => {
    // A root-level file shadowing a branch's short name.
    const name = pick(["X", "main"]);
    writeFileSync(path.join(layout.dir, ".git", name), `${"3".repeat(40)}\n`);
    return `root file .git/${name}`;
  },
  (layout) => {
    if (layout.checkouts.length > 1) return "worktree: already";
    const linked = path.join(tmp("wk-refs-prop-wt-"), "wt");
    const ok = run(layout.dir, ["worktree", "add", "-q", "--detach", linked]).status === 0;
    if (ok) layout.checkouts.push(linked);
    return `worktree add (${ok ? "ok" : "refused"})`;
  },
];

// Fewer layouts on Windows, where each of the ~40 git spawns per layout costs 10-30x more.
const SEEDS = Array.from(
  { length: process.platform === "win32" ? 8 : 24 },
  (_, index) => 0x5eed + index * 7919,
);

// One test per generated layout: each stays a few seconds even where git
// spawns are slow (Windows), instead of one test whose time grows with SEEDS.
// How often the file read spared a spawn where git had a commit for HEAD.
const tally = { headKnown: 0, headRead: 0 };

for (const seed of SEEDS)
  test(`Given generated layout ${seed}, Then no file read ever disagrees with git`, () => {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const dir = repo();
    const layout: Layout = { dir, checkouts: [dir], log: [] };
    if (next() < 0.8) commit(dir);
    for (let step = 0; step < 7; step += 1) {
      layout.log.push(pick(steps)(layout, pick));
      forgetGitDirs();
      for (const at of layout.checkouts) {
        try {
          agreeWithGit(at, [pick(NAMES), "hand", "feature/hand"]);
        } catch (error) {
          throw new Error(
            `seed ${seed} in ${path.basename(at)} after: ${layout.log.join("; ")}\n${String(error)}`,
            { cause: error },
          );
        }
        if (oracle.head(at) !== null) {
          tally.headKnown += 1;
          if (readHeadCommit(at) !== null) tally.headRead += 1;
        }
      }
    }
  });

test("Given every generated layout, Then the file read answered most HEAD reads (it does not pass by always deferring to git)", () => {
  expect(tally.headKnown).toBeGreaterThan(0);
  expect(tally.headRead).toBeGreaterThan(tally.headKnown / 2);
});
