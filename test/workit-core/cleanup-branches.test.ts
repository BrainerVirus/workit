import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepBranches, type BranchForge } from "@/packages/workit-core/src/core/cleanup";
import type { PrRef, PrState } from "@/packages/workit-core/src/forge/types";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "@/test/shared/grant-home";
import { spawnHeavyTimeout } from "@/test/shared/timeouts";

// #835: `gc --branches` deletes a local branch only on proof its work is on
// the trunk (a merged PR at its tip into the trunk or a long-lived branch,
// `git cherry`, a squash proof) and keeps every other one with the reason.

setDefaultTimeout(spawnHeavyTimeout());

let home: ConfigHome;
beforeAll(() => {
  home = useConfigHome("wk-gcbr-config-");
});
afterAll(() => home.restore());

const roots: string[] = [];
afterEach(() => {
  rmSync(path.join(home.configDir, "config.json"), { force: true });
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const actor = { host: "cli", session: "s-1", agentId: null };
const DAY = 24 * 60 * 60 * 1000;
/** Two days on: past the fresh window for a branch made now. */
const later = () => Date.now() + 2 * DAY;

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

/** A repo at <root>/proj on main with one commit. */
const setup = () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "wk-gcbr-")));
  roots.push(root);
  const main = path.join(root, "proj");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  git(main, "config", "commit.gpgsign", "false");
  commit(main, "a.txt", "a\n");
  return { root, main };
};

/** `branch` from main with two commits, squash-merged onto main as one commit. */
const squashMerged = (main: string, branch: string) => {
  git(main, "switch", "-q", "-c", branch);
  commit(main, `${branch.replaceAll("/", "-")}-1.txt`, "1\n");
  commit(main, `${branch.replaceAll("/", "-")}-2.txt`, "2\n");
  const tip = git(main, "rev-parse", "HEAD");
  git(main, "switch", "-q", "main");
  git(main, "merge", "-q", "--squash", branch);
  git(main, "commit", "-q", "-m", `squash ${branch}`);
  return tip;
};

/** `branch` from main with one commit that never landed. */
const unmerged = (main: string, branch: string) => {
  git(main, "switch", "-q", "-c", branch);
  commit(main, `${branch.replaceAll("/", "-")}.txt`, "local only\n");
  git(main, "switch", "-q", "main");
};

/** A fake forge: `prs` maps a branch to its PR (state, head, base). */
const fakeForge = (
  prs: Record<string, { number: number; state: PrState; head: string; base: string }>,
): BranchForge => ({
  headRepo: "o/r",
  headProjectId: null,
  forge: {
    findPr: (head) => {
      const pr = prs[head];
      const ref: PrRef | null = pr
        ? { number: pr.number, url: "", state: pr.state, headBranch: head, headSha: pr.head }
        : null;
      return { ok: true, data: ref };
    },
    prMeta: (n) => {
      const [head, pr] = Object.entries(prs).find(([, item]) => item.number === n) ?? [];
      if (!pr || !head) return { ok: false, code: "not_found", error: `no PR ${n}` };
      return {
        ok: true,
        data: {
          number: n,
          url: "",
          state: pr.state,
          draft: false,
          title: "t",
          base: pr.base,
          headBranch: head,
          author: null,
          fork: false,
        },
      };
    },
  },
});

const branches = (main: string) =>
  git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").toSorted();

test("Given a branch squash-merged by a PR at its tip, Then it is deletable as merged PR #n; --apply deletes it and one cleanup.removed row names it", () => {
  const env = setup();
  const tip = squashMerged(env.main, "feature/s");
  const forge = fakeForge({
    "feature/s": { number: 12, state: "merged", head: tip, base: "main" },
  });

  const dry = sweepBranches(env.main, { apply: false, actor, forge, now: later() });
  expect(dry.forgeSkipped).toBeNull();
  expect(dry.deletable).toEqual([{ name: "feature/s", tip, reason: "merged PR #12" }]);
  expect(branches(env.main)).toEqual(["feature/s", "main"]);

  const applied = sweepBranches(env.main, { apply: true, actor, forge, now: later() });
  expect(applied.deleted).toEqual(["feature/s"]);
  expect(branches(env.main)).toEqual(["main"]);
  const ledger = readLedger(env.main);
  if (!ledger.ok) throw new Error(ledger.error);
  const rows = ledger.value.rows.filter((row) => row.type === "cleanup.removed");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ trigger: "gc --branches", branches: ["feature/s"] });
});

test("Given a branch with one commit whose patch is not on the trunk, When --apply runs, Then it is kept with that reason", () => {
  const env = setup();
  unmerged(env.main, "feature/u");
  const applied = sweepBranches(env.main, { apply: true, actor, forge: null, now: later() });
  expect(applied.deletable).toEqual([]);
  expect(applied.kept).toEqual([
    { name: "feature/u", reason: "1 commit not on refs/heads/main by patch id" },
  ]);
  expect(branches(env.main)).toContain("feature/u");
});

test("Given a branch with an open PR, Then it is kept naming the PR, though its patch is on the trunk", () => {
  const env = setup();
  const tip = squashMerged(env.main, "feature/o");
  const forge = fakeForge({ "feature/o": { number: 7, state: "open", head: tip, base: "main" } });
  const applied = sweepBranches(env.main, { apply: true, actor, forge, now: later() });
  expect(applied.kept).toEqual([{ name: "feature/o", reason: "open PR #7" }]);
  expect(branches(env.main)).toContain("feature/o");
});

test("Given a branch whose PR merged into a stack parent, When --apply runs, Then it is kept, naming the base", () => {
  const env = setup();
  const tip = squashMerged(env.main, "feature/child");
  const forge = fakeForge({
    "feature/child": { number: 9, state: "merged", head: tip, base: "feature/parent" },
  });
  const applied = sweepBranches(env.main, { apply: true, actor, forge, now: later() });
  expect(applied.deleted).toEqual([]);
  expect(applied.kept).toEqual([
    {
      name: "feature/child",
      reason: "PR #9 merged into feature/parent, not main or a long-lived branch (a stack parent)",
    },
  ]);
  expect(branches(env.main)).toContain("feature/child");
});

test("Given a branch checked out in any worktree (a host's worktree-agent-x included), Then it is kept naming the worktree", () => {
  const env = setup();
  const agent = path.join(env.main, ".claude", "worktrees", "agent-x");
  mkdirSync(path.dirname(agent), { recursive: true });
  git(env.main, "worktree", "add", "-q", "-b", "worktree-agent-x", agent, "main");
  const applied = sweepBranches(env.main, { apply: true, actor, forge: null, now: later() });
  expect(applied.deletable).toEqual([]);
  expect(applied.kept).toEqual([
    { name: "worktree-agent-x", reason: expect.stringMatching(/^checked out in .*agent-x$/u) },
  ]);
  expect(branches(env.main)).toContain("worktree-agent-x");
});

test("Given a worktree-agent branch with no commits off the trunk, checked out nowhere and older than a day, Then it goes", () => {
  const env = setup();
  git(env.main, "branch", "worktree-agent-y");
  const applied = sweepBranches(env.main, { apply: true, actor, forge: null, now: later() });
  expect(applied.deletable).toEqual([
    expect.objectContaining({ name: "worktree-agent-y", reason: "no commits off refs/heads/main" }),
  ]);
  expect(applied.deleted).toEqual(["worktree-agent-y"]);
});

test("Given a branch with no commits of its own younger than 24 h, Then it is kept as fresh", () => {
  const env = setup();
  git(env.main, "branch", "feature/new");
  const applied = sweepBranches(env.main, { apply: true, actor, forge: null });
  expect(applied.kept).toEqual([
    {
      name: "feature/new",
      reason: "no commits of its own and created or moved in the last 24 hours (fresh)",
    },
  ]);
  expect(branches(env.main)).toContain("feature/new");
});

test("Given develop under a git-flow policy with no commits off main, Then it is never listed for deletion", () => {
  writeFileSync(
    path.join(home.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const env = setup();
  git(env.main, "branch", "develop");
  const applied = sweepBranches(env.main, { apply: true, actor, forge: null, now: later() });
  expect(applied.deletable).toEqual([]);
  expect(applied.kept).toEqual([
    { name: "develop", reason: "a long-lived branch of the branch policy" },
  ]);
  expect(branches(env.main)).toContain("develop");
});

test("Given no forge access, Then only the git proofs apply and the sweep says the merged-PR check was skipped", () => {
  const env = setup();
  squashMerged(env.main, "feature/s");
  unmerged(env.main, "feature/u");
  const dry = sweepBranches(env.main, {
    apply: false,
    actor,
    forge: null,
    forgeSkipped: "no push remote",
    now: later(),
  });
  expect(dry.forgeSkipped).toBe("no push remote");
  expect(dry.deletable).toEqual([
    expect.objectContaining({ name: "feature/s", reason: "squash-merged" }),
  ]);
  expect(dry.kept.map((entry) => entry.name)).toEqual(["feature/u"]);
});

test("Given a merged PR whose head is not the local tip, Then the PR proves nothing and the local commit keeps the branch", () => {
  const env = setup();
  const tip = squashMerged(env.main, "feature/s");
  git(env.main, "switch", "-q", "feature/s");
  commit(env.main, "after.txt", "after the merge\n");
  git(env.main, "switch", "-q", "main");
  const forge = fakeForge({
    "feature/s": { number: 12, state: "merged", head: tip, base: "main" },
  });
  const applied = sweepBranches(env.main, { apply: true, actor, forge, now: later() });
  expect(applied.deleted).toEqual([]);
  expect(applied.kept).toEqual([
    { name: "feature/s", reason: "3 commits not on refs/heads/main by patch id" },
  ]);
});
