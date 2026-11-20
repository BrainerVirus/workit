import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  mergeRebaseDeps,
  rebaseChangelogConflict,
} from "@/packages/workit-core/src/forge/merge-rebase";
import { mergePullRequest } from "@/packages/workit-core/src/forge/pr-ops";
import type { PrStatusDoc } from "@/packages/workit-core/src/forge/report";
import { resolveForge, type ResolvedForge } from "@/packages/workit-core/src/forge/resolve";
import { success } from "@/packages/workit-core/src/forge/types";
import { pushPreflight } from "@/packages/workit-core/src/git/ops";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #923: `pr merge` on a PR GitHub reports conflicting, where git shows the
// workspace changelog as the only conflict, rebases the branch with the
// changelog merge driver, pushes it with a lease on the PR head and stops
// without merging. Every other case refuses, pushes nothing, and names the
// exact commands.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const originalPlan = mergeRebaseDeps.pushPlan;
beforeAll(() => {
  configHome = useConfigHome("wk-merge-changelog-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  mergeRebaseDeps.pushPlan = originalPlan;
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string, session = "author-1") => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const doc = (entries: string[]) =>
  `# Changelog\n\n## [Unreleased]\n\n${entries.length ? `### Added\n\n${entries.map((e) => `- ${e}\n`).join("")}\n` : ""}## [1.0.0] - 2026-01-01\n\n### Added\n\n- first\n`;

const bareGit = (bare: string, ...args: string[]): string | null => {
  const result = spawnSync("git", args, { cwd: bare, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

type Pr = "conflicts" | "passing" | "merged";

type Setup = {
  repo: ForgeRepo;
  bare: string;
  head: string;
  baseTip: string;
  remoteTip: () => string | null;
  merges: () => number;
  setPr: (state: Pr) => void;
};

/**
 * PR #12 is feature/x, checked out here and pushed. main and feature/x each
 * add an Unreleased line to a CHANGELOG.md they share, plus `extra` files on
 * each side; the forge reports the PR conflicting until `setPr` changes it.
 */
const setup = (
  options: {
    autonomy?: Record<string, unknown>;
    mainFiles?: Record<string, string>;
    featureFiles?: Record<string, string>;
    author?: string;
  } = {},
): Setup => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const bare = path.join(repo.root, "remote.git");
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "Workit Test"],
    ["commit.gpgsign", "false"],
  ] as const)
    repo.git("config", key, value);
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files))
      writeFileSync(path.join(repo.cwd, file), text);
  };
  const commit = (message: string) => {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", message);
    return repo.git("rev-parse", "HEAD");
  };
  repo.git("fetch", "-q", "origin");
  repo.git("switch", "-q", "-c", "seed", "origin/main");
  write({ "CHANGELOG.md": doc([]) });
  const seed = commit("docs: changelog");
  write({ "CHANGELOG.md": doc(["main entry"]), ...options.mainFiles });
  const baseTip = commit("feat: main side");
  repo.git("push", "-q", bare, "HEAD:refs/heads/main");
  repo.git("switch", "-q", "feature/x");
  repo.git("reset", "-q", "--hard", seed);
  write({ "CHANGELOG.md": doc(["x entry"]), ...options.featureFiles });
  const head = commit("feat: x side");
  repo.git("push", "-q", "-f", bare, "feature/x:refs/heads/feature/x");
  repo.git("branch", "-q", "-D", "seed");
  repo.git("fetch", "-q", "origin");
  repo.subs["{{HEAD}}"] = head;
  repo.subs["{{BASE}}"] = baseTip;

  let pr: Pr = "conflicts";
  let merged = 0;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    'graphql status {"owner":"o","name":"r","number":"12"}': () => fixture(`github/pr-${pr}.json`),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged += 1;
      pr = "merged";
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
    ...(options.author
      ? {
          "GET repos/o/r/pulls/12": JSON.stringify({
            number: 12,
            state: "open",
            user: { login: options.author },
          }),
        }
      : {}),
  };
  Object.assign(forgeDeps, {
    runner: replayRunner(routes, repo.subs),
    sleep: async () => {},
    now: () => 0,
  });
  // The checkout's push URL names the forge; the push lands in the bare remote.
  mergeRebaseDeps.pushPlan = (cwd, branch) => {
    const plan = pushPreflight(cwd, { branch });
    return plan.ok ? success({ ...plan.data, remote: bare, rawUrl: bare, url: bare }) : plan;
  };
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          verification: "independent",
          deleteBranch: false,
          vcs: { provider: "github", account: "octo" },
          autonomy: options.autonomy ?? { push: true, merge: true },
        },
      ],
    }),
  );
  return {
    repo,
    bare,
    head,
    baseTip,
    remoteTip: () => bareGit(bare, "rev-parse", "refs/heads/feature/x")?.trim() ?? null,
    merges: () => merged,
    setPr: (state) => {
      pr = state;
    },
  };
};

const changelogAt = (bare: string, rev: string) => bareGit(bare, "show", `${rev}:CHANGELOG.md`);

test("Given a PR whose only conflict with main is a CHANGELOG.md Unreleased line and push and merge granted, When pr merge --method squash runs, Then it rebases with the driver, pushes with a lease, keeps both entries, does not merge and names ci wait and the same merge", async () => {
  const { repo, bare, head, baseTip, remoteTip, merges } = setup();

  const result = await run(["pr", "merge", "--method", "squash", "--json"], repo.cwd);
  const envelope = result.json();
  expect(result.code).toBe(3);
  expect(envelope).toMatchObject({
    ok: false,
    code: "blocked",
    unblock: "workit ci wait  # then: workit pr merge --method squash",
    data: {
      reason: "rebased_pushed",
      rebased: {
        branch: "feature/x",
        onto: "origin/main",
        baseSha: baseTip,
        previous: head,
        changelog: ["CHANGELOG.md"],
        next: ["workit ci wait", "workit pr merge --method squash"],
      },
    },
  });
  expect(envelope.error).toStartWith(
    "rebased_pushed: PR #12 conflicted with main only in CHANGELOG.md",
  );
  expect(envelope.data.rebased.rebaseRecorded).toHaveProperty("id");
  expect(envelope.data.rebased.pushRecorded).toHaveProperty("id");
  const rebased = repo.git("rev-parse", "HEAD");
  expect(rebased).not.toBe(head);
  expect(envelope.data.rebased.head).toBe(rebased);
  expect(remoteTip()).toBe(rebased);
  expect(repo.git("rev-parse", "HEAD~1")).toBe(baseTip);
  expect(changelogAt(bare, rebased)).toBe(doc(["main entry", "x entry"]));
  expect(merges()).toBe(0);
});

test("Given the human output, When the changelog-only conflict is rebased and pushed, Then it says so and prints workit ci wait and the same merge command", async () => {
  const { repo, merges } = setup();

  const result = await run(["pr", "merge", "--method", "squash"], repo.cwd);
  const text = result.stdout + result.stderr;
  expect(text).toContain("pushed it with --force-with-lease; not merged");
  expect(text).toContain("workit ci wait  # then: workit pr merge --method squash");
  expect(merges()).toBe(0);
});

test("Given the rebased PR's CI passes and a verdict covers the new head, When pr merge runs again, Then it merges through the normal gates", async () => {
  const { repo, remoteTip, merges, setPr } = setup();
  const first = await run(["pr", "merge", "--method", "squash", "--json"], repo.cwd);
  expect(first.json().data.reason).toBe("rebased_pushed");
  const rebased = remoteTip() as string;
  repo.subs["{{HEAD}}"] = rebased;
  setPr("passing");
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised the rebased head", "--json"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code, verdict.stdout).toBe(0);

  const second = await run(["pr", "merge", "--method", "squash", "--json"], repo.cwd);
  expect(second.json()).toMatchObject({ ok: true, data: { head: rebased, method: "squash" } });
  expect(second.code).toBe(0);
  expect(merges()).toBe(1);
});

test("Given a PR that also conflicts on a source file, When pr merge runs, Then it refuses naming both paths with an exact workit git rebase unblock and pushes nothing", async () => {
  const { repo, head, remoteTip, merges } = setup({
    mainFiles: { "feature.txt": "main side\n" },
    featureFiles: { "feature.txt": "x side\n" },
  });

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(result.code).not.toBe(0);
  expect(envelope.data).toMatchObject({ reason: "not_ready", next: "RESOLVE_CONFLICTS" });
  expect(envelope.data.conflicts.toSorted()).toEqual(["CHANGELOG.md", "feature.txt"]);
  expect(envelope.error).toContain("feature.txt is outside the changelog");
  expect(envelope.unblock).toStartWith(
    "workit git rebase --onto origin/main  # it stops on feature.txt",
  );
  expect(envelope.unblock).toContain("workit pr merge");
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict but push not granted, When pr merge runs, Then it refuses, pushes nothing and names the grant and the commands by hand", async () => {
  const { repo, head, remoteTip, merges } = setup({ autonomy: { push: false, merge: true } });

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain("was not rebased automatically: pushing needs the push grant");
  expect(envelope.unblock).toContain("workit grant set w push=");
  expect(envelope.unblock).toContain(
    "by hand: workit git rebase --onto origin/main, workit git push --force-with-lease, workit ci wait, and workit pr merge",
  );
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict but merge not granted, When pr merge runs, Then it refuses at the grant gate with the exact grant command and pushes nothing", async () => {
  const { repo, head, remoteTip, merges } = setup({ autonomy: { push: true, pr: true } });

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "grant_required" });
  expect(envelope.unblock).toContain("workit grant set w merge=");
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict and uncommitted changes to a tracked file, When pr merge runs, Then it refuses, rebases and pushes nothing and names the stash and the commands by hand", async () => {
  const { repo, head, remoteTip, merges } = setup();
  writeFileSync(path.join(repo.cwd, "a.txt"), "edited\n");

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain("uncommitted changes to tracked files");
  expect(envelope.unblock).toStartWith("git stash  # then: workit pr merge");
  expect(envelope.unblock).toContain("by hand: workit git rebase --onto origin/main");
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict and a local head ahead of the PR head, When pr merge runs, Then it refuses, pushes nothing and names the push", async () => {
  const { repo, head, remoteTip, merges } = setup();
  writeFileSync(path.join(repo.cwd, "later.txt"), "later\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: later");
  const local = repo.git("rev-parse", "HEAD");

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain(
    `local feature/x is at ${local.slice(0, 12)}, but the PR head is ${head.slice(0, 12)} (local is ahead)`,
  );
  expect(envelope.unblock).toBe("workit git push  # then: workit pr merge");
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(local);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict on a PR by another author, When pr merge runs, Then it never rewrites the branch and pushes nothing", async () => {
  const { repo, head, remoteTip, merges } = setup({ author: "someone" });

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain("PR #12 is by someone, not octo");
  expect(envelope.error).toContain("never rewrites another author's branch");
  expect(remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict with the branch checked out in another worktree, When pr merge runs from main, Then it refuses and names the same merge with --cwd that worktree", async () => {
  const { repo, head, remoteTip, merges } = setup();
  const other = path.join(repo.root, "wt-x");
  repo.git("switch", "-q", "main");
  repo.git("worktree", "add", "-q", other, "feature/x");

  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.error).toContain(`feature/x is checked out in ${other}, not in this checkout`);
  expect(envelope.unblock).toStartWith(`workit pr merge --pr 12 --cwd ${other}`);
  expect(remoteTip()).toBe(head);
  expect(merges()).toBe(0);
});

// Review of #924: each guard below has its own test, and each asserts that
// nothing was pushed and the branch was not rewritten.
const ACTOR = { host: "test", session: "author-1", agentId: null };

const unchanged = (made: Setup, local = made.head) => {
  expect(made.remoteTip()).toBe(made.head);
  expect(made.repo.git("rev-parse", "HEAD")).toBe(local);
  expect(made.repo.git("status", "--porcelain")).toBe("");
  expect(made.merges()).toBe(0);
};

test("Given the changelog-only conflict and the remote branch at another commit than the PR head, When pr merge runs, Then it refuses, rewrites nothing and names pr status", async () => {
  const made = setup();
  const { repo, bare, head, baseTip, remoteTip, merges } = made;
  repo.git("push", "-q", "-f", bare, `${baseTip}:refs/heads/feature/x`);

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain(
    `${bare}/feature/x is at ${baseTip.slice(0, 12)}, not the PR head ${head.slice(0, 12)}`,
  );
  expect(envelope.unblock).toBe(
    "workit pr status  # once the forge shows the new head: workit pr merge",
  );
  expect(remoteTip()).toBe(baseTip);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(merges()).toBe(0);
});

test("Given the changelog-only conflict on a PR from a fork, When the auto rebase is asked, Then it refuses naming the fork and pushes nothing", () => {
  const made = setup();
  const { repo, head } = made;
  const prDoc = {
    number: 12,
    base: "main",
    head: { branch: "feature/x", sha: head },
    headRepo: "someone/r",
  };
  const result = rebaseChangelogConflict(
    repo.cwd,
    { baseRemote: "origin", remote: "origin" } as unknown as ResolvedForge,
    {
      doc: prDoc as unknown as PrStatusDoc,
      label: "PR #12",
      again: "workit pr merge --method squash",
      ciWait: "workit ci wait",
      actor: ACTOR,
      notYours: null,
    },
  );
  expect(result).toMatchObject({ ok: false, code: "blocked", conflicts: ["CHANGELOG.md"] });
  if (result.ok) return;
  expect(result.why).toContain("PR #12 comes from a fork (someone/r)");
  expect(result.unblock).toStartWith("workit git rebase --onto origin/main");
  unchanged(made);
});

test("Given a CHANGELOG.md conflict outside the Unreleased entries, When pr merge runs, Then it refuses because the driver does not merge it and pushes nothing", async () => {
  const released = (entry: string, line: string) =>
    doc([entry]).replace("- first\n", `- ${line}\n`);
  const made = setup({
    mainFiles: { "CHANGELOG.md": released("main entry", "first, main wording") },
    featureFiles: { "CHANGELOG.md": released("x entry", "first, x wording") },
  });

  const result = await run(["pr", "merge", "--json"], made.repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain(
    "CHANGELOG.md conflicts with origin/main outside its Unreleased entries, which the changelog merge driver does not resolve",
  );
  expect(envelope.unblock).toStartWith(
    "workit git rebase --onto origin/main  # it stops on CHANGELOG.md",
  );
  unchanged(made);
});

test("Given a changelog-only conflict overall but a commit that conflicts on a source file mid-replay, When pr merge runs, Then the rebase is aborted, the branch is unchanged and nothing is pushed", async () => {
  const made = setup({ mainFiles: { "a.txt": "main side\n" } });
  const { repo, bare } = made;
  const aText = repo.git("show", `${made.head}:a.txt`);
  writeFileSync(path.join(repo.cwd, "a.txt"), "x side\n");
  repo.git("commit", "-q", "-am", "feat: x edits a");
  writeFileSync(path.join(repo.cwd, "a.txt"), `${aText}\n`);
  repo.git("commit", "-q", "-am", "revert: x restores a");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "-f", bare, "feature/x:refs/heads/feature/x");
  repo.subs["{{HEAD}}"] = head;

  const result = await run(["pr", "merge", "--json"], repo.cwd);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain("feature/x was not rebased: rebase_conflict");
  expect(envelope.error).toContain(
    `the rebase was aborted and feature/x is unchanged at ${head.slice(0, 12)}`,
  );
  expect(made.remoteTip()).toBe(head);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(made.merges()).toBe(0);
});

test("Given the changelog-only conflict on another author's PR and --others-pr, When pr merge runs, Then it still never rewrites the branch and pushes nothing", async () => {
  const made = setup({ author: "someone" });

  const result = await run(
    ["pr", "merge", "--others-pr", "--reason", "pairing", "--json"],
    made.repo.cwd,
  );
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "not_ready", conflicts: ["CHANGELOG.md"] });
  expect(envelope.error).toContain("never rewrites another author's branch");
  unchanged(made);
});

test("Given the changelog-only conflict, When stack land merges the PR (an expected base and branch), Then it refuses not_ready without the auto rebase and pushes nothing", async () => {
  const made = setup();
  const resolved = resolveForge(made.repo.cwd, {
    env: process.env,
    runner: forgeDeps.runner,
    now: forgeDeps.now,
  });
  if (!resolved.ok) throw new Error(resolved.error);

  const result = await mergePullRequest(
    made.repo.cwd,
    resolved.data,
    {
      pr: 12,
      method: "squash",
      deleteBranch: false,
      actor: ACTOR,
      expect: { base: "main", branch: "feature/x" },
    },
    async () => {},
  );
  expect(result).toMatchObject({
    ok: false,
    error: "not_ready: PR #12 is RESOLVE_CONFLICTS (conflicts, checks_pending)",
    refusal: { reason: "not_ready", next: "RESOLVE_CONFLICTS" },
  });
  expect(result).not.toHaveProperty("refusal.rebased");
  expect(result).not.toHaveProperty("refusal.conflicts");
  unchanged(made);
});
