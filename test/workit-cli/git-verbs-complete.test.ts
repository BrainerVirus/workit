import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// The rest of `workit git commit|branch` an agent otherwise drops to raw git
// for: --amend, --allow-empty, -F, in-progress operations, whole hook output,
// the push advice after an amend and the branch policy of an unconfigured repo.
// Real git against a local bare remote.

setDefaultTimeout(60_000);

const CLI = path.resolve(import.meta.dir, "../../packages/workit-cli/src/main.ts");
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-complete-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = (
  config: Record<string, unknown> | null = { branchPolicy: { preset: "github-flow" } },
) => {
  if (config) writeFileSync(path.join(configHome.configDir, "config.json"), JSON.stringify(config));
  const repo = makeRemoteRepo();
  repos.push(repo);
  return repo;
};

const SESSION = { ...process.env, WORKIT_SESSION_ID: "author-1" };

const run = async (argv: string[], cwd: string, env: NodeJS.ProcessEnv = SESSION) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const onFeature = async (repo: RemoteRepo, file = "a.txt") => {
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write(file, "a\n");
  expect((await run(["git", "commit", "-m", "feat: a", "--", file], repo.cwd)).code).toBe(0);
  return repo.git("rev-parse", "HEAD");
};

const hook = (repo: RemoteRepo, name: string, body: string) => {
  const file = path.join(repo.root, "hooks", name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

const trailerLines = (message: string) =>
  message.split("\n").filter((line) => line.startsWith("Workit-Session:"));

// ---------------------------------------------------------------------------
// --amend

test("Given a commit, When it is amended with -m, Then the branch still has one commit with the new message, the trailer and an amended ledger row", async () => {
  const repo = setup();
  const first = await onFeature(repo);
  const result = await run(
    ["git", "commit", "--amend", "-m", "feat: a better", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  const sha = repo.git("rev-parse", "HEAD");
  expect(sha).not.toBe(first);
  expect(repo.git("rev-list", "--count", "origin/main..HEAD")).toBe("1");
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: a better\n\nWorkit-Session: author-1");
  expect(result.json().data).toMatchObject({ sha, amended: first, files: ["a.txt"] });
  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  expect(ledger.value.rows.findLast((row) => row.type === "commit.recorded")).toMatchObject({
    head: sha,
    amended: first,
    subject: "feat: a better",
  });
  // The amended message is still convention-checked.
  const bad = await run(["git", "commit", "--amend", "-m", "reworded"], repo.cwd);
  expect(bad.code).toBe(3);
  expect(repo.git("rev-parse", "HEAD")).toBe(sha);
});

test("Given a commit with trailers, When --amend --no-edit adds a file, Then the message and trailers are kept and the session trailer is never doubled", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  expect(
    (await run(["git", "commit", "-m", "feat: a", "-m", "Refs: WK-1", "--", "a.txt"], repo.cwd))
      .code,
  ).toBe(0);
  repo.write("b.txt", "b\n");
  const same = await run(
    ["git", "commit", "--amend", "--no-edit", "--json", "--", "b.txt"],
    repo.cwd,
  );
  expect(same.code).toBe(0);
  const message = repo.git("log", "-1", "--format=%B");
  expect(message).toBe("feat: a\n\nRefs: WK-1\nWorkit-Session: author-1");
  expect(repo.git("show", "--name-only", "--format=", "HEAD").split("\n").toSorted()).toEqual([
    "a.txt",
    "b.txt",
  ]);
  // A second session that amends adds itself once and keeps the first.
  const env = { ...process.env, WORKIT_SESSION_ID: "author-2" };
  expect((await run(["git", "commit", "--amend", "--no-edit"], repo.cwd, env)).code).toBe(0);
  expect((await run(["git", "commit", "--amend", "--no-edit"], repo.cwd, env)).code).toBe(0);
  expect(trailerLines(repo.git("log", "-1", "--format=%B"))).toEqual([
    "Workit-Session: author-1",
    "Workit-Session: author-2",
  ]);
  expect(repo.git("rev-list", "--count", "origin/main..HEAD")).toBe("1");
});

test("Given --amend, When neither a message nor --no-edit is given, Then it is a usage error", async () => {
  const repo = setup();
  await onFeature(repo);
  const head = repo.git("rev-parse", "HEAD");
  const missing = await run(["git", "commit", "--amend"], repo.cwd);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("--amend needs -m/-F or --no-edit");
  expect((await run(["git", "commit", "--no-edit", "-m", "feat: x"], repo.cwd)).code).toBe(2);
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
});

test("Given a pushed commit, When it is amended, Then the output says to publish with --force-with-lease, and that push succeeds", async () => {
  const repo = setup();
  const first = await onFeature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  const amended = await run(["git", "commit", "--amend", "-m", "feat: a2"], repo.cwd);
  expect(amended.code).toBe(0);
  expect(amended.stdout).toContain(`amends ${first.slice(0, 12)}`);
  expect(amended.stdout).toContain("already pushed (origin/feature/a)");
  expect(amended.stdout).toContain("workit git push --force-with-lease");
  const plain = await run(["git", "push", "--json"], repo.cwd);
  expect(plain.code).toBe(1);
  expect(plain.json().unblock).toBe("workit git push --force-with-lease");
  expect(plain.json().unblock).not.toContain("rebase");
  expect((await run(["git", "push", "--force-with-lease"], repo.cwd)).code).toBe(0);
  expect(repo.remoteTip("feature/a")).toBe(repo.git("rev-parse", "HEAD"));
});

test("Given a fresh feature branch whose HEAD is main's tip, When --amend is used, Then it is refused and nothing is rewritten", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  const head = repo.git("rev-parse", "HEAD");
  for (const argv of [
    ["git", "commit", "--amend", "-m", "feat: x", "--json"],
    ["git", "commit", "--amend", "--no-edit", "--json"],
  ]) {
    const result = await run(argv, repo.cwd);
    expect(result.code).toBe(3);
    expect(result.json().error).toStartWith("amend_shared_commit:");
    expect(result.json().error).toContain("main");
  }
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
  expect(repo.git("rev-parse", "main")).toBe(head);
});

test("Given a commit pushed only under another, unprotected name, When it is amended, Then the amend works and no forced push is suggested", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.git("push", "-q", "origin", "feature/a:refs/heads/backup");
  repo.git("fetch", "-q", "origin");
  const result = await run(["git", "commit", "--amend", "-m", "feat: a2"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("already pushed");
  expect(result.stdout).not.toContain("--force-with-lease");
});

test("Given a commit with a Refs trailer, When --amend -m gives a new message, Then the old trailers are carried over once", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  expect(
    (await run(["git", "commit", "-m", "feat: a", "-m", "Refs: WK-1", "--", "a.txt"], repo.cwd))
      .code,
  ).toBe(0);
  expect((await run(["git", "commit", "--amend", "-m", "feat: reworded"], repo.cwd)).code).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: reworded\n\nRefs: WK-1\nWorkit-Session: author-1",
  );
});

test("Given a body with a --- line, When committing, Then the trailer still lands at the end of the message", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const body = "Notes:\n---\nmore notes";
  expect(
    (await run(["git", "commit", "-m", "feat: a", "-m", body, "--", "a.txt"], repo.cwd)).code,
  ).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    `feat: a\n\n${body}\n\nWorkit-Session: author-1`,
  );
});

test("Given an empty commit, When it is amended without --allow-empty, Then the amend still works", async () => {
  const repo = setup();
  await onFeature(repo);
  expect(
    (await run(["git", "commit", "--allow-empty", "-m", "chore: retrigger"], repo.cwd)).code,
  ).toBe(0);
  const amended = await run(["git", "commit", "--amend", "-m", "chore: retrigger ci"], repo.cwd);
  expect(amended.code, amended.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%s")).toBe("chore: retrigger ci");
  expect(repo.git("rev-parse", "HEAD^{tree}")).toBe(repo.git("rev-parse", "HEAD~1^{tree}"));
});

// ---------------------------------------------------------------------------
// push advice after a raw amend

test("Given a branch pushed with raw git and then amended with raw git, When workit pushes, Then the advice is a lease on the observed tip, not fetch and rebase", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "feat: a");
  // Two commits pushed, then the older one is the tip of nothing: the rewrite
  // drops back one commit and amends, so the remote tip is only in the reflog.
  repo.write("b.txt", "b\n");
  repo.git("add", "b.txt");
  repo.git("commit", "-qm", "feat: b");
  repo.git("push", "-q", "origin", "feature/a");
  const pushed = repo.git("rev-parse", "HEAD");
  repo.git("reset", "-q", "--soft", "HEAD~1");
  repo.git("commit", "-q", "--amend", "-m", "feat: a and b");
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().error).toContain("was rewritten");
  expect(result.json().unblock).toBe(`workit git push --force-with-lease --expect ${pushed}`);
  const leased = await run(
    ["git", "push", "--force-with-lease", "--expect", pushed, "--json"],
    repo.cwd,
  );
  expect(leased.code).toBe(0);
  expect(repo.remoteTip("feature/a")).toBe(repo.git("rev-parse", "HEAD"));
});

test("Given a remote commit with the same patch as a local one (rebased elsewhere), When workit pushes, Then the advice names the equivalence but the lease guard still needs --overwrite-unintegrated", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "feat: a");
  repo.git("push", "-q", "origin", "feature/a");
  const remote = repo.git("rev-parse", "HEAD");
  // Rebuild the same change on a new base in a fresh branch name, then move
  // feature/a there without a reflog entry for the pushed commit.
  repo.git("switch", "-q", "-c", "rebuilt", "main");
  repo.write("c.txt", "c\n");
  repo.git("add", "c.txt");
  repo.git("commit", "-qm", "chore: base moved");
  repo.git("cherry-pick", remote);
  repo.git("branch", "-D", "feature/a");
  repo.git("branch", "-m", "feature/a");
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().error).toContain("patch-equivalent");
  expect(result.json().unblock).toStartWith(
    `workit git push --force-with-lease --expect ${remote} --overwrite-unintegrated`,
  );
  // Patch equivalence never satisfies the guard by itself.
  const guarded = await run(
    ["git", "push", "--force-with-lease", "--expect", remote, "--json"],
    repo.cwd,
  );
  expect(guarded.code).toBe(3);
  expect(guarded.json().error).toStartWith("lease_not_integrated:");
  expect(repo.remoteTip("feature/a")).toBe(remote);
  const forced = await run(
    ["git", "push", "--force-with-lease", "--expect", remote, "--overwrite-unintegrated"],
    repo.cwd,
  );
  expect(forced.code).toBe(0);
  expect(repo.remoteTip("feature/a")).toBe(repo.git("rev-parse", "HEAD"));
});

/** A second clone of the remote with its own identity (another developer). */
const clone = (repo: RemoteRepo, name: string) => {
  const dir = path.join(repo.root, name);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  expect(spawnSync("git", ["clone", "-q", repo.bare, dir]).status).toBe(0);
  git("config", "user.name", name);
  git("config", "user.email", `${name}@t`);
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(repo.root, "no-hooks"));
  return { dir, git };
};

test("Given Bob merged main into the pushed branch and added a fix in the merge commit, When the local rebased branch is pushed, Then it is not called a rewrite and a lease without --overwrite-unintegrated is refused", async () => {
  const repo = setup();
  await onFeature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  repo.pushFromElsewhere("main", "m.txt");
  const bob = clone(repo, "bob");
  bob.git("switch", "-q", "feature/a");
  bob.git("merge", "-q", "--no-ff", "--no-commit", "origin/main");
  writeFileSync(path.join(bob.dir, "bobfix.txt"), "bob\n");
  bob.git("add", "bobfix.txt");
  bob.git("commit", "-qm", "Merge main into feature/a");
  bob.git("push", "-q", "origin", "feature/a");
  const bobTip = bob.git("rev-parse", "HEAD");

  repo.git("fetch", "-q", "origin");
  repo.git("rebase", "-q", "origin/main");
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().error).not.toContain("rewritten");
  expect(result.json().error).not.toContain("patch-equivalent");
  expect(result.json().unblock).toStartWith("git fetch origin && git rebase origin/feature/a");
  const leased = await run(
    ["git", "push", "--force-with-lease", "--expect", bobTip, "--json"],
    repo.cwd,
  );
  expect(leased.code).toBe(3);
  expect(leased.json().error).toStartWith("lease_not_integrated:");
  expect(repo.remoteTip("feature/a")).toBe(bobTip);
  expect(repo.git("show", "--name-only", "--format=", bobTip)).toBe("bobfix.txt");
});

test("Given someone else pushed to the branch, When workit pushes, Then the advice is still to fetch and integrate", async () => {
  const repo = setup();
  await onFeature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  repo.pushFromElsewhere("feature/a");
  repo.write("b.txt", "b\n");
  expect((await run(["git", "commit", "-m", "feat: b", "--", "b.txt"], repo.cwd)).code).toBe(0);
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().unblock).toStartWith("git fetch origin && git rebase origin/feature/a");
});

// ---------------------------------------------------------------------------
// --allow-empty and nothing to commit

test("Given a clean tree, When committing without --allow-empty, Then it is refused naming --allow-empty; with it, an empty commit is recorded", async () => {
  const repo = setup();
  const head = await onFeature(repo);
  const refused = await run(["git", "commit", "-m", "chore: retrigger", "--json"], repo.cwd);
  expect(refused.code).toBe(1);
  expect(refused.json().error).toBe("nothing_to_commit: the working tree is clean");
  expect(refused.json().unblock).toContain("--allow-empty");
  const all = await run(["git", "commit", "-m", "chore: x", "--all", "--json"], repo.cwd);
  expect(all.json().error).toBe("nothing_to_commit: the working tree is clean");
  const unchanged = await run(
    ["git", "commit", "-m", "chore: x", "--json", "--", "a.txt"],
    repo.cwd,
  );
  expect(unchanged.json().error).toBe("nothing_to_commit: a.txt has no change to commit");
  expect(repo.git("rev-parse", "HEAD")).toBe(head);

  const empty = await run(["git", "commit", "--allow-empty", "-m", "chore: retrigger"], repo.cwd);
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain("(empty commit)");
  expect(repo.git("rev-parse", "HEAD~1")).toBe(head);
  expect(repo.git("rev-parse", "HEAD^{tree}")).toBe(repo.git("rev-parse", "HEAD~1^{tree}"));
  expect(repo.git("log", "-1", "--format=%B")).toBe("chore: retrigger\n\nWorkit-Session: author-1");
});

test("Given unrelated dirt and nothing staged, When committing with --allow-empty, Then the commit is empty and the dirt stays", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.write("unrelated.txt", "x\n");
  const result = await run(
    ["git", "commit", "--allow-empty", "-m", "chore: retrigger", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ files: [], leftDirty: 1 });
  expect(repo.git("status", "--porcelain")).toBe("?? unrelated.txt");
});

// ---------------------------------------------------------------------------
// -F

test("Given a message file, When committing with -F, Then its subject is linted and its body kept", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const file = path.join(repo.root, "msg.txt");
  writeFileSync(file, "feat: from a file\n\nLine one.\nLine two.\n");
  const result = await run(["git", "commit", "-F", file, "--", "a.txt"], repo.cwd);
  expect(result.code).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: from a file\n\nLine one.\nLine two.\n\nWorkit-Session: author-1",
  );
  writeFileSync(file, "no convention here\n");
  repo.write("b.txt", "b\n");
  expect((await run(["git", "commit", `--file=${file}`, "--", "b.txt"], repo.cwd)).code).toBe(3);
  const missing = await run(["git", "commit", "-F", "nope.txt", "--", "b.txt"], repo.cwd);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("cannot read -F nope.txt");
  expect(
    (await run(["git", "commit", "-F", file, "-m", "feat: b", "--", "b.txt"], repo.cwd)).code,
  ).toBe(2);
});

test("Given a message on stdin, When the CLI runs `git commit -F -`, Then the commit carries it", () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const result = spawnSync(process.execPath, [CLI, "git", "commit", "-F", "-", "--", "a.txt"], {
    cwd: repo.cwd,
    input: "feat: from stdin\n\nPiped body.\n",
    encoding: "utf8",
    env: { ...SESSION, WORKFLOW_TOOLKIT_CONFIG: configHome.configDir },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: from stdin\n\nPiped body.\n\nWorkit-Session: author-1",
  );
});

// ---------------------------------------------------------------------------
// operations in progress

const conflict = (repo: RemoteRepo) => {
  repo.git("switch", "-q", "-c", "feature/other");
  repo.write("same.txt", "theirs\n");
  repo.git("add", "same.txt");
  repo.git("commit", "-qm", "feat: theirs");
  repo.git("switch", "-q", "-c", "feature/a", "main");
  repo.write("same.txt", "ours\n");
  repo.git("add", "same.txt");
  repo.git("commit", "-qm", "feat: ours");
  return repo.git("rev-parse", "feature/other");
};

const refusesWith = async (repo: RemoteRepo, code: string, command: string) => {
  repo.write("x.txt", "x\n");
  for (const argv of [
    ["git", "commit", "-m", "feat: x", "--json", "--", "x.txt"],
    ["git", "branch", "feature/z", "--base", "main", "--json"],
  ]) {
    const result = await run(argv, repo.cwd);
    expect(result.code, argv.join(" ")).toBe(3);
    expect(result.json().error).toStartWith(`${code}:`);
    expect(result.json().error).not.toContain("detached");
    expect(result.json().unblock).toContain(`${command} --continue`);
    expect(result.json().unblock).toContain(`${command} --abort`);
  }
};

test("Given a conflicted rebase, When committing, branching or pushing, Then workit says a rebase is in progress and how to continue or abort", async () => {
  const repo = setup();
  const other = conflict(repo);
  expect(spawnSync("git", ["rebase", other], { cwd: repo.cwd }).status).not.toBe(0);
  await refusesWith(repo, "rebase_in_progress", "git rebase");
  const push = await run(["git", "push", "--json"], repo.cwd);
  expect(push.code).toBe(3);
  expect(push.json().error).toStartWith("rebase_in_progress:");
});

test("Given a conflicted merge, When committing, Then workit says a merge is in progress", async () => {
  const repo = setup();
  const other = conflict(repo);
  expect(spawnSync("git", ["merge", "--no-edit", other], { cwd: repo.cwd }).status).not.toBe(0);
  await refusesWith(repo, "merge_in_progress", "git merge");
});

test("Given a conflicted cherry-pick, When committing, Then workit says a cherry-pick is in progress", async () => {
  const repo = setup();
  const other = conflict(repo);
  expect(spawnSync("git", ["cherry-pick", other], { cwd: repo.cwd }).status).not.toBe(0);
  await refusesWith(repo, "cherry_pick_in_progress", "git cherry-pick");
});

test("Given a conflicted revert, When committing, Then workit says a revert is in progress", async () => {
  const repo = setup();
  conflict(repo);
  repo.write("same.txt", "ours again\n");
  repo.git("commit", "-qam", "feat: again");
  expect(spawnSync("git", ["revert", "--no-edit", "HEAD~1"], { cwd: repo.cwd }).status).not.toBe(0);
  await refusesWith(repo, "revert_in_progress", "git revert");
});

test("Given git revert --no-commit, When committing, Then the revert is recorded; branch and push stay refused until then", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.git("revert", "--no-commit", "HEAD");
  for (const argv of [
    ["git", "push", "--json"],
    ["git", "branch", "feature/z", "--json"],
  ]) {
    const refused = await run(argv, repo.cwd);
    expect(refused.code, argv.join(" ")).toBe(3);
    expect(refused.json().error).toStartWith("revert_in_progress:");
  }
  const result = await run(["git", "commit", "-m", "fix: undo a", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ branch: "feature/a", files: ["a.txt"] });
  expect(
    spawnSync("git", ["rev-parse", "-q", "--verify", "REVERT_HEAD"], { cwd: repo.cwd }).status,
  ).not.toBe(0);
});

test("Given an interactive rebase stopped at edit, When the commit is amended, Then it is recorded for the rebased branch and the rebase continues", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.write("b.txt", "b\n");
  expect((await run(["git", "commit", "-m", "feat: b", "--", "b.txt"], repo.cwd)).code).toBe(0);
  const stopped = spawnSync("git", ["rebase", "-i", "HEAD~2"], {
    cwd: repo.cwd,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i 1s/^pick/edit/" },
  });
  expect(stopped.status).toBe(0);
  for (const argv of [
    ["git", "push", "--json"],
    ["git", "branch", "feature/z", "--base", "main", "--json"],
  ]) {
    const refused = await run(argv, repo.cwd);
    expect(refused.code, argv.join(" ")).toBe(3);
    expect(refused.json().error).toStartWith("rebase_in_progress:");
  }
  const amended = await run(
    ["git", "commit", "--amend", "-m", "feat: a edited", "--json"],
    repo.cwd,
  );
  expect(amended.code, amended.stdout).toBe(0);
  expect(amended.json().data.branch).toBe("feature/a");
  repo.git("rebase", "--continue");
  expect(repo.git("log", "--format=%s", "origin/main..feature/a")).toBe("feat: b\nfeat: a edited");
});

test("Given a conflict-free git merge --no-commit, When committing, Then the merge commit is recorded; branch and push stay refused until then", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.pushFromElsewhere("main", "m.txt");
  repo.git("fetch", "-q", "origin");
  repo.git("merge", "-q", "--no-ff", "--no-commit", "origin/main");
  for (const argv of [
    ["git", "push", "--json"],
    ["git", "branch", "feature/z", "--json"],
  ]) {
    const refused = await run(argv, repo.cwd);
    expect(refused.code, argv.join(" ")).toBe(3);
    expect(refused.json().error).toStartWith("merge_in_progress:");
  }
  const result = await run(["git", "commit", "-m", "chore: merge main", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ branch: "feature/a", files: ["m.txt"] });
  expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  expect(
    spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repo.cwd }).status,
  ).not.toBe(0);
});

test("Given a path already deleted and staged with git rm, When it is committed by path, Then the deletion is committed", async () => {
  const repo = setup();
  await onFeature(repo);
  repo.write("b.txt", "b\n");
  expect((await run(["git", "commit", "-m", "feat: b", "--", "b.txt"], repo.cwd)).code).toBe(0);
  repo.git("rm", "-q", "a.txt");
  repo.write("b.txt", "b2\n");
  const result = await run(
    ["git", "commit", "-m", "feat: drop a", "--json", "--", "a.txt", "b.txt"],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(repo.git("show", "--name-status", "--format=", "HEAD")).toBe("D\ta.txt\nM\tb.txt");
  expect(repo.git("status", "--porcelain")).toBe("");
});

// ---------------------------------------------------------------------------
// hook output

test("Given a pre-commit hook that prints 50 lint errors and fails, When committing, Then every line reaches the agent", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  hook(
    repo,
    "pre-commit",
    'i=1; while [ $i -le 50 ]; do echo "src/a.ts:$i: lint error $i" >&2; i=$((i+1)); done; exit 1',
  );
  repo.write("a.txt", "a\n");
  const result = await run(["git", "commit", "-m", "feat: a", "--", "a.txt"], repo.cwd);
  expect(result.code).toBe(1);
  for (const line of [1, 2, 25, 49, 50])
    expect(result.stderr).toContain(`src/a.ts:${line}: lint error ${line}\n`);
  expect(result.stderr.match(/lint error/gu)).toHaveLength(50);
});

test("Given a hook that prints 250 lines, When committing, Then the head and tail are kept and the middle is counted", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  hook(
    repo,
    "pre-commit",
    'i=1; while [ $i -le 250 ]; do echo "line $i"; i=$((i+1)); done; exit 1',
  );
  repo.write("a.txt", "a\n");
  const result = await run(["git", "commit", "-m", "feat: a", "--json", "--", "a.txt"], repo.cwd);
  const error: string = result.json().error;
  expect(error).toContain("line 1\n");
  expect(error).toContain("line 100\n");
  expect(error).toContain("… 50 lines omitted …");
  expect(error).not.toContain("line 125\n");
  expect(error).toContain("line 151\n");
  expect(error).toEndWith("line 250");
});

test("Given a hook that prints one 3000-character line, When committing, Then the line is cut at 1000 characters", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  hook(repo, "pre-commit", "head -c 3000 /dev/zero | tr '\\0' x; echo; exit 1");
  repo.write("a.txt", "a\n");
  const result = await run(["git", "commit", "-m", "feat: a", "--json", "--", "a.txt"], repo.cwd);
  const error: string = result.json().error;
  expect(error).toContain(`${"x".repeat(1000)}…`);
  expect(error).not.toContain("x".repeat(1001));
});

test("Given a pre-push hook that fails with 10 lines, When pushing, Then all of them are reported", async () => {
  const repo = setup();
  await onFeature(repo);
  hook(
    repo,
    "pre-push",
    'i=1; while [ $i -le 10 ]; do echo "check $i failed" >&2; i=$((i+1)); done; exit 1',
  );
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  for (let line = 1; line <= 10; line += 1)
    expect(result.json().error).toContain(`check ${line} failed`);
  expect(repo.remoteTip("feature/a")).toBeNull();
});

// ---------------------------------------------------------------------------
// branch policy without config

test("Given no workit config and a main-only repository, When creating a branch, Then it branches from main and main stays protected", async () => {
  const repo = setup(null);
  const result = await run(["git", "branch", "feature/one", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    branch: "feature/one",
    base: "main",
    baseRef: "refs/remotes/origin/main",
  });
  // github-flow names are free-form, but protection is never weaker than the old default.
  expect((await run(["git", "branch", "wip-x"], repo.cwd)).code).toBe(0);
  repo.git("switch", "-q", "main");
  repo.write("a.txt", "a\n");
  const onMain = await run(["git", "commit", "-m", "feat: a", "--json", "--", "a.txt"], repo.cwd);
  expect(onMain.code).toBe(3);
  expect(onMain.json().error).toContain("protected_branch: main");
});

test("Given no workit config and a remote develop branch, When creating a branch, Then gitflow applies and develop is the base", async () => {
  const repo = setup(null);
  repo.git("push", "-q", "origin", "main:develop");
  repo.git("fetch", "-q", "origin");
  const result = await run(["git", "branch", "feature/one", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    base: "develop",
    baseRef: "refs/remotes/origin/develop",
  });
  expect((await run(["git", "branch", "wip-x"], repo.cwd)).code).toBe(3);
});

test("Given a configured gitflow policy in a main-only repository, When creating a branch, Then the configuration still wins", async () => {
  const repo = setup({ branchPolicy: { preset: "gitflow" } });
  const result = await run(["git", "branch", "feature/one", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().error).toContain("base develop does not resolve");
});

test("Given no workit config and develop only on a non-origin remote, When creating a branch, Then the fork's develop does not make it gitflow", async () => {
  const repo = setup(null);
  const fork = path.join(repo.root, "fork.git");
  expect(spawnSync("git", ["init", "-q", "--bare", fork]).status).toBe(0);
  repo.git("remote", "add", "fork", fork);
  repo.git("push", "-q", "fork", "main:develop");
  repo.git("fetch", "-q", "fork");
  const result = await run(["git", "branch", "feature/one", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.base).toBe("main");
});

test("Given no workit config, When doctor runs in a main-only repository, Then it reports the detected preset; a configured one is shown plainly", () => {
  const repo = setup(null);
  const doctor = () =>
    runDoctor({
      cwd: repo.cwd,
      home: configHome.home,
      configDir: configHome.configDir,
      stateDir: path.join(repo.root, "state"),
      env: { ...process.env, WORKFLOW_TOOLKIT_CONFIG: configHome.configDir },
    }).checks.find((check) => check.id === "workspace_mismatch")?.detail;
  expect(doctor()).toContain("preset: detected (github-flow)");
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  expect(doctor()).toContain("preset: gitflow");
  expect(doctor()).not.toContain("detected");
});
