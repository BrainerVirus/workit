import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { readLedger } from "@/packages/workit-core/src/ledger";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  replyError,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// S11 `workit pr create|merge` and `verify-delivery pr|merged|released` over
// recorded GitHub/GitLab API shapes (fake gh/glab), on a checkout whose
// feature/x is pushed to a local bare remote and whose push URL is the forge.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-config-");
  configDir = configHome.configDir;
});
afterAll(() => {
  configHome.restore();
});

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
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

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const workspace = (repo: ForgeRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const setup = (kind: "github" | "gitlab", routes: Record<string, Reply>) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

const writes = (calls: readonly Call[]) =>
  calls.filter(
    (call) => call.method !== "GET" && call.method !== "CLI" && call.endpoint !== "graphql",
  );

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';
const githubBase = (): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
});

const GL = "projects/group%2Fproject";
const GL_FIND = `GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`;
const gitlabBase = (): Record<string, Reply> => ({
  "GET user": fixture("gitlab/user.json"),
  [`GET ${GL}`]: fixture("gitlab/project.json"),
  [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
  [`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`]: "[]",
});
const gitlabMr = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ...JSON.parse(fixture("gitlab/mr-failing-thread.json")),
    detailed_merge_status: "mergeable",
    head_pipeline: null,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// pr create

test("pr create (GitHub): given the pushed branch, then the PR is opened with that head, verified and recorded", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": JSON.stringify({
      number: 13,
      html_url: "https://github.com/o/r/pull/13",
      state: "open",
      head: { ref: "feature/x", sha: "{{HEAD}}" },
    }),
  });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--body", "Why: y", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    number: 13,
    branch: "feature/x",
    base: "main",
    head: repo.head,
    created: true,
    draft: false,
  });
  const [post] = writes(runner.calls);
  expect(post).toMatchObject({
    method: "POST",
    endpoint: "repos/o/r/pulls",
    vars: { title: "feat: x", head: "feature/x", base: "main", body: "Why: y", draft: "false" },
  });
  // S13 resolves --pr through this observed row.
  expect(rows(repo.cwd, "pr.created")).toEqual([
    expect.objectContaining({
      observer: "workit_cli",
      pr: 13,
      branch: "feature/x",
      head: repo.head,
    }),
  ]);
  const check = await run(["ledger", "check", "--pr", "13", "--json"], repo.cwd);
  expect(check.json().data.branch).toBe("feature/x");
});

// Two release lines; the workspace default (develop) belongs to `next`, but
// feature/x is cut from main, so its PR must target main.
const TWO_TRACKS = {
  stable: {
    strategy: "gitflow",
    productionBranch: "stable-prod",
    integrationBranch: "main",
    naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
    baseBranch: "main",
    mergeBackBranches: [],
    pullRequestTarget: "main",
    tagNamespace: "",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
  next: {
    strategy: "gitflow",
    productionBranch: "next-prod",
    integrationBranch: "develop",
    naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
    baseBranch: "develop",
    mergeBackBranches: [],
    pullRequestTarget: "develop",
    tagNamespace: "next/",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
};

test("pr create: given release tracks and no --base, then the PR targets the track the branch derives from, not the workspace default", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": JSON.stringify({
      number: 13,
      html_url: "https://github.com/o/r/pull/13",
      state: "open",
      head: { ref: "feature/x", sha: "{{HEAD}}" },
    }),
  });
  workspace(repo, {
    vcs: { provider: "github", account: "octo", defaultTargetBranch: "develop" },
    releaseTracks: TWO_TRACKS,
  });
  // feature/x was made with `git switch -c` on main: the HEAD reflog says so.
  const result = await run(["pr", "create", "--title", "feat: x", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    base: "main",
    releaseTrack: { name: "stable", source: "checkout" },
  });
  expect(writes(runner.calls)[0]).toMatchObject({ vars: { base: "main" } });
});

test("pr create: an open PR for the branch is reused (created:false) and nothing is posted", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-pr.json"),
  });
  const result = await run(["pr", "create", "--base", "main", "--fill", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ number: 12, created: false, head: repo.head });
  expect(writes(runner.calls)).toEqual([]);
});

test("pr create: a local commit that is not pushed is blocked with workit git push, before any forge write", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
  });
  writeFileSync(path.join(repo.cwd, "more.txt"), "more\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: more");
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ code: "blocked", unblock: "workit git push" });
  expect(result.json().error).toContain("not_pushed");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr create: a forge head that never matches the bound SHA fails as head_unverified", async () => {
  const { repo } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": JSON.stringify({
      number: 13,
      html_url: "https://github.com/o/r/pull/13",
      state: "open",
      head: { ref: "feature/x", sha: "{{BASE}}" },
    }),
  });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(1);
  expect(result.json().error).toContain("head_unverified");
  expect(rows(repo.cwd, "pr.created")).toEqual([]);
});

test("pr create (GitLab): --draft --fill opens a Draft MR from the commit subject", async () => {
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [GL_FIND]: "[]",
    [`POST ${GL}/merge_requests`]: JSON.stringify({
      iid: 13,
      web_url: "https://gitlab.com/group/project/-/merge_requests/13",
      state: "opened",
      source_branch: "feature/x",
      sha: "{{HEAD}}",
    }),
  });
  const result = await run(
    ["pr", "create", "--base", "main", "--fill", "--draft", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ number: 13, created: true, draft: true });
  expect(writes(runner.calls)[0]).toMatchObject({
    endpoint: `${GL}/merge_requests`,
    vars: { source_branch: "feature/x", target_branch: "main", title: "Draft: feature" },
  });
});

test("pr create: usage errors exit 2", async () => {
  const { repo } = setup("github", githubBase());
  expect((await run(["pr", "create"], repo.cwd)).code).toBe(2);
  expect(
    (await run(["pr", "create", "--title", "t", "--body", "a", "--body-file", "f"], repo.cwd)).code,
  ).toBe(2);
  expect(
    (await run(["pr", "create", "--fill", "--body-file", "/nope/missing"], repo.cwd)).code,
  ).toBe(2);
  expect((await run(["pr", "merge", "--method", "octopus"], repo.cwd)).code).toBe(2);
  expect((await run(["pr", "frobnicate"], repo.cwd)).code).toBe(2);
});

// ---------------------------------------------------------------------------
// pr merge

// Merging needs an explicit grant (D4: the default ceiling stops at verified, ready).
const grantMerge = (
  repo: ForgeRepo,
  provider: "github" | "gitlab" = "github",
  vcs: Record<string, unknown> = {},
) =>
  workspace(repo, { vcs: { provider, account: "octo", ...vcs }, autonomy: { merge: "verified" } });

const mergeRoutes = (
  status: string,
  merge: Reply = JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" }),
): Record<string, Reply> => {
  let merged = false;
  return {
    ...githubBase(),
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () => fixture(merged ? "github/pr-merged.json" : status),
    "PUT repos/o/r/pulls/12/merge": (call) => {
      const reply = typeof merge === "function" ? merge(call) : merge;
      merged = typeof reply === "string";
      return reply;
    },
  };
};

const verdict = async (repo: ForgeRepo, session = "reviewer-2") => {
  const recorded = await run(
    ["ledger", "verdict", "verified", "--how", "exercised the CLI"],
    repo.cwd,
    session,
  );
  expect(recorded.code).toBe(0);
};

test("pr merge: given a workspace without the merge grant, then grant_required names the grant and the exact command", async () => {
  const { repo } = setup("github", {
    ...mergeRoutes("github/pr-passing.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  });
  workspace(repo, { vcs: { provider: "github", account: "octo" }, autonomy: { merge: false } });
  await verdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({
    ok: false,
    code: "blocked",
    error: 'grant_required: merge is not granted for workspace "w"',
    data: { reason: "grant_required" },
  });
  expect(result.json().unblock).toContain("workit grant set w merge=verified");
});

test("pr merge: grants written to a redirected config dir (WORKFLOW_TOOLKIT_CONFIG_DIR=./x) are ignored and merge is denied", async () => {
  const { repo, runner } = setup("github", {
    ...mergeRoutes("github/pr-passing.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  });
  // The real user config has no merge grant; an agent writes one elsewhere
  // and points the config override at it.
  workspace(repo, { vcs: { provider: "github", account: "octo" } });
  // Outside the checkout so the verdict stays on a clean tree.
  const forged = path.join(configHome.home, "x");
  mkdirSync(forged, { recursive: true });
  for (const name of ["workspaces.json", "config.json"])
    writeFileSync(path.join(forged, name), readFileSync(path.join(configDir, name), "utf8"));
  const forgedEntry = JSON.parse(readFileSync(path.join(forged, "workspaces.json"), "utf8"));
  forgedEntry.workspaces[0].autonomy = { merge: true };
  writeFileSync(path.join(forged, "workspaces.json"), JSON.stringify(forgedEntry));
  await verdict(repo);
  const saved = process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = forged;
  try {
    const result = await run(["pr", "merge", "--json"], repo.cwd);
    expect(result.code).toBe(3);
    expect(result.json()).toMatchObject({ code: "blocked", data: { reason: "grant_required" } });
    expect(result.json().error).toContain("grants are read only from");
    expect(writes(runner.calls)).toEqual([]);
  } finally {
    delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
    process.env.WORKFLOW_TOOLKIT_CONFIG = saved;
  }
});

test("pr merge: HOME=<fake> with a forged grants file does not grant merge", async () => {
  const { repo, runner } = setup("github", {
    ...mergeRoutes("github/pr-passing.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  });
  workspace(repo, { vcs: { provider: "github", account: "octo" } });
  // The agent fakes a home whose ~/.config/workit grants merge, and points
  // both HOME and the config override at it.
  const fake = path.join(configHome.home, "fake-home");
  const forged = path.join(fake, ".config", "workit");
  mkdirSync(forged, { recursive: true });
  for (const name of ["workspaces.json", "config.json"])
    writeFileSync(path.join(forged, name), readFileSync(path.join(configDir, name), "utf8"));
  const forgedEntry = JSON.parse(readFileSync(path.join(forged, "workspaces.json"), "utf8"));
  forgedEntry.workspaces[0].autonomy = { merge: true };
  writeFileSync(path.join(forged, "workspaces.json"), JSON.stringify(forgedEntry));
  await verdict(repo);
  const saved = { HOME: process.env.HOME, CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG };
  process.env.HOME = fake;
  process.env.WORKFLOW_TOOLKIT_CONFIG = forged;
  try {
    const result = await run(["pr", "merge", "--json"], repo.cwd);
    expect(result.code).toBe(3);
    expect(result.json()).toMatchObject({ code: "blocked", data: { reason: "grant_required" } });
    expect(writes(runner.calls)).toEqual([]);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.WORKFLOW_TOOLKIT_CONFIG = saved.CONFIG;
  }
});

test("pr merge: a PR that is not READY is refused with its next action", async () => {
  const { repo, runner } = setup("github", mergeRoutes("github/pr-failing-thread.json"));
  grantMerge(repo);
  await verdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ data: { reason: "not_ready", next: "RESOLVE_THREADS" } });
  expect(writes(runner.calls)).toEqual([]);
});

test("pr merge: given READY but no accepted verdict, then NEEDS_VERDICT; the author's own verdict does not count", async () => {
  const { repo, runner } = setup("github", mergeRoutes("github/pr-passing.json"));
  grantMerge(repo);
  const none = await run(["pr", "merge", "--json"], repo.cwd);
  expect(none.code).toBe(3);
  expect(none.json().error).toContain("NEEDS_VERDICT");
  expect(none.json()).toMatchObject({ data: { reason: "needs_verdict" } });
  expect(none.json().unblock).toContain("workit ledger verdict verified");
  // A self verdict is recorded but never accepted.
  expect(
    (await run(["ledger", "verdict", "verified", "--how", "x", "--self"], repo.cwd)).code,
  ).toBe(0);
  const self = await run(["pr", "merge", "--json"], repo.cwd);
  expect(self.json().error).toContain("NEEDS_VERDICT");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr merge: given a reviewer's failed verdict on an earlier head, when the same reviewer verifies the PR head, then merge: verified merges", async () => {
  const { repo } = setup("github", mergeRoutes("github/pr-passing.json"));
  grantMerge(repo);
  repo.git("reset", "-q", "--hard", "HEAD~1");
  writeFileSync(path.join(repo.cwd, "feature.txt"), "draft\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feature draft");
  const failed = await run(["ledger", "verdict", "failed", "--how", "bug"], repo.cwd, "reviewer-2");
  expect(failed.code).toBe(0);
  repo.git("reset", "-q", "--hard", repo.head);
  await verdict(repo, "reviewer-2");
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    head: repo.head,
    verdict: { required: true, accepted: true },
  });
});

test("pr merge: READY + accepted verdict merges with the head SHA guard and records pr.merged", async () => {
  const { repo, runner } = setup("github", mergeRoutes("github/pr-passing.json"));
  grantMerge(repo);
  await verdict(repo);
  const result = await run(["pr", "merge", "--method", "squash", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    number: 12,
    branch: "feature/x",
    head: repo.head,
    method: "squash",
    mergeSha: repo.base,
    verdict: { required: true, accepted: true },
    grant: { source: "autonomy" },
    deletedBranch: false,
  });
  expect(writes(runner.calls)).toEqual([
    expect.objectContaining({
      method: "PUT",
      endpoint: "repos/o/r/pulls/12/merge",
      vars: { sha: repo.head, merge_method: "squash" },
    }),
  ]);
  expect(rows(repo.cwd, "pr.merged")).toEqual([
    expect.objectContaining({
      observer: "workit_cli",
      pr: 12,
      head: repo.head,
      mergeSha: repo.base,
    }),
  ]);
  // verify-delivery merged: the forge says merged and the recorded merge commit is on the base.
  repo.git("push", "-q", path.join(repo.root, "remote.git"), `${repo.base}:refs/heads/main`);
  const verified = await run(["verify-delivery", "merged", "--pr", "12", "--json"], repo.cwd);
  expect(verified.code).toBe(0);
  expect(verified.json().data.observations).toEqual([
    expect.objectContaining({ kind: "pr_state", observed: "merged", ok: true }),
    expect.objectContaining({ kind: "merge_on_base", expected: repo.base, ok: true }),
  ]);
});

test("pr merge: a PR landing on a track's production branch reports the merge-back branches", async () => {
  const { repo } = setup("github", mergeRoutes("github/pr-passing.json"));
  workspace(repo, {
    vcs: { provider: "github", account: "octo" },
    autonomy: { merge: "verified" },
    releaseTracks: {
      ...TWO_TRACKS,
      stable: {
        ...TWO_TRACKS.stable,
        productionBranch: "main",
        integrationBranch: "develop-s",
        baseBranch: "develop-s",
        pullRequestTarget: "develop-s",
        mergeBackBranches: ["develop-s"],
      },
    },
  });
  await verdict(repo);
  // The owner of the merged-into branch decides, not a session's track choice.
  const previous = process.env.WORKFLOW_RELEASE_TRACK;
  process.env.WORKFLOW_RELEASE_TRACK = "next";
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(["pr", "merge", "--json"], repo.cwd);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_RELEASE_TRACK;
    else process.env.WORKFLOW_RELEASE_TRACK = previous;
  }
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    base: "main",
    mergeBack: ["develop-s"],
    mergeBackTrack: "stable",
  });
});

test("pr merge: given the remote head advanced after the gates, then the forge's SHA guard refuses (blocked, head_moved)", async () => {
  const { repo } = setup(
    "github",
    mergeRoutes(
      "github/pr-passing.json",
      replyError("gh: Head branch was modified. Review and try the merge again. (HTTP 409)"),
    ),
  );
  grantMerge(repo);
  await verdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("head_moved");
  expect(rows(repo.cwd, "pr.merged")).toEqual([]);
});

test("pr merge: a PR head that is not the verified local head is refused before merging", async () => {
  const { repo, runner } = setup("github", mergeRoutes("github/pr-passing.json"));
  grantMerge(repo);
  await verdict(repo);
  // The local branch moved on (the verdict was for the old head, which the PR still shows).
  writeFileSync(path.join(repo.cwd, "later.txt"), "later\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: later");
  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ data: { reason: "head_mismatch" } });
  expect(writes(runner.calls)).toEqual([]);
});

test("pr merge: merge: true grants merging without a verdict (still READY-gated)", async () => {
  const { repo } = setup("github", {});
  workspace(repo, { vcs: { provider: "github", account: "octo" }, autonomy: { merge: true } });
  const runner = replayRunner(
    {
      ...mergeRoutes("github/pr-passing.json"),
      "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    },
    repo.subs,
  );
  forgeDeps.runner = runner;
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    verdict: { required: false, accepted: false },
    grant: { source: "autonomy" },
  });
  expect(runner.calls.at(-1)?.token).toBe("gho_token_for_octo_0000000000000000");
  expect(result.stdout).not.toContain("gho_token_for_octo");
});

test("pr merge (GitLab): READY MR merges with sha= and squash; rebase is not a GitLab request option", async () => {
  let merged = false;
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [GL_FIND]: fixture("gitlab/find-mr.json"),
    [`GET ${GL}/merge_requests/12`]: () => gitlabMr(merged ? { state: "merged" } : {}),
    [`PUT ${GL}/merge_requests/12/merge`]: () => {
      merged = true;
      return gitlabMr({ state: "merged", squash_commit_sha: "{{BASE}}" });
    },
  });
  grantMerge(repo, "gitlab");
  await verdict(repo);
  const rebase = await run(["pr", "merge", "--method", "rebase", "--json"], repo.cwd);
  expect(rebase.code).toBe(2);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ number: 12, mergeSha: repo.base, head: repo.head });
  expect(writes(runner.calls).at(-1)).toMatchObject({
    method: "PUT",
    endpoint: `${GL}/merge_requests/12/merge`,
    vars: { sha: repo.head, squash: "true" },
  });
});

test("pr merge --delete-branch: a develop -> main release PR under gitflow is refused before merging (develop is protected)", async () => {
  const release = fixture("github/pr-passing.json").replaceAll(
    '"headRefName": "feature/x"',
    '"headRefName": "develop"',
  );
  const { repo, runner } = setup("github", {
    ...githubBase(),
    [GH_STATUS]: release,
    "PUT repos/o/r/pulls/12/merge": "{}",
  });
  grantMerge(repo);
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const result = await run(["pr", "merge", "--pr", "12", "--delete-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json()).toMatchObject({ data: { reason: "protected_branch" } });
  expect(result.json().error).toContain("would delete develop");
  expect(result.json().unblock).toContain("without --delete-branch");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr merge --delete-branch: a fork PR whose head branch is named like the base is refused (the base is never deleted)", async () => {
  const forkRelease = fixture("github/pr-passing.json")
    .replaceAll('"headRefName": "feature/x"', '"headRefName": "Release"')
    .replaceAll('"baseRefName": "main"', '"baseRefName": "release"');
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/branches/release": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/release": fixture("github/rules-main.json"),
    [GH_STATUS]: forkRelease,
    "PUT repos/o/r/pulls/12/merge": "{}",
  });
  grantMerge(repo);
  const result = await run(["pr", "merge", "--pr", "12", "--delete-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("is the PR base");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr merge --delete-branch (GitLab): a fast-forward promotion from the default target is refused, case-insensitively", async () => {
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [`GET ${GL}/merge_requests/12`]: gitlabMr({ source_branch: "Staging", target_branch: "main" }),
    [`PUT ${GL}/merge_requests/12/merge`]: "{}",
  });
  grantMerge(repo, "gitlab", { defaultTargetBranch: "staging" });
  const result = await run(["pr", "merge", "--pr", "12", "--delete-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("is the default target branch");
  expect(writes(runner.calls)).toEqual([]);
});

// ---------------------------------------------------------------------------
// verify-delivery pr / released

test("verify-delivery pr: the PR head must be the local head", async () => {
  const { repo } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: fixture("github/pr-passing.json"),
  });
  const ok = await run(["verify-delivery", "pr", "--json"], repo.cwd);
  expect(ok.code).toBe(0);
  expect(ok.json().data).toMatchObject({ expect: "pr", pr: 12, delivered: true });
  writeFileSync(path.join(repo.cwd, "later.txt"), "later\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: later");
  const behind = await run(["verify-delivery", "--expect", "pr", "--pr", "12", "--json"], repo.cwd);
  expect(behind.code).toBe(1);
  expect(behind.json().data.observations[1]).toMatchObject({ kind: "pr_head", ok: false });
});

test("verify-delivery released: the tag must be on the remote and the npm version published at its commit", async () => {
  const { repo } = setup("github", githubBase());
  repo.git("tag", "v1.2.3", repo.head);
  repo.git("push", "-q", path.join(repo.root, "remote.git"), "v1.2.3");
  const npmCalls: string[][] = [];
  forgeDeps.npm = (args) => {
    npmCalls.push([...args]);
    return args[1] === "@scope/pkg@1.2.3"
      ? { status: 0, stdout: JSON.stringify({ version: "1.2.3", gitHead: repo.head }), stderr: "" }
      : { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };
  };
  const ok = await run(
    ["verify-delivery", "release", "--tag", "v1.2.3", "--package", "@scope/pkg", "--json"],
    repo.cwd,
  );
  expect(ok.code).toBe(0);
  expect(
    ok
      .json()
      .data.observations.map((entry: { kind: string; ok: boolean }) => [entry.kind, entry.ok]),
  ).toEqual([
    ["tag", true],
    ["npm_version", true],
    ["npm_git_head", true],
  ]);
  expect(npmCalls[0]).toEqual(["view", "@scope/pkg@1.2.3", "version", "gitHead", "--json"]);
  const missing = await run(
    ["verify-delivery", "--tag", "v9.9.9", "--package", "@scope/pkg", "--json"],
    repo.cwd,
  );
  expect(missing.code).toBe(1);
  expect(missing.json().data.observations.map((entry: { ok: boolean }) => entry.ok)).toEqual([
    false,
    false,
  ]);
});

test("verify-delivery released: --sha without --tag must match the published gitHead; no gitHead is unverified, never delivered", async () => {
  const { repo } = setup("github", githubBase());
  let view: Record<string, unknown> = { version: "1.2.3", gitHead: repo.head };
  forgeDeps.npm = () => ({ status: 0, stdout: JSON.stringify(view), stderr: "" });
  const argv = [
    "verify-delivery",
    "release",
    "--package",
    "pkg@1.2.3",
    "--sha",
    repo.head,
    "--json",
  ];
  expect((await run(argv, repo.cwd)).code).toBe(0);
  view = { version: "1.2.3", gitHead: repo.base };
  const other = await run(argv, repo.cwd);
  expect(other.code).toBe(1);
  expect(other.json().data.observations[1]).toMatchObject({ kind: "npm_git_head", ok: false });
  view = { version: "1.2.3" };
  const unverified = await run(argv, repo.cwd);
  expect(unverified.code).toBe(1);
  expect(unverified.json().data).toMatchObject({ delivered: false });
  expect(unverified.json().error).toContain(
    "unverified: pkg@1.2.3 was published without a gitHead",
  );
});

test("verify-delivery released: package specs that are not an npm name and semver are refused before npm runs", async () => {
  const { repo } = setup("github", githubBase());
  let called = 0;
  forgeDeps.npm = () => {
    called += 1;
    return { status: 0, stdout: "{}", stderr: "" };
  };
  for (const spec of [
    "pkg;calc@1.0.0",
    "pkg@1.0.0&calc",
    "@scope/p@1.0.0|x",
    "pkg@1.0.0 --registry=http://evil",
    'pkg@"1.0.0"',
    "pkg@^1.0.0",
    "pkg@%PATH%",
  ]) {
    const result = await run(["verify-delivery", "--package", spec, "--json"], repo.cwd);
    expect(result.code, spec).toBe(2);
  }
  expect((await run(["verify-delivery", "--tag", "v1&calc", "--json"], repo.cwd)).code).toBe(2);
  expect(called).toBe(0);
});
