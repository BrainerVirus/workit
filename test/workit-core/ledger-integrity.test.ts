// Verification integrity (audit 2026-10-07, D18 honest-mistake model): the
// row hash chain, supersede scope, stale/self shadowing, renames, other
// worktrees, the configured trunk and the cost of same-session re-reviews.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendObserved,
  checkVerdicts,
  defaultBase,
  ledgerPath,
  readLedger,
  recordDecision,
  recordVerdict,
  type LedgerActor,
  type LedgerRead,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const repo = (trunk = "main"): string => {
  const root = tmp("wk-integrity-");
  git(root, "init", "-q", "-b", trunk);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
};

const commit = (root: string, file: string, content: string, message: string): string => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
  git(root, "add", "--", file);
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
};

const featureRepo = (branch = "feature/x"): string => {
  const root = repo();
  commit(root, "a.txt", "base\n", "base");
  git(root, "checkout", "-qb", branch);
  commit(root, "feature.txt", "feature\n", "feature work");
  return root;
};

const actor = (session: string | null): LedgerActor => ({ host: "cli", session, agentId: null });
const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};
const read = (cwd: string): LedgerRead => value(readLedger(cwd, { integrity: true }));
const as = (root: string, session: string | null) => ({ cwd: root, actor: actor(session) });
const seedAuthor = (root: string, branch: string, session: string) =>
  value(
    appendObserved(root, {
      type: "commit.recorded",
      session,
      actor: actor(session),
      branch,
      head: git(root, "rev-parse", "HEAD"),
    }),
  );

// ---------------------------------------------------------------------------
// M4: the CLI's own rows carry a hash chain; hand-written rows are flagged

test("Given rows the CLI wrote and one appended by hand, When the ledger is read, Then only the hand-written row is an unverified row", () => {
  const root = featureRepo();
  value(recordDecision(as(root, "s1"), { what: "first", why: "w" }));
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "ghost-1", at: "2030-01-01T00:00:00.000Z", type: "verdict", kind: "review", result: "verified", branch: "feature/x", actor: { session: "ghost" } })}\n`,
  );
  value(recordVerdict(as(root, "s2"), { result: "verified", how: "ran it" }));
  const ledger = read(root);
  expect(ledger.integrity?.unverified.map((row) => [row.id, row.reason])).toEqual([
    ["ghost-1", "unsigned"],
  ]);
  expect(ledger.integrity?.chained).toBe(2);
  const check = checkVerdicts(root, "feature/x", ledger.rows);
  expect(check.warnings.join("\n")).toContain("ghost-1");
});

test("Given a CLI-written row edited in place, When the ledger is read, Then the edit and the broken link after it are reported, and rows before the chain began are legacy", () => {
  const root = featureRepo();
  const file = value(ledgerPath(root));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ v: 1, id: "old-1", at: "2026-01-01T00:00:00.000Z", type: "decision", what: "before chains", actor: {} })}\n`,
  );
  const edited = value(recordDecision(as(root, "s1"), { what: "original", why: "w" }));
  value(recordDecision(as(root, "s1"), { what: "next", why: "w" }));
  writeFileSync(file, readFileSync(file, "utf8").replace('"original"', '"rewritten"'));
  const integrity = read(root).integrity;
  expect(integrity?.legacy).toBe(1);
  expect(integrity?.unverified.map((row) => row.reason)).toEqual(["hash_mismatch", "broken_link"]);
  expect(integrity?.unverified[0].id).toBe(edited.id);
});

// ---------------------------------------------------------------------------
// ledger minors

test("Given an independent pass on an older head and the author's own pass on the current head, When the branch is checked, Then it reads self-reviewed with the current self verdict", () => {
  const root = featureRepo();
  seedAuthor(root, "feature/x", "author");
  value(recordVerdict(as(root, "v1"), { result: "verified", how: "reviewed H1" }));
  commit(root, "feature.txt", "feature, more\n", "more work");
  const self = value(
    recordVerdict(as(root, "author"), { result: "tests-verified", how: "suite", self: true }),
  );
  const check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.review).toBe("self-reviewed");
  expect(check.selfVerdict?.id).toBe(self.id);
});

test("Given a failure on one branch and kind, When the same session supersedes it from another branch or with another kind, Then the link is refused and the failure stands", () => {
  const root = featureRepo();
  const failure = value(recordVerdict(as(root, "v1"), { result: "failed", how: "bug" }));
  git(root, "checkout", "-qb", "feature/other");
  const crossBranch = recordVerdict(
    { ...as(root, "v1"), supersedes: failure.id },
    { result: "verified", how: "fine" },
  );
  expect(crossBranch.ok).toBe(false);
  if (!crossBranch.ok) expect(crossBranch.error).toContain("another branch");
  git(root, "checkout", "-q", "feature/x");
  const crossKind = recordVerdict(
    { ...as(root, "v1"), supersedes: failure.id },
    { result: "verified", how: "fine", kind: "unit" },
  );
  expect(crossKind.ok).toBe(false);
  if (!crossKind.ok) expect(crossKind.error).toContain("kind");
  // A hand-written cross-branch link is ignored by the reader too.
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "x-branch", at: "2030-01-01T00:00:00.000Z", type: "verdict", kind: "review", result: "verified", branch: "feature/other", supersedes: failure.id, actor: { session: "v1" } })}\n`,
  );
  expect(checkVerdicts(root, "feature/x", read(root).rows).accepted.reasons).toEqual([
    "failing_verdict",
  ]);
});

test("Given an accepted independent pass, When the author records failed --self on the same head, Then the check surfaces the author's failure", () => {
  const root = featureRepo();
  seedAuthor(root, "feature/x", "author");
  value(recordVerdict(as(root, "v1"), { result: "verified", how: "looked fine" }));
  const own = value(
    recordVerdict(as(root, "author"), { result: "failed", how: "it crashes", self: true }),
  );
  const check = checkVerdicts(root, "feature/x", read(root).rows);
  expect(check.warnings.join("\n")).toContain(own.id);
  expect(check.warnings.join("\n")).toContain("author");
});

test("Given verdicts and author rows on feature/a, When the branch is renamed to feature/b, Then the verdicts follow it and the author is still refused", () => {
  const root = featureRepo("feature/a");
  seedAuthor(root, "feature/a", "author");
  value(recordVerdict(as(root, "v1"), { result: "verified", how: "ran it" }));
  git(root, "branch", "-m", "feature/a", "feature/b");
  const check = checkVerdicts(root, "feature/b", read(root).rows);
  expect(check.accepted.accepted).toBe(true);
  expect(check.authors).toEqual(["author"]);
  const refused = recordVerdict(as(root, "author"), { result: "verified", how: "mine" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toContain("author_verdict");
});

test("Given a branch checked out dirty in another worktree, When a verdict names it with --branch from the main checkout, Then it is refused as dirty", () => {
  const root = featureRepo();
  git(root, "checkout", "-q", "main");
  const other = path.join(tmp("wk-integrity-wt-"), "w");
  git(root, "worktree", "add", "-q", other, "feature/x");
  writeFileSync(path.join(other, "feature.txt"), "uncommitted\n");
  const result = recordVerdict(
    { ...as(root, "v1"), branch: "feature/x" },
    { result: "verified", how: "x" },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("dirty_worktree");
});

const withWorkspace = <T>(root: string, workspace: Record<string, unknown>, fn: () => T): T => {
  const dir = path.join(tmp("wk-integrity-config-"), "workit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "w", glob: `${root}/**`, ...workspace }] }),
  );
  const saved = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = saved;
  }
};

test("Given a release track whose PR target is integration, When the default base is resolved, Then it is integration rather than main; without tracks it stays main", () => {
  const root = repo("main");
  commit(root, "a.txt", "base\n", "base");
  git(root, "checkout", "-qb", "integration");
  commit(root, "b.txt", "line\n", "integration work");
  git(root, "checkout", "-qb", "feature/x");
  commit(root, "c.txt", "feature\n", "feature work");
  const vcs = { provider: "github", defaultTargetBranch: "integration" };
  expect(withWorkspace(root, { vcs }, () => defaultBase(root))).toBe("main");
  const track = {
    strategy: "gitflow",
    productionBranch: "main",
    integrationBranch: "integration",
    naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
    baseBranch: "integration",
    mergeBackBranches: ["integration"],
    pullRequestTarget: "integration",
    tagNamespace: "",
  };
  expect(
    withWorkspace(root, { vcs, releaseTracks: { line: track } }, () => defaultBase(root)),
  ).toBe("integration");
});

test("Given a reviewer's failure on feature/a, When the branch is renamed to feature/b, Then the same session's --supersedes of that failure is accepted on write and on read", () => {
  const root = featureRepo("feature/a");
  const failure = value(recordVerdict(as(root, "v1"), { result: "failed", how: "bug" }));
  git(root, "branch", "-m", "feature/a", "feature/b");
  value(
    recordVerdict(
      { ...as(root, "v1"), supersedes: failure.id },
      { result: "verified", how: "my mistake" },
    ),
  );
  const rows = read(root).rows;
  expect(rows.find((row) => row.id === failure.id)?.superseded).toBe(true);
  expect(checkVerdicts(root, "feature/b", rows).accepted.accepted).toBe(true);
});

test("Given rows of an older, deleted feature/a, When a new feature/a is created and renamed to feature/b, Then the old rows do not count for feature/b", () => {
  const root = featureRepo("feature/a");
  const earlier = new Date(Date.now() - 120_000);
  value(
    appendObserved(
      root,
      {
        type: "commit.recorded",
        session: "old-author",
        actor: actor("old-author"),
        branch: "feature/a",
        head: git(root, "rev-parse", "HEAD"),
      },
      { now: earlier },
    ),
  );
  git(root, "checkout", "-q", "main");
  git(root, "branch", "-D", "feature/a");
  git(root, "checkout", "-qb", "feature/a");
  commit(root, "other.txt", "other\n", "new work");
  seedAuthor(root, "feature/a", "new-author");
  git(root, "branch", "-m", "feature/a", "feature/b");
  expect(checkVerdicts(root, "feature/b", read(root).rows).authors).toEqual(["new-author"]);
});

test("Given a plain read, When the ledger is read without integrity, Then no row is hashed or labelled", () => {
  const root = featureRepo();
  value(recordDecision(as(root, "s1"), { what: "first", why: "w" }));
  const plain = value(readLedger(root));
  expect(plain.integrity).toBeNull();
  expect(plain.rows[0].integrity).toBeUndefined();
});

test("Given a hand-written line longer than the 64 KB tail, When the CLI appends after it, Then its row links to that line and only the hand line is unverified", () => {
  const root = featureRepo();
  value(recordDecision(as(root, "s1"), { what: "first", why: "w" }));
  appendFileSync(
    value(ledgerPath(root)),
    `${JSON.stringify({ v: 1, id: "huge-1", at: "2030-01-01T00:00:00.000Z", type: "decision", what: "x".repeat(70_000), actor: {} })}\n`,
  );
  value(recordDecision(as(root, "s1"), { what: "after", why: "w" }));
  expect(read(root).integrity?.unverified.map((row) => [row.id, row.reason])).toEqual([
    ["huge-1", "unsigned"],
  ]);
});

// ---------------------------------------------------------------------------
// perf: same-session re-reviews must not cost git calls per row

/** The fixed git calls of one check (heads, base, trailers, reflog, keys), with slack; per-row calls exceed it. */
const CALLS_BOUND = 20;

test("Given 20 alternating same-session failed/verified rows on distinct heads, When the branch is checked, Then the git calls do not grow with the rows", () => {
  const root = featureRepo();
  seedAuthor(root, "feature/x", "author");
  for (let index = 0; index < 10; index += 1) {
    commit(root, "feature.txt", `feature ${index}\n`, `step ${index}`);
    value(recordVerdict(as(root, "v1"), { result: "failed", how: `bug ${index}` }));
    commit(root, "feature.txt", `feature ${index} fixed\n`, `fix ${index}`);
    value(recordVerdict(as(root, "v1"), { result: "verified", how: `fixed ${index}` }));
  }
  const rows = read(root).rows;
  // git's own trace2 event log counts every git process, on every OS (no
  // PATH shim: Windows spawns resolve only git.exe).
  const log = path.join(tmp("wk-integrity-trace-"), "trace.json");
  const saved = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = log;
  let check: ReturnType<typeof checkVerdicts>;
  try {
    check = checkVerdicts(root, "feature/x", rows);
  } finally {
    if (saved === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = saved;
  }
  expect(check.accepted.accepted).toBe(true);
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes('"event":"start"')).length;
  expect(calls).toBeLessThan(CALLS_BOUND);
}, 30_000);
