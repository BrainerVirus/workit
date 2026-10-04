import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireGrant, resolveAutonomy } from "@/packages/workit-core/src/autonomy";
import { buildBody, prBodyFor } from "@/packages/workit-core/src/forge/pr-body";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { createGitLabForge } from "@/packages/workit-core/src/forge/gitlab";
import { parsePackageSpec, systemNpm } from "@/packages/workit-core/src/forge/verify";
import { deleteRemoteBranch, lintCommitMessage } from "@/packages/workit-core/src/git/ops";
import { remoteRefTip } from "@/packages/workit-core/src/git/rev";
import { replayRunner, replyError } from "@/test/shared/helpers/forge-replay";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// S11 core pieces: the grant seam, forge writes, lease-guarded deletion,
// remote tag tips and the PR body.

setDefaultTimeout(60_000);

let configDir = "";
const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
beforeAll(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), "wk-delivery-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG = configDir;
});
afterAll(() => {
  if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
  rmSync(configDir, { recursive: true, force: true });
});
const repos: RemoteRepo[] = [];
afterEach(() => {
  rmSync(path.join(configDir, "workspaces.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const workspaceAt = (root: string, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

test("requireGrant: absent grants fall back to host authority; explicit values are honored", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-grant-"));
  const cwd = path.join(root, "repo");
  try {
    // No workspace at all: host authority, and a merge still needs a verdict.
    expect(requireGrant(cwd, "merge")).toEqual({
      allowed: true,
      kind: "merge",
      source: "host_authority",
      requireVerdict: true,
      workspace: null,
    });
    expect(requireGrant(cwd, "push")).toMatchObject({ allowed: true, requireVerdict: false });

    workspaceAt(root, {
      vcs: { provider: "github", account: "me" },
      autonomy: { push: true, pr: true, merge: "verified", release: false, bogus: 1 },
    });
    expect(resolveAutonomy(cwd)).toEqual({
      workspace: "w",
      grants: { push: true, pr: true, merge: "verified", release: false },
      source: "autonomy",
      accountConfigured: true,
    });
    expect(requireGrant(cwd, "merge")).toMatchObject({
      allowed: true,
      source: "autonomy",
      requireVerdict: true,
    });
    expect(requireGrant(cwd, "release")).toMatchObject({
      allowed: false,
      reason: "grant_required",
    });

    workspaceAt(root, { vcs: { provider: "github", account: "me" }, autonomy: { merge: true } });
    expect(requireGrant(cwd, "merge")).toMatchObject({ allowed: true, requireVerdict: false });
    // Only merge is configured; push falls back to host authority.
    expect(requireGrant(cwd, "push")).toMatchObject({ allowed: true, source: "host_authority" });

    // Grants without an account: forge effects are blocked, local ones are not.
    workspaceAt(root, { vcs: { provider: "github" }, autonomy: { push: true } });
    expect(requireGrant(cwd, "push")).toMatchObject({ allowed: false, reason: "account_required" });
    expect(requireGrant(cwd, "push", { forge: false })).toMatchObject({ allowed: true });

    writeFileSync(path.join(configDir, "workspaces.json"), "{not json");
    expect(requireGrant(cwd, "pr")).toMatchObject({ allowed: false, reason: "config_invalid" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub createPr/merge/updateBase send the documented REST calls; a fork head is owner:branch", () => {
  const runner = replayRunner({
    "POST repos/o/r/pulls": JSON.stringify({
      number: 5,
      html_url: "https://github.com/o/r/pull/5",
      state: "open",
      head: { ref: "feature/x", sha: "a".repeat(40) },
    }),
    "PUT repos/o/r/pulls/5/merge": JSON.stringify({ sha: "b".repeat(40), merged: true }),
    "PATCH repos/o/r/pulls/5": "{}",
  });
  const forge = createGitHubForge({ apiHost: "github.com", repo: "o/r", runner });
  const created = forge.createPr({
    head: "feature/x",
    headRepo: "forker/r",
    headProjectId: null,
    base: "main",
    title: "feat: x",
    body: "@body is literal",
    draft: true,
  });
  expect(created).toEqual({
    ok: true,
    data: {
      number: 5,
      url: "https://github.com/o/r/pull/5",
      state: "open",
      headBranch: "feature/x",
      headSha: "a".repeat(40),
    },
  });
  expect(runner.calls[0]?.vars).toEqual({
    title: "feat: x",
    head: "forker:feature/x",
    base: "main",
    body: "@body is literal",
    draft: "true",
  });
  expect(forge.merge(5, { sha: "a".repeat(40), method: "rebase" })).toEqual({
    ok: true,
    data: { mergeSha: "b".repeat(40) },
  });
  expect(runner.calls[1]?.vars).toEqual({ sha: "a".repeat(40), merge_method: "rebase" });
  expect(forge.updateBase(5, "develop")).toEqual({ ok: true, data: undefined });
  expect(runner.calls[2]).toMatchObject({ method: "PATCH", vars: { base: "develop" } });
});

test("forge writes: 409 is head_moved, 405/422 are forge refusals, auth is unavailable", () => {
  const forgeWith = (reply: ReturnType<typeof replyError>) =>
    createGitHubForge({
      apiHost: "github.com",
      repo: "o/r",
      runner: replayRunner({ "PUT repos/o/r/pulls/5/merge": reply, "POST repos/o/r/pulls": reply }),
    });
  const moved = forgeWith(replyError("gh: Head branch was modified. (HTTP 409)")).merge(5, {
    sha: "a".repeat(40),
    method: "squash",
  });
  expect(moved).toMatchObject({ ok: false, code: "blocked" });
  expect(!moved.ok && moved.error).toContain("head_moved");
  const refused = forgeWith(replyError("gh: Pull Request is not mergeable (HTTP 405)")).merge(5, {
    sha: "a".repeat(40),
    method: "squash",
  });
  expect(refused).toMatchObject({ ok: false, code: "blocked" });
  const exists = forgeWith(
    replyError(
      "gh: Validation Failed: A pull request already exists (HTTP 422) token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ),
  ).createPr({
    head: "x",
    headRepo: "o/r",
    headProjectId: null,
    base: "main",
    title: "t",
    body: "",
    draft: false,
  });
  expect(exists).toMatchObject({ ok: false, code: "blocked" });
  expect(!exists.ok && exists.error).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  const auth = forgeWith(replyError("HTTP 401: Bad credentials")).merge(5, {
    sha: "a".repeat(40),
    method: "squash",
  });
  expect(auth).toMatchObject({ ok: false, code: "unavailable" });
});

test("GitLab createPr from a fork posts to the source project with target_project_id", () => {
  const runner = replayRunner({
    "GET projects/group%2Fproject": JSON.stringify({ id: 7 }),
    "POST projects/99/merge_requests": JSON.stringify({
      iid: 3,
      web_url: "https://gitlab.com/group/project/-/merge_requests/3",
      state: "opened",
      source_branch: "feature/x",
      sha: "c".repeat(40),
    }),
    "PUT projects/group%2Fproject/merge_requests/3": "{}",
  });
  const forge = createGitLabForge({ apiHost: "gitlab.com", repo: "group/project", runner });
  const created = forge.createPr({
    head: "feature/x",
    headRepo: "me/project",
    headProjectId: 99,
    base: "main",
    title: "Draft: feat: x",
    body: "b",
    draft: true,
  });
  expect(created).toMatchObject({ ok: true, data: { number: 3, headSha: "c".repeat(40) } });
  expect(runner.calls[1]?.vars).toEqual({
    source_branch: "feature/x",
    target_branch: "main",
    title: "Draft: feat: x",
    description: "b",
    target_project_id: "7",
  });
  expect(forge.updateBase(3, "develop")).toMatchObject({ ok: true });
  expect(runner.calls[2]?.vars).toEqual({ target_branch: "develop" });
});

test("deleteRemoteBranch deletes only while the remote tip is the expected one", () => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write("a.txt", "a\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat: a");
  repo.git("push", "-q", "origin", "feature/a");
  const mine = repo.git("rev-parse", "HEAD");
  const theirs = repo.pushFromElsewhere("feature/a");
  expect(deleteRemoteBranch(repo.cwd, "origin", "feature/a", mine)).toEqual({
    ok: false,
    lease: true,
    error: "the remote branch tip changed before deletion",
  });
  expect(repo.remoteTip("feature/a")).toBe(theirs);
  expect(deleteRemoteBranch(repo.cwd, "origin", "feature/a", theirs)).toEqual({ ok: true });
  expect(repo.remoteTip("feature/a")).toBeNull();
  // A protected branch (gitflow default: develop) is never deleted, whatever the lease says.
  repo.git("push", "-q", "origin", "main:refs/heads/develop");
  const develop = repo.remoteTip("develop") as string;
  expect(deleteRemoteBranch(repo.cwd, "origin", "develop", develop)).toMatchObject({
    ok: false,
    lease: false,
  });
  expect(repo.remoteTip("develop")).toBe(develop);
  expect(deleteRemoteBranch(repo.cwd, "--upload-pack=x", "feature/a", theirs)).toMatchObject({
    ok: false,
    lease: false,
  });
});

test("remoteRefTip peels annotated tags and reports a missing ref as null", () => {
  const repo = makeRemoteRepo();
  repos.push(repo);
  const head = repo.git("rev-parse", "HEAD");
  repo.git("tag", "-a", "v1.0.0", "-m", "release");
  repo.git("push", "-q", "origin", "v1.0.0");
  expect(remoteRefTip(repo.cwd, "origin", "refs/tags/v1.0.0")).toEqual({ ok: true, sha: head });
  expect(remoteRefTip(repo.cwd, "origin", "refs/tags/v9")).toEqual({ ok: true, sha: null });
  expect(remoteRefTip(repo.cwd, "origin", "-x")).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
});

test("PR body: issue linking follows the workspace (GitHub link_on_pr derives the issue from the branch)", () => {
  expect(buildBody("text", "feature/42-login", false, "", "", true, "", "closes", "o/r")).toBe(
    "text\n\nCloses #42",
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-body-"));
  try {
    expect(prBodyFor(root, { body: "plain", branch: "feature/42-x", repo: "o/r" })).toBe("plain");
    workspaceAt(root, {
      vcs: { provider: "github" },
      issues: { provider: "github", link_on_pr: true },
    });
    expect(prBodyFor(root, { body: "plain", branch: "feature/42-x", repo: "o/r" })).toBe(
      "plain\n\nCloses #42",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit lint and package specs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-lint-"));
  try {
    expect(lintCommitMessage(root, "feat(cli): add verbs")).toEqual({ ok: true });
    expect(lintCommitMessage(root, "add verbs")).toMatchObject({ ok: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(parsePackageSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  expect(parsePackageSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", version: null });
  expect(parsePackageSpec("pkg@2")).toBeNull();
  expect(parsePackageSpec("--registry")).toBeNull();
  expect(parsePackageSpec("pkg@1.0.0&calc")).toBeNull();
  // Legacy upper-case names are looked up, not refused.
  expect(parsePackageSpec("JSONStream@1.3.5")).toEqual({ name: "JSONStream", version: "1.3.5" });
  expect(parsePackageSpec("pkg@1.0.0-rc.1+build.5")).toEqual({
    name: "pkg",
    version: "1.0.0-rc.1+build.5",
  });
  // The runner itself refuses any argument with shell syntax, whatever the caller passed.
  expect(systemNpm(["view", "pkg@1.0.0&calc"])).toEqual({
    status: 2,
    stdout: "",
    stderr: "refused: unsafe npm argument",
  });
});
