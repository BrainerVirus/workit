import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { appendObserved } from "@/packages/workit-core/src/ledger";
import { STACK_VERSION, writeStack } from "@/packages/workit-core/src/stack";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// `workit pr ready|edit|threads|reply`, the `pr create` --body-file - /
// --label / --reviewer / --fill body, and the `pr status` next-step hint, over
// recorded GitHub/GitLab API shapes (fake gh/glab).

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-life-config-");
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

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const setup = (
  kind: "github" | "gitlab",
  routes: Record<string, Reply>,
  policy: Record<string, unknown> = { preset: "github-flow" },
) => {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ branchPolicy: policy }));
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

/** REST writes and GraphQL mutations, in call order. */
const writes = (calls: readonly Call[]) =>
  calls.filter(
    (call) =>
      (call.method !== "GET" && call.method !== "CLI" && call.endpoint !== "graphql") ||
      (call.endpoint === "graphql" && !["status", "find", "node"].includes(call.op ?? "")),
  );

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';
const githubBase = (): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "graphql find": fixture("github/find-pr.json"),
});
const octoToken = {
  "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
};
const workspace = (repo: ForgeRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );
const ghPull = (fields: Record<string, unknown>) =>
  JSON.stringify({
    number: 12,
    html_url: "https://github.com/o/r/pull/12",
    node_id: "PR_kwNode12",
    state: "open",
    merged: false,
    draft: false,
    title: "feat: x",
    base: { ref: "main" },
    head: { ref: "feature/x" },
    ...fields,
  });

const GL = "projects/group%2Fproject";
const GL_FIND = `GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`;
const gitlabBase = (): Record<string, Reply> => ({
  "GET user": fixture("gitlab/user.json"),
  [`GET ${GL}`]: fixture("gitlab/project.json"),
  [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
  [GL_FIND]: fixture("gitlab/find-mr.json"),
});
const glMr = (fields: Record<string, unknown>) =>
  JSON.stringify({
    ...JSON.parse(fixture("gitlab/mr-failing-thread.json")),
    detailed_merge_status: "mergeable",
    head_pipeline: null,
    ...fields,
  });

// ---------------------------------------------------------------------------
// pr ready

test("pr ready (GitHub): given a draft PR, when marked ready, then the ready mutation runs on its node id and the re-read confirms it", async () => {
  let draft = true;
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": () => ghPull({ draft }),
    "graphql markPullRequestReadyForReview": () => {
      draft = false;
      return JSON.stringify({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      });
    },
  });
  const result = await run(["pr", "ready", "--pr", "12", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toEqual({
    number: 12,
    url: "https://github.com/o/r/pull/12",
    draft: false,
    changed: true,
  });
  expect(writes(runner.calls)).toEqual([
    expect.objectContaining({ op: "markPullRequestReadyForReview", vars: { id: "PR_kwNode12" } }),
  ]);
  // Running it again is a no-op: no second mutation.
  const again = await run(["pr", "ready", "--pr", "12"], repo.cwd);
  expect(again.stdout).toBe(
    "PR #12 was already ready for review  https://github.com/o/r/pull/12\n",
  );
  expect(writes(runner.calls)).toHaveLength(1);
});

test("pr ready --undo (GitHub): given a ready PR, then it is converted back to a draft", async () => {
  let draft = false;
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": () => ghPull({ draft }),
    "graphql convertPullRequestToDraft": () => {
      draft = true;
      return JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: {} } } });
    },
  });
  const result = await run(["pr", "ready", "--undo"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toBe("PR #12 is now a draft  https://github.com/o/r/pull/12\n");
  expect(writes(runner.calls).map((call) => call.op)).toEqual(["convertPullRequestToDraft"]);
});

test("pr ready: given the forge still reports a draft after the mutation, then it fails as ready_unverified", async () => {
  const { repo } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": ghPull({ draft: true }),
    "graphql markPullRequestReadyForReview": JSON.stringify({ data: {} }),
  });
  const result = await run(["pr", "ready", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json().error).toContain("ready_unverified");
});

test("pr ready: given a workspace without the pr grant, then it is blocked before any forge write", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    ...octoToken,
    "GET repos/o/r/pulls/12": ghPull({ draft: true }),
  });
  workspace(repo, { vcs: { provider: "github", account: "octo" }, autonomy: { pr: false } });
  const result = await run(["pr", "ready", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("grant_required: pr");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr ready (GitLab): given a Draft: MR, then the marker is dropped from the title", async () => {
  let title = "Draft: feat: x";
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [`GET ${GL}/merge_requests/12`]: () => glMr({ title, draft: title.startsWith("Draft:") }),
    [`PUT ${GL}/merge_requests/12`]: (call) => {
      title = call.vars.title;
      return glMr({ title });
    },
  });
  const result = await run(["pr", "ready", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({ number: 12, draft: false, changed: true });
  expect(writes(runner.calls)).toEqual([
    expect.objectContaining({ method: "PUT", vars: { title: "feat: x" } }),
  ]);
});

// ---------------------------------------------------------------------------
// pr edit

test("pr edit (GitHub): title, a stdin body, labels and reviewers each reach their endpoint", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": ghPull({}),
    "PATCH repos/o/r/pulls/12": ghPull({ title: "feat: y" }),
    "POST repos/o/r/issues/12/labels": "[]",
    "DELETE repos/o/r/issues/12/labels/needs%20triage": "",
    "POST repos/o/r/pulls/12/requested_reviewers": "{}",
  });
  forgeDeps.readStdin = () => "## Why\n\n`$(not run)` stays text\n";
  const result = await run(
    [
      "pr",
      "edit",
      "--title",
      "feat: y",
      "--body-file",
      "-",
      "--add-label",
      "bug",
      "--add-label",
      "ui",
      "--remove-label",
      "needs triage",
      "--add-reviewer",
      "alice",
      "--add-reviewer",
      "o/core",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    number: 12,
    changed: ["title", "body", "labels", "reviewers"],
  });
  const [patch, labels, unlabel, reviewers] = writes(runner.calls);
  expect(patch).toMatchObject({
    method: "PATCH",
    vars: { title: "feat: y", body: "## Why\n\n`$(not run)` stays text\n" },
  });
  expect(labels.pairs).toEqual([
    ["labels[]", "bug"],
    ["labels[]", "ui"],
  ]);
  expect(unlabel).toMatchObject({ method: "DELETE" });
  expect(reviewers.pairs).toEqual([
    ["reviewers[]", "alice"],
    ["team_reviewers[]", "core"],
  ]);
});

test("pr edit --base: given a protected branch that is not the default target, then the retarget is refused before any write", async () => {
  const { repo, runner } = setup(
    "github",
    { ...githubBase(), ...octoToken, "GET repos/o/r/pulls/12": ghPull({}) },
    { preset: "custom", allowed: ["feature/*"], protected: ["main", "production"] },
  );
  workspace(repo, { vcs: { provider: "github", account: "octo", defaultTargetBranch: "main" } });
  const result = await run(["pr", "edit", "--base", "production", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toStartWith("protected_base: production is protected");
  expect(result.json().unblock).toStartWith("workit pr edit --pr 12 --base main");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr edit --base: given an unprotected parent branch, then the PR is retargeted and the new base verified", async () => {
  let base = "main";
  const { repo, runner } = setup(
    "github",
    {
      ...githubBase(),
      "GET repos/o/r/pulls/12": () => ghPull({ base: { ref: base } }),
      "PATCH repos/o/r/pulls/12": (call) => {
        base = call.vars.base;
        return ghPull({ base: { ref: base } });
      },
    },
    { preset: "custom", allowed: ["feature/*"], protected: ["main", "production"] },
  );
  repo.git("config", "branch.feature/x.workitBase", "feature/parent");
  const result = await run(["pr", "edit", "--base", "feature/parent"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toBe(
    "edited PR #12 (base): feat: x -> feature/parent  https://github.com/o/r/pull/12\n",
  );
  expect(writes(runner.calls)).toEqual([
    expect.objectContaining({ method: "PATCH", vars: { base: "feature/parent" } }),
  ]);
});

test("pr edit --base: given an unprotected branch that is not the stack parent, then it is refused, naming the default target", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": ghPull({}),
  });
  repo.git("config", "branch.feature/x.workitBase", "feature/parent");
  const result = await run(["pr", "edit", "--base", "feature/other", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toStartWith("not_stack_parent: feature/other");
  expect(result.json().unblock).toStartWith("workit pr edit --pr 12 --base main");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr edit --base (stack a -> feature/x -> c): the branch below is allowed; a descendant or sibling is refused as a cycle", async () => {
  let base = "main";
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": () => ghPull({ base: { ref: base } }),
    "PATCH repos/o/r/pulls/12": (call) => {
      base = call.vars.base;
      return ghPull({ base: { ref: base } });
    },
  });
  const entry = (branch: string, parent: string) => ({
    branch,
    parent,
    pr: null,
    lastHead: null,
    lastParentHead: null,
    patchId: null,
    merged: null,
  });
  const write = (name: string, branches: ReturnType<typeof entry>[]) =>
    expect(
      writeStack(repo.cwd, {
        v: STACK_VERSION,
        name,
        trunk: "main",
        forge: "github",
        repo: "o/r",
        branches,
        updatedAt: "",
      }).ok,
    ).toBe(true);
  write("s", [
    entry("feature/a", "main"),
    entry("feature/x", "feature/a"),
    entry("feature/c", "feature/x"),
  ]);
  write("t", [entry("feature/a", "main"), entry("feature/sib", "feature/a")]);
  for (const refused of ["feature/c", "feature/sib"]) {
    const result = await run(["pr", "edit", "--base", refused, "--json"], repo.cwd);
    expect(result.code, refused).toBe(3);
    expect(result.json().error, refused).toStartWith(`not_stack_parent: ${refused}`);
  }
  expect(writes(runner.calls)).toEqual([]);
  const parent = await run(["pr", "edit", "--base", "feature/a"], repo.cwd);
  expect(parent.code, parent.stdout).toBe(0);
  expect(writes(runner.calls)).toEqual([
    expect.objectContaining({ method: "PATCH", vars: { base: "feature/a" } }),
  ]);
});

test("pr edit --base: refs/ names and whitespace are usage errors", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": ghPull({}),
  });
  for (const base of ["refs/heads/main", "main ", "feature/a b"]) {
    const result = await run(["pr", "edit", `--base=${base}`, "--json"], repo.cwd);
    expect(result.code, base).toBe(2);
    expect(result.json().error, base).toContain("--base must be a plain branch name");
  }
  expect(writes(runner.calls)).toEqual([]);
});

const track = (integration: string, production: string) => ({
  strategy: "gitflow",
  productionBranch: production,
  integrationBranch: integration,
  naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
  baseBranch: integration,
  mergeBackBranches: [],
  pullRequestTarget: integration,
  tagNamespace: "",
  versionSource: { kind: "git-tag" },
  requiredChecks: [],
});
const TWO_TRACKS = { core: track("develop", "master"), nun: track("nun-develop", "nun-master") };

test("pr edit --base (release tracks): given a PR on the nun line, then retargeting it to core's develop is refused, naming nun-develop", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    ...octoToken,
    "GET repos/o/r/pulls/12": ghPull({ base: { ref: "nun-develop" } }),
  });
  workspace(repo, {
    vcs: { provider: "github", account: "octo", defaultTargetBranch: "develop" },
    releaseTracks: TWO_TRACKS,
  });
  const result = await run(["pr", "edit", "--base", "develop", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(3);
  expect(result.json().error).toStartWith("protected_base: develop");
  expect(result.json().unblock).toStartWith("workit pr edit --pr 12 --base nun-develop");
  expect(writes(runner.calls)).toEqual([]);
});

test("pr edit --base (release tracks): given a PR whose line can't be decided and a bad WORKFLOW_RELEASE_TRACK, then it is blocked", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    ...octoToken,
    "GET repos/o/r/pulls/12": ghPull({ base: { ref: "feature/parent" } }),
  });
  workspace(repo, {
    vcs: { provider: "github", account: "octo", defaultTargetBranch: "develop" },
    releaseTracks: TWO_TRACKS,
  });
  const saved = process.env.WORKFLOW_RELEASE_TRACK;
  process.env.WORKFLOW_RELEASE_TRACK = "bogus";
  try {
    const result = await run(["pr", "edit", "--base", "develop", "--json"], repo.cwd);
    expect(result.code, result.stdout).toBe(3);
    expect(result.json().error).toContain("bogus");
  } finally {
    if (saved === undefined) delete process.env.WORKFLOW_RELEASE_TRACK;
    else process.env.WORKFLOW_RELEASE_TRACK = saved;
  }
  expect(writes(runner.calls)).toEqual([]);
});

test("pr edit: nothing to change is a usage error", async () => {
  const { repo } = setup("github", githubBase());
  const result = await run(["pr", "edit", "--json"], repo.cwd);
  expect(result.code).toBe(2);
  expect(result.json().error).toBe("nothing to edit");
});

test("pr edit (GitLab): a new title on a draft keeps Draft:, labels go as lists, reviewers keep the current ones", async () => {
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [`GET ${GL}/merge_requests/12`]: glMr({
      title: "Draft: feat: x",
      draft: true,
      reviewers: [{ id: 3 }],
    }),
    "GET users?username=alice": JSON.stringify([{ id: 7, username: "alice" }]),
    [`PUT ${GL}/merge_requests/12`]: glMr({}),
  });
  writeFileSync(path.join(repo.cwd, "body.md"), "Fixes the edge case.\n");
  const result = await run(
    [
      "pr",
      "edit",
      "--title",
      "feat: y",
      "--body-file",
      "body.md",
      "--add-label",
      "bug",
      "--add-label",
      "ui",
      "--remove-label",
      "wip",
      "--add-reviewer",
      "alice",
    ],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  const [put] = writes(runner.calls);
  expect(put.pairs).toEqual([
    ["title", "Draft: feat: y"],
    ["description", "Fixes the edge case.\n"],
    ["add_labels", "bug,ui"],
    ["remove_labels", "wip"],
    ["reviewer_ids", "[3,7]"],
  ]);
});

// ---------------------------------------------------------------------------
// pr threads / reply

const ghThreadRoutes = (): Record<string, Reply> => ({
  ...githubBase(),
  "GET repos/o/r/pulls/12": ghPull({}),
  [GH_STATUS]: fixture("github/pr-failing-thread.json"),
});

test("pr threads (GitHub): lists only the unresolved thread, one compact line each", async () => {
  const { repo } = setup("github", ghThreadRoutes());
  const result = await run(["pr", "threads"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toBe(
    "PR #12: 1 unresolved thread\nPRRT_1  src/a.ts:10 @reviewer: Please handle the empty case here before merging.\n",
  );
});

test("pr reply (GitHub): --body-file and --resolve reply on the thread and resolve it", async () => {
  const { repo, runner } = setup("github", {
    ...ghThreadRoutes(),
    "graphql addPullRequestReviewThreadReply": JSON.stringify({
      data: {
        addPullRequestReviewThreadReply: {
          comment: { url: "https://github.com/o/r/pull/12#discussion_r9" },
        },
      },
    }),
    "graphql resolveReviewThread": JSON.stringify({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    }),
  });
  writeFileSync(path.join(repo.cwd, "reply.md"), "Handled in b71c: empty input returns [].");
  const result = await run(
    ["pr", "reply", "--thread", "PRRT_1", "--body-file", "reply.md", "--resolve", "--json"],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toEqual({
    number: 12,
    thread: "PRRT_1",
    replied: true,
    replyUrl: "https://github.com/o/r/pull/12#discussion_r9",
    resolved: true,
  });
  expect(writes(runner.calls).map((call) => [call.op, call.vars])).toEqual([
    [
      "addPullRequestReviewThreadReply",
      { thread: "PRRT_1", body: "Handled in b71c: empty input returns []." },
    ],
    ["resolveReviewThread", { thread: "PRRT_1" }],
  ]);
});

test("pr reply: a thread that is not unresolved on this PR is not_found, and nothing is posted", async () => {
  const { repo, runner } = setup("github", ghThreadRoutes());
  const result = await run(["pr", "reply", "--thread", "PRRT_2", "--resolve", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json()).toMatchObject({
    code: "not_found",
    unblock: "workit pr threads --pr 12",
  });
  expect(writes(runner.calls)).toEqual([]);
  expect((await run(["pr", "reply", "--thread", "PRRT_1"], repo.cwd)).code).toBe(2);
});

const GL_UNRESOLVED = "09560d7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const glThreadRoutes = (): Record<string, Reply> => ({
  ...gitlabBase(),
  [`GET ${GL}/merge_requests/12`]: glMr({}),
  [`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`]:
    fixture("gitlab/discussions.json"),
});

test("pr threads (GitLab): lists the unresolved discussion only", async () => {
  const { repo } = setup("gitlab", glThreadRoutes());
  const result = await run(["pr", "threads", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.threads.map((thread: { id: string }) => thread.id)).toEqual([
    GL_UNRESOLVED,
  ]);
});

test("pr reply (GitLab): posts a note on the discussion, then resolves it", async () => {
  const { repo, runner } = setup("gitlab", {
    ...glThreadRoutes(),
    [`POST ${GL}/merge_requests/12/discussions/${GL_UNRESOLVED}/notes`]: '{"id": 2001}',
    [`PUT ${GL}/merge_requests/12/discussions/${GL_UNRESOLVED}`]: JSON.stringify({
      id: GL_UNRESOLVED,
      notes: [{ id: 1003, body: "x", resolvable: true, resolved: true }],
    }),
  });
  forgeDeps.readStdin = () => "Fixed in the next push.";
  const result = await run(
    ["pr", "reply", "--thread", GL_UNRESOLVED, "--body-file", "-", "--resolve"],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toBe(`replied to and resolved thread ${GL_UNRESOLVED} on MR !12\n`);
  expect(writes(runner.calls).map((call) => [call.method, call.pairs])).toEqual([
    ["POST", [["body", "Fixed in the next push."]]],
    ["PUT", [["resolved", "true"]]],
  ]);
});

// ---------------------------------------------------------------------------
// pr create

const created = JSON.stringify({
  number: 13,
  html_url: "https://github.com/o/r/pull/13",
  state: "open",
  head: { ref: "feature/x", sha: "{{HEAD}}" },
});

test("pr create: --body-file - reads the body from stdin; --label and --reviewer are applied to the new PR", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": created,
    "POST repos/o/r/issues/13/labels": "[]",
    "POST repos/o/r/pulls/13/requested_reviewers": "{}",
  });
  forgeDeps.readStdin = () => "Body from a heredoc.\n";
  const result = await run(
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "feat: x",
      "--body-file",
      "-",
      "--label",
      "bug",
      "--reviewer",
      "alice",
      "--draft",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  const [post, labels, reviewers] = writes(runner.calls);
  expect(post.vars).toMatchObject({ body: "Body from a heredoc.\n", draft: "true" });
  expect(labels).toMatchObject({ endpoint: "repos/o/r/issues/13/labels" });
  expect(labels.pairs).toEqual([["labels[]", "bug"]]);
  expect(reviewers.pairs).toEqual([["reviewers[]", "alice"]]);
});

const pushBare = (repo: ForgeRepo) =>
  repo.git("push", "-q", "-f", path.join(repo.root, "remote.git"), "feature/x");

test("pr create --fill: one commit gives its body without the Workit-Session trailer", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": created,
  });
  repo.git(
    "commit",
    "-q",
    "--amend",
    "-m",
    "feat: x",
    "-m",
    "Why: the empty case crashed.",
    "--trailer",
    "Workit-Session: s-123",
  );
  pushBare(repo);
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  const result = await run(["pr", "create", "--base", "main", "--fill", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(writes(runner.calls)[0].vars).toMatchObject({
    title: "feat: x",
    body: "Why: the empty case crashed.",
  });
});

test("pr create --fill: several commits give every subject with its body, no trailer", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": created,
  });
  writeFileSync(path.join(repo.cwd, "second.txt"), "2\n");
  repo.git("add", "-A");
  repo.git(
    "commit",
    "-q",
    "-m",
    "fix: second",
    "-m",
    "Explains the second change.\nOver two lines.",
    "--trailer",
    "Workit-Session: s-123",
  );
  pushBare(repo);
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  const result = await run(["pr", "create", "--base", "main", "--fill", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(writes(runner.calls)[0].vars.body).toBe(
    "- feature\n- fix: second\n\n  Explains the second change.\n  Over two lines.",
  );
});

// ---------------------------------------------------------------------------
// pr status hints

test("pr status: a draft names `workit pr ready`, and threads name `workit pr threads`, before the next line", async () => {
  // A green draft: only the draft flag is left.
  const greenDraft = fixture("github/pr-passing.json")
    .replace(/"isDraft": *false/u, '"isDraft": true')
    .replace(/"mergeStateStatus": *"CLEAN"/u, '"mergeStateStatus": "DRAFT"');
  let status = greenDraft;
  const { repo } = setup("github", { ...githubBase(), [GH_STATUS]: () => status });
  const draft = await run(["pr", "status", "--json"], repo.cwd);
  expect(draft.json().data).toMatchObject({
    next: "MARK_READY",
    nextHint: "workit pr ready --pr 12",
  });
  const human = await run(["pr", "status"], repo.cwd);
  expect(human.stdout).toEndWith("do: workit pr ready --pr 12\nnext: MARK_READY\n");

  status = fixture("github/pr-failing-thread.json");
  const threads = await run(["pr", "status", "--log-lines", "0", "--json"], repo.cwd);
  expect(threads.json().data.nextHint).toStartWith("workit pr threads --pr 12; ");
});

test("pr status: a merged PR names the verdict its merge was accepted on, never a stale re-check of the moved branch", async () => {
  const { repo } = setup("github", {
    ...githubBase(),
    [GH_STATUS]: fixture("github/pr-merged.json"),
  });
  const untracked = await run(["pr", "status"], repo.cwd);
  expect(untracked.stdout).toContain("verdict: merged outside workit (no merge record)");
  const head = repo.git("rev-parse", "HEAD");
  const actor = { host: "cli", session: "s-lead", agentId: null };
  appendObserved(repo.cwd, {
    type: "pr.merged",
    actor,
    branch: "feature/x",
    head,
    pr: 12,
    base: "release",
    verdictId: "v-0",
  });
  // PR #12 on another base is a different PR.
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain("merged outside workit");
  appendObserved(repo.cwd, {
    type: "pr.merged",
    actor,
    branch: "feature/x",
    head,
    pr: 12,
    base: "main",
    verdictId: "v-1",
  });
  // The branch moves on after the merge: a re-check would read stale.
  repo.git("commit", "-q", "--allow-empty", "-m", "after merge");
  const merged = await run(["pr", "status", "--json"], repo.cwd);
  expect(merged.json().data.verdict.merge).toEqual({ head, verdictId: "v-1", unverified: false });
  const human = await run(["pr", "status"], repo.cwd);
  expect(human.stdout).toContain(
    `verdict: merged with accepted verdict v-1 at ${head.slice(0, 12)}`,
  );
  expect(human.stdout).not.toContain("not accepted");
  appendObserved(repo.cwd, {
    type: "pr.merged",
    actor,
    branch: "feature/x",
    head,
    pr: 12,
    verdictId: null,
    base: "main",
    unverified: "row-bypass-1",
  });
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    `verdict: merged unverified at ${head.slice(0, 12)} (recorded bypass)`,
  );
});

// ---------------------------------------------------------------------------
// GitLab draft titles

test("pr ready (GitLab): repeated markers are all stripped; a title of only markers is refused", async () => {
  let title = "[Draft] Draft: (draft) feat: x";
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [`GET ${GL}/merge_requests/12`]: () => glMr({ title, draft: /draft/iu.test(title) }),
    [`PUT ${GL}/merge_requests/12`]: (call) => {
      title = call.vars.title;
      return glMr({ title });
    },
  });
  expect((await run(["pr", "ready"], repo.cwd)).code).toBe(0);
  expect(writes(runner.calls).map((call) => call.vars.title)).toEqual(["feat: x"]);

  title = "Draft: [Draft]";
  const empty = await run(["pr", "ready", "--json"], repo.cwd);
  expect(empty.code).toBe(2);
  expect(empty.json().error).toContain("no title besides its draft marker");
  expect(writes(runner.calls)).toHaveLength(1);
});

test("pr edit (GitLab): on a non-draft MR, a user's 'Draft - ' title is sent as written", async () => {
  const { repo, runner } = setup("gitlab", {
    ...gitlabBase(),
    [`GET ${GL}/merge_requests/12`]: glMr({ title: "feat: x", draft: false }),
    [`PUT ${GL}/merge_requests/12`]: glMr({}),
  });
  const result = await run(["pr", "edit", "--title", "Draft - cleanup notes"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(writes(runner.calls)[0].pairs).toEqual([["title", "Draft - cleanup notes"]]);
});

// ---------------------------------------------------------------------------
// pr create reviewer validation happens before the PR is opened

test("pr create: a team of another org (GitHub) or any team (GitLab) is refused before anything is opened", async () => {
  const gh = setup("github", {
    ...githubBase(),
    "graphql find": fixture("github/find-none.json"),
    "POST repos/o/r/pulls": created,
  });
  const other = await run(
    ["pr", "create", "--title", "feat: x", "--reviewer", "elsewhere/core", "--json"],
    gh.repo.cwd,
  );
  expect(other.code).toBe(2);
  expect(other.json().error).toContain("team elsewhere/core is not in o");
  const comma = await run(
    ["pr", "create", "--title", "feat: x", "--label", "a,b", "--json"],
    gh.repo.cwd,
  );
  expect(comma.code).toBe(2);
  expect(writes(gh.runner.calls)).toEqual([]);

  const gl = setup("gitlab", {
    ...gitlabBase(),
    [GL_FIND]: "[]",
    [`POST ${GL}/merge_requests`]: glMr({}),
  });
  const team = await run(
    ["pr", "create", "--title", "feat: x", "--reviewer", "group/team", "--json"],
    gl.repo.cwd,
  );
  expect(team.code).toBe(2);
  expect(team.json().error).toContain("GitLab reviewers are usernames");
  expect(writes(gl.runner.calls)).toEqual([]);
});

// ---------------------------------------------------------------------------
// a truncated thread list

test("pr reply: given the thread list was cut at the page cap, then a thread not listed is read directly before refusing", async () => {
  const doc = JSON.parse(fixture("github/pr-failing-thread.json"));
  doc.data.repository.pullRequest.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "c1" };
  const page = JSON.stringify(doc);
  let node: unknown = { isResolved: false, pullRequest: { number: 12 } };
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/pulls/12": ghPull({}),
    "graphql status": page,
    "graphql node": () => JSON.stringify({ data: { node } }),
    "graphql resolveReviewThread": JSON.stringify({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    }),
  });
  const ok = await run(["pr", "reply", "--thread", "PRRT_far", "--resolve"], repo.cwd);
  expect(ok.code, ok.stdout).toBe(0);
  expect(writes(runner.calls).map((call) => call.vars)).toEqual([{ thread: "PRRT_far" }]);

  node = { isResolved: false, pullRequest: { number: 99 } };
  const elsewhere = await run(
    ["pr", "reply", "--thread", "PRRT_other", "--resolve", "--json"],
    repo.cwd,
  );
  expect(elsewhere.json().code).toBe("not_found");
  expect(writes(runner.calls)).toHaveLength(1);
});
