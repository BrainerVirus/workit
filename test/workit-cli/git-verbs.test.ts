import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { fixture, replayRunner, replyError } from "@/test/shared/helpers/forge-replay";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// S11 `workit git branch|commit|push` and `verify-delivery push` against real
// git: a temp checkout whose origin is a local bare repository.

setDefaultTimeout(60_000);

let configDir = "";
const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
const original = { ...forgeDeps };
const GITHUB_FLOW = {
  branchPolicy: { preset: "github-flow" },
  commitPolicy: { preset: "conventional" },
};
beforeAll(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), "wk-git-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
});
afterAll(() => {
  if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
  rmSync(configDir, { recursive: true, force: true });
});

const repos: RemoteRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = (config: Record<string, unknown> = GITHUB_FLOW, subjects?: string[]): RemoteRepo => {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
  const repo = makeRemoteRepo(subjects);
  repos.push(repo);
  return repo;
};

const workspace = (repo: RemoteRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

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

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

// ---------------------------------------------------------------------------
// branch

test("git branch: given a policy-valid name, then it branches from the freshly fetched default target", async () => {
  const repo = setup();
  // origin/main moved since the last fetch; the stale local main must not be the base.
  const upstream = repo.pushFromElsewhere("main");
  const result = await run(["git", "branch", "feature/a", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    branch: "feature/a",
    previous: "main",
    base: "main",
    baseRef: "refs/remotes/origin/main",
    baseSha: upstream,
    carried: false,
  });
  expect(repo.git("branch", "--show-current")).toBe("feature/a");
  expect(repo.git("rev-parse", "HEAD")).toBe(upstream);
  // --no-track: the new branch never pushes to its base by accident.
  expect(() => repo.git("config", "branch.feature/a.merge")).toThrow();
});

test("git branch: protected and off-pattern names are blocked (exit 3) and nothing is created", async () => {
  const repo = setup({ branchPolicy: { preset: "gitflow" } });
  const protectedName = await run(
    ["git", "branch", "develop", "--base", "main", "--json"],
    repo.cwd,
  );
  expect(protectedName.code).toBe(3);
  expect(protectedName.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(protectedName.json().error).toContain("protected_ref");
  const offPattern = await run(["git", "branch", "wip-x", "--base", "main"], repo.cwd);
  expect(offPattern.code).toBe(3);
  expect(offPattern.stderr).toContain("allowed_pattern");
  expect(offPattern.stderr).toContain("unblock: choose a branch matching one of");
  expect(repo.git("branch", "--list")).toBe("* main");
  // --kind/--slug compose the same checked name.
  const composed = await run(
    ["git", "branch", "--kind", "bugfix", "--slug", "login", "--base", "main"],
    repo.cwd,
  );
  expect(composed.code).toBe(0);
  expect(repo.git("branch", "--show-current")).toBe("bugfix/login");
  expect((await run(["git", "branch", "--kind", "chore", "--slug", "x"], repo.cwd)).code).toBe(2);
});

test("git branch: tracked dirt needs --carry; an existing branch or a local stack parent", async () => {
  const repo = setup();
  repo.write("base-0.txt", "changed\n");
  const dirty = await run(["git", "branch", "feature/a", "--json"], repo.cwd);
  expect(dirty.code).toBe(3);
  expect(dirty.json().error).toContain("dirty_worktree");
  const carried = await run(["git", "branch", "feature/a", "--carry", "--json"], repo.cwd);
  expect(carried.code).toBe(0);
  expect(carried.json().data.carried).toBe(true);
  expect(repo.git("status", "--porcelain")).toBe("M base-0.txt");
  repo.git("commit", "-qam", "feat: a");
  const stacked = await run(
    ["git", "branch", "feature/b", "--base", "feature/a", "--json"],
    repo.cwd,
  );
  expect(stacked.json().data).toMatchObject({
    base: "feature/a",
    baseRef: "refs/heads/feature/a",
    baseSha: repo.git("rev-parse", "feature/a"),
  });
  const again = await run(["git", "branch", "feature/a"], repo.cwd);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("branch_exists");
  expect(again.stderr).toContain("unblock: git switch feature/a");
});

// ---------------------------------------------------------------------------
// commit

test("git commit: the configured convention gates the subject (exit 3, nothing committed)", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const head = repo.git("rev-parse", "HEAD");
  const bad = await run(["git", "commit", "--json", "-m", "added stuff", "--", "a.txt"], repo.cwd);
  expect(bad.code).toBe(3);
  expect(bad.json()).toMatchObject({
    code: "blocked",
    unblock: "use a conventional commit subject",
  });
  expect(bad.json().error).toContain("commit_style");
  expect(repo.git("rev-parse", "HEAD")).toBe(head);
});

test("git commit: commitPolicy auto follows the flavor the history uses", async () => {
  const repo = setup({ ...GITHUB_FLOW, commitPolicy: { preset: "auto" } }, [
    "feat: one",
    "fix: two",
    "chore: three",
  ]);
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const bad = await run(["git", "commit", "-m", "Added a", "--", "a.txt"], repo.cwd);
  expect(bad.code).toBe(3);
  expect(bad.stderr).toContain("does not follow the conventional style this repository uses");
  expect((await run(["git", "commit", "-m", "feat: add a", "--", "a.txt"], repo.cwd)).code).toBe(0);
});

test("git commit: unrelated dirt is never swept in; paths commit only themselves", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("mine.txt", "mine\n");
  repo.write("unrelated.txt", "not mine\n");
  repo.write("staged-by-someone.txt", "staged\n");
  repo.git("add", "staged-by-someone.txt");
  repo.git("reset", "-q");
  const nothing = await run(["git", "commit", "-m", "feat: mine", "--json"], repo.cwd);
  expect(nothing.code).toBe(3);
  expect(nothing.json().error).toContain("nothing_staged");
  expect(nothing.json().unblock).toContain("-- <paths>");

  repo.git("add", "staged-by-someone.txt");
  const result = await run(
    ["git", "commit", "--json", "-m", "feat: mine", "--", "mine.txt"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  const data = result.json().data;
  expect(data).toMatchObject({ branch: "feature/a", files: ["mine.txt"], session: "author-1" });
  expect(data.leftDirty).toBe(2);
  expect(repo.git("show", "--name-only", "--format=", "HEAD")).toBe("mine.txt");
  // The pre-staged file stays staged and uncommitted.
  expect(repo.git("diff", "--cached", "--name-only")).toBe("staged-by-someone.txt");

  // --all is the explicit opt-in for everything.
  const all = await run(["git", "commit", "-m", "chore: rest", "--all", "--json"], repo.cwd);
  expect(all.json().data.files.toSorted()).toEqual(["staged-by-someone.txt", "unrelated.txt"]);
  expect(repo.git("status", "--porcelain")).toBe("");
  const clean = await run(["git", "commit", "-m", "chore: none"], repo.cwd);
  expect(clean.code).toBe(1);
  expect(clean.stderr).toContain("nothing_to_commit");
});

test("git commit: the session goes into a Workit-Session trailer and an observed commit.recorded row", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  const result = await run(
    ["git", "commit", "-m", "feat: a", "-m", "Body text.", "--", "a.txt"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  const sha = repo.git("rev-parse", "HEAD");
  expect(repo.git("log", "-1", "--format=%B")).toBe(
    "feat: a\n\nBody text.\n\nWorkit-Session: author-1",
  );
  const recorded = rows(repo.cwd, "commit.recorded");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    observer: "workit_cli",
    branch: "feature/a",
    head: sha,
    session: "author-1",
    subject: "feat: a",
    files: ["a.txt"],
    actor: { session: "author-1" },
  });
  // The author check (D18) now refuses this session's own verdict.
  const own = await run(["ledger", "verdict", "verified", "--how", "ran it"], repo.cwd);
  expect(own.code).toBe(3);
  expect(own.stderr).toContain("author_verdict");

  // Without a session: no trailer, and the human output says so.
  repo.write("b.txt", "b\n");
  const env = { ...process.env };
  delete env.WORKIT_SESSION_ID;
  const anonymous = await run(["git", "commit", "-m", "feat: b", "--", "b.txt"], repo.cwd, env);
  expect(anonymous.stdout).toContain("WORKIT_SESSION_ID is unset");
  expect(repo.git("log", "-1", "--format=%B")).toBe("feat: b");
  const bad = await run(["git", "commit", "-m", "feat: c", "--all"], repo.cwd, {
    ...process.env,
    WORKIT_SESSION_ID: "a\nWorkit-Session: forged",
  });
  expect(bad.code).toBe(2);
});

test("git commit: a protected branch is refused (exit 3) with the branch command", async () => {
  const repo = setup();
  repo.write("a.txt", "a\n");
  const result = await run(["git", "commit", "-m", "feat: a", "--all", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("protected_branch: main");
  expect(result.json().unblock).toContain("workit git branch");
  expect(repo.git("status", "--porcelain")).toBe("?? a.txt");
  expect((await run(["git", "commit", "--all"], repo.cwd)).code).toBe(2);
  expect((await run(["git", "commit", "-m", "x", "--all", "a.txt"], repo.cwd)).code).toBe(2);
});

// ---------------------------------------------------------------------------
// push + verify-delivery

const feature = async (repo: RemoteRepo, file = "a.txt") => {
  if (repo.git("branch", "--show-current") !== "feature/a")
    repo.git("switch", "-q", "-c", "feature/a");
  repo.write(file, `${file}\n`);
  const result = await run(["git", "commit", "-m", `feat: ${file}`, "--", file], repo.cwd);
  expect(result.code).toBe(0);
  return repo.git("rev-parse", "HEAD");
};

test("git push: a protected branch is refused before any network call", async () => {
  const repo = setup();
  repo.write("a.txt", "a\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat: direct");
  const before = repo.remoteTip("main");
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("protected_branch: main");
  expect(repo.remoteTip("main")).toBe(before);
});

test("git push: given a push, then the remote tip is verified, recorded, and verify-delivery agrees", async () => {
  const repo = setup();
  const sha = await feature(repo);
  const pushed = await run(["git", "push", "--set-upstream", "--json"], repo.cwd);
  expect(pushed.code).toBe(0);
  expect(pushed.json().data).toMatchObject({
    remote: "origin",
    branch: "feature/a",
    sha,
    previous: null,
    pushed: true,
    forced: false,
    delivered: true,
    upstream: true,
  });
  expect(repo.remoteTip("feature/a")).toBe(sha);
  expect(repo.git("config", "branch.feature/a.merge")).toBe("refs/heads/feature/a");
  expect(rows(repo.cwd, "push.verified").at(-1)).toMatchObject({
    observer: "workit_cli",
    branch: "feature/a",
    head: sha,
    previous: null,
  });

  const verified = await run(["verify-delivery", "push", "--json"], repo.cwd);
  expect(verified.code).toBe(0);
  expect(verified.json().data).toMatchObject({
    expect: "pushed",
    delivered: true,
    observations: [{ kind: "remote_tip", expected: sha, observed: sha, ok: true }],
  });
  expect(rows(repo.cwd, "delivery.verified")).toHaveLength(1);
  const again = await run(["git", "push"], repo.cwd);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("already at");
});

test("verify-delivery: given a local-only commit, then it is NOT delivered (exit 1) and says how far behind the remote is", async () => {
  const repo = setup();
  const pushedSha = await feature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  const local = await feature(repo, "b.txt");
  const result = await run(["verify-delivery", "--expect", "pushed", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  const envelope = result.json();
  expect(envelope).toMatchObject({
    ok: false,
    code: "failed",
    unblock: "workit git push",
    data: {
      delivered: false,
      observations: [{ kind: "remote_tip", expected: local, observed: pushedSha, ok: false }],
    },
  });
  expect(envelope.error).toContain("1 local commit(s) not on origin/feature/a");
  expect(rows(repo.cwd, "delivery.verified")).toHaveLength(0);

  repo.git("switch", "-q", "-c", "feature/never");
  const never = await run(["verify-delivery", "push"], repo.cwd);
  expect(never.code).toBe(1);
  expect(never.stdout).toContain("x  remote_tip");
  expect(never.stderr).toContain("does not exist on");
  expect((await run(["verify-delivery", "push", "--sha", "zz"], repo.cwd)).code).toBe(2);
});

// POSIX shell hook in the bare remote.
test.skipIf(process.platform === "win32")(
  "git push: given a remote that does not end up at the pushed SHA, then push_unverified (exit 1), not delivered",
  async () => {
    const repo = setup();
    const base = repo.git("rev-parse", "main");
    await feature(repo);
    // A server-side hook moves the branch back after accepting the push.
    const hooks = path.join(repo.root, "bare-hooks");
    mkdirSync(hooks);
    writeFileSync(
      path.join(hooks, "post-receive"),
      `#!/bin/sh\ngit update-ref refs/heads/feature/a ${base}\n`,
      { mode: 0o755 },
    );
    spawnSync("git", ["config", "core.hooksPath", hooks], { cwd: repo.bare });
    const result = await run(["git", "push", "--json"], repo.cwd);
    expect(result.code).toBe(1);
    expect(result.json().error).toContain("push_unverified");
    expect(result.json().unblock).toBe("workit verify-delivery push");
    expect(rows(repo.cwd, "push.verified")).toHaveLength(0);
  },
);

test("git push: a rewrite needs --force-with-lease; plain --force is refused", async () => {
  const repo = setup();
  const first = await feature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  repo.git("commit", "-q", "--amend", "-m", "feat: amended");
  const amended = repo.git("rev-parse", "HEAD");
  const rejected = await run(["git", "push", "--json"], repo.cwd);
  expect(rejected.code).toBe(1);
  expect(rejected.json().error).toContain("non_fast_forward");
  expect(rejected.json().unblock).toContain("--force-with-lease");
  expect(repo.remoteTip("feature/a")).toBe(first);
  const force = await run(["git", "push", "--force", "--json"], repo.cwd);
  expect(force.code).toBe(2);
  expect(force.json().error).toContain("--force-with-lease");
  const leased = await run(["git", "push", "--force-with-lease", "--json"], repo.cwd);
  expect(leased.code).toBe(0);
  expect(leased.json().data).toMatchObject({ previous: first, sha: amended, forced: true });
  expect(repo.remoteTip("feature/a")).toBe(amended);
});

test("git push: --force-with-lease refuses when someone else pushed since workit recorded the tip", async () => {
  const repo = setup();
  await feature(repo);
  expect((await run(["git", "push"], repo.cwd)).code).toBe(0);
  const theirs = repo.pushFromElsewhere("feature/a");
  repo.git("commit", "-q", "--amend", "-m", "feat: mine again");
  const result = await run(["git", "push", "--force-with-lease", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("lease_mismatch");
  expect(result.json().unblock).toContain(`--expect ${theirs}`);
  expect(repo.remoteTip("feature/a")).toBe(theirs);
  // After review, an explicit --expect is the lease.
  const explicit = await run(["git", "push", "--force-with-lease", "--expect", theirs], repo.cwd);
  expect(explicit.code).toBe(0);
  expect(repo.remoteTip("feature/a")).toBe(repo.git("rev-parse", "HEAD"));
  expect((await run(["git", "push", "--expect", theirs], repo.cwd)).code).toBe(2);
});

// ---------------------------------------------------------------------------
// identity and grants (forge remote; nothing reaches the network)

const forgeRemote = (repo: RemoteRepo, kind: "github" | "gitlab") => {
  repo.git(
    "remote",
    "set-url",
    "--push",
    "origin",
    kind === "github" ? "https://github.com/o/r.git" : "https://gitlab.com/group/project.git",
  );
};

test("git push: given vcs.account=cpincetti but glab reports another user, then blocked with the glab auth unblock and nothing pushed", async () => {
  const repo = setup();
  await feature(repo);
  forgeRemote(repo, "gitlab");
  workspace(repo, { vcs: { provider: "gitlab", account: "cpincetti" } });
  const runner = replayRunner({
    "GET user": JSON.stringify({ id: 9, username: "other" }),
    "GET projects/group%2Fproject": fixture("gitlab/project.json"),
  });
  forgeDeps.runner = runner;
  const result = await run(["git", "push", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ ok: false, code: "blocked" });
  expect(result.json().error).toContain("identity_mismatch");
  expect(result.json().error).toContain("other");
  expect(result.json().unblock).toContain("glab auth login --hostname gitlab.com");
  expect(repo.remoteTip("feature/a")).toBeNull();
  expect(rows(repo.cwd, "push.verified")).toHaveLength(0);
});

test("git push: a workspace token is never printed, even when the forge echoes it back", async () => {
  const repo = setup();
  await feature(repo);
  forgeRemote(repo, "github");
  const token = "ghp_S3cretS3cretS3cretS3cretS3cret0000";
  const tokenFile = path.join(repo.root, "token");
  writeFileSync(tokenFile, `${token}\n`);
  workspace(repo, { vcs: { provider: "github", account: "octo", tokenFile } });
  const runner = replayRunner({
    "GET repos/o/r": fixture("github/repo.json"),
    "GET user": replyError(`gh: Bad credentials for token ${token} (HTTP 401)`),
  });
  forgeDeps.runner = runner;
  const json = await run(["git", "push", "--json"], repo.cwd);
  const human = await run(["git", "push"], repo.cwd);
  expect(json.code).toBe(5);
  expect(runner.calls.every((call) => call.token === token)).toBe(true);
  for (const output of [json.stdout, json.stderr, human.stdout, human.stderr])
    expect(output).not.toContain(token);
  expect(repo.remoteTip("feature/a")).toBeNull();
});

test("git push: an explicit push=false grant and a grant without an account are both blocked", async () => {
  const repo = setup();
  await feature(repo);
  workspace(repo, { vcs: { provider: "github" }, autonomy: { push: false } });
  const denied = await run(["git", "push", "--json"], repo.cwd);
  expect(denied.code).toBe(3);
  expect(denied.json()).toMatchObject({ code: "blocked", data: { reason: "grant_required" } });
  expect(denied.json().error).toBe('grant_required: push is not granted for workspace "w"');
  expect(repo.remoteTip("feature/a")).toBeNull();

  forgeRemote(repo, "github");
  workspace(repo, { vcs: { provider: "github" }, autonomy: { push: true } });
  forgeDeps.runner = replayRunner({
    "GET repos/o/r": fixture("github/repo.json"),
    "GET user": fixture("github/user.json"),
  });
  const accountless = await run(["git", "push", "--json"], repo.cwd);
  expect(accountless.code).toBe(3);
  expect(accountless.json()).toMatchObject({ data: { reason: "account_required" } });
});

test("git: usage errors exit 2 with the subcommand usage", async () => {
  const repo = setup();
  expect((await run(["git"], repo.cwd)).code).toBe(2);
  expect((await run(["git", "rebase"], repo.cwd)).code).toBe(2);
  expect((await run(["git", "branch"], repo.cwd)).code).toBe(2);
  expect((await run(["git", "push", "origin"], repo.cwd)).code).toBe(2);
  const help = await run(["help", "git"], repo.cwd);
  expect(help.stdout).toContain("usage: workit git branch <name>");
  expect(help.stdout).not.toContain("coming in");
  expect(readFileSync(path.join(configDir, "config.json"), "utf8")).toContain("github-flow");
});
