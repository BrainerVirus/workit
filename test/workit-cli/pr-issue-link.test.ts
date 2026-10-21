import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #324: `workit pr create --issue` links PRs/MRs to issues on GitHub, GitLab
// and YouTrack, records `pr.linked`, backlinks on request, and `pr status`
// lists the links. Recorded API shapes replay through a fake gh/glab.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-issue-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json", "youtrack.json", "youtrack.token"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const linkedRows = (cwd: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "pr.linked");
};

const workspace = (repo: ForgeRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const setup = (kind: "github" | "gitlab", routes: Record<string, Reply>) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

/** Check out and push `branch` (one more commit) to the offline bare remote. */
const onBranch = (repo: ForgeRepo, branch: string): string => {
  repo.git("switch", "-q", "-c", branch);
  writeFileSync(path.join(repo.cwd, "more.txt"), `${branch}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "more");
  repo.git("push", "-q", path.join(repo.root, "remote.git"), branch);
  const head = repo.git("rev-parse", "HEAD");
  repo.subs["{{HEAD}}"] = head;
  return head;
};

const githubRoutes = (extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "graphql find": fixture("github/find-none.json"),
  "POST repos/o/r/pulls": (call) =>
    JSON.stringify({
      number: 12,
      html_url: "https://github.com/o/r/pull/12",
      state: "open",
      head: { ref: call.vars.head, sha: "{{HEAD}}" },
    }),
  ...extra,
});

const postedBody = (calls: readonly Call[]): string =>
  calls.find((call) => call.method === "POST" && /pulls$|merge_requests$/u.test(call.endpoint))
    ?.vars.body ??
  calls.find((call) => call.method === "POST" && call.endpoint.endsWith("merge_requests"))?.vars
    .description ??
  "";

test("pr create: given a YouTrack tracker, when --issue IRPT-74 --issue IRPT-75 runs, then the body links both and the ledger has one pr.linked row per issue", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  workspace(repo, {
    issues: { provider: "youtrack", link: true },
    youtrack: { baseUrl: "https://yt.example.test/" },
  });
  const result = await run(
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "feat: x",
      "--body",
      "Why: y",
      "--issue",
      "IRPT-74",
      "--issue",
      "https://yt.example.test/issue/IRPT-75",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe(
    "Why: y\n\nRelated to: https://yt.example.test/issue/IRPT-74\nRelated to: https://yt.example.test/issue/IRPT-75",
  );
  expect(linkedRows(repo.cwd)).toEqual([
    expect.objectContaining({
      observer: "workit_cli",
      pr: 12,
      repo: "o/r",
      tracker: "youtrack",
      issue: "IRPT-74",
      relation: "related",
      source: "flag",
    }),
    expect.objectContaining({ pr: 12, tracker: "youtrack", issue: "IRPT-75" }),
  ]);
});

test("pr create: given a GitHub tracker, when --issue 42 --refs is passed, then the body says Refs #42, not Closes #42", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  workspace(repo, { vcs: { provider: "github" }, issues: { provider: "github" } });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "#42", "--refs"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Refs #42");
  expect(result.stdout).toContain("linked #42");
});

test("pr create: an unreadable --issue is a usage error before any forge write", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "not an issue", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(2);
  expect(result.json().error).toContain('cannot read issue "not an issue"');
  expect(runner.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("pr create: given no --issue and a branch feature/42-x, then the legacy link_on_pr link is unchanged", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  onBranch(repo, "feature/42-x");
  workspace(repo, {
    vcs: { provider: "github" },
    issues: { provider: "github", link_on_pr: true },
  });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--body", "Why: y"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Why: y\n\nCloses #42");
  expect(linkedRows(repo.cwd)).toEqual([
    expect.objectContaining({ issue: "42", tracker: "github", source: "branch" }),
  ]);
});

test("pr create: given an old config with youtrack.link_issues true, then a branch id links like issues { provider: youtrack, link: true }", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  onBranch(repo, "feature/IRPT-740-x");
  workspace(repo, { youtrack: { link_issues: true, baseUrl: "https://yt.example.test" } });
  const result = await run(["pr", "create", "--base", "main", "--title", "feat: x"], repo.cwd);
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Related to: https://yt.example.test/issue/IRPT-740");
});

const GL = "projects/group%2Fproject";

test("pr create (GitLab): given GitLab issues, when --issue 7 runs, then the MR description carries Closes #7", async () => {
  const { repo, runner } = setup("gitlab", {
    "GET user": fixture("gitlab/user.json"),
    [`GET ${GL}`]: fixture("gitlab/project.json"),
    [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
    [`GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`]:
      "[]",
    [`POST ${GL}/merge_requests`]: JSON.stringify({
      iid: 13,
      web_url: "https://gitlab.com/group/project/-/merge_requests/13",
      state: "opened",
      source_branch: "feature/x",
      sha: "{{HEAD}}",
    }),
  });
  workspace(repo, { vcs: { provider: "gitlab" }, issues: { provider: "gitlab" } });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "7", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  const post = runner.calls.find((call) => call.endpoint === `${GL}/merge_requests`);
  expect(post?.vars.description).toBe("Closes #7");
  expect(result.json().data.issues).toEqual([
    expect.objectContaining({ issue: "#7", tracker: "gitlab", relation: "closes" }),
  ]);
});

const createIssue = (issue: string) => [
  "pr",
  "create",
  "--base",
  "main",
  "--title",
  "feat: x",
  "--issue",
  issue,
  "--json",
];

test("pr create: given backlink true, then each issue gets one comment with the PR URL, and a comment already there is not posted again", async () => {
  const comments: string[] = ["an unrelated comment"];
  const { repo } = setup(
    "github",
    githubRoutes({
      "GET repos/o/r/issues/42/comments?per_page=100": () =>
        JSON.stringify(comments.map((body) => ({ body }))),
      "POST repos/o/r/issues/42/comments": (call) => {
        comments.push(call.vars.body);
        return JSON.stringify({ id: 1 });
      },
    }),
  );
  workspace(repo, { vcs: { provider: "github" }, issues: { provider: "github", backlink: true } });
  const first = await run(createIssue("42"), repo.cwd);
  expect(first.code).toBe(0);
  expect(first.json().data.backlinks).toEqual([{ issue: "#42", status: "done" }]);
  expect(comments[1]).toStartWith("Linked from PR #12: https://github.com/o/r/pull/12");

  // The same PR URL again: the marker is read back, nothing is posted.
  const again = await run(createIssue("42"), repo.cwd);
  expect(again.json().data.backlinks).toEqual([{ issue: "#42", status: "already_done" }]);
  expect(comments).toHaveLength(2);
});

test("pr create: given a GitHub forge and GitLab issues, when --issue 7 runs, then the body links the GitLab issue by URL and the backlink is skipped: no account is verified on gitlab.com", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  workspace(repo, {
    vcs: { provider: "github" },
    issues: { provider: "gitlab", repo: "group/project", backlink: true },
  });
  const result = await run(createIssue("7"), repo.cwd);
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Related to: https://gitlab.com/group/project/-/issues/7");
  expect(result.json().data.backlinks).toEqual([
    {
      issue: "https://gitlab.com/group/project/-/issues/7",
      status: "skipped",
      note: "an issue on another forge host is not backlinked: no verified account for gitlab.com",
    },
  ]);
  expect(runner.calls.some((call) => call.endpoint.includes("/issues/7/notes"))).toBe(false);
  expect(runner.calls.some((call) => call.bin === "glab")).toBe(false);
  expect(linkedRows(repo.cwd)).toEqual([
    expect.objectContaining({
      tracker: "gitlab",
      issue: "7",
      issueRepo: "group/project",
      issueUrl: "https://gitlab.com/group/project/-/issues/7",
      relation: "related",
    }),
  ]);
});

test("pr create: given issues in another repository on the same host and vcs.account, then the backlink reads and posts there with the workspace account's token", async () => {
  const TOKEN = "gho_token_for_octo_0000000000000000";
  const comments: string[] = [];
  const COMMENTS = "repos/o/other/issues/9/comments";
  const { repo, runner } = setup(
    "github",
    githubRoutes({
      "CLI auth token --hostname github.com --user octo": TOKEN,
      [`GET ${COMMENTS}?per_page=100`]: () => JSON.stringify(comments.map((body) => ({ body }))),
      [`POST ${COMMENTS}`]: (call) => {
        comments.push(call.vars.body);
        return JSON.stringify({ id: 1 });
      },
    }),
  );
  workspace(repo, {
    vcs: { provider: "github", account: "octo" },
    issues: { provider: "github", repo: "o/other", backlink: true },
  });
  const result = await run(createIssue("9"), repo.cwd);
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Closes o/other#9");
  expect(result.json().data.backlinks).toEqual([{ issue: "o/other#9", status: "done" }]);
  const backlink = runner.calls.filter((call) => call.endpoint.startsWith(COMMENTS));
  expect(backlink.map((call) => [call.method, call.token])).toEqual([
    ["GET", TOKEN],
    ["POST", TOKEN],
  ]);
  const create = runner.calls.find((call) => call.endpoint === "repos/o/r/pulls");
  expect(create?.token).toBe(TOKEN);
  expect(runner.calls.filter((call) => call.method !== "CLI" && call.token !== TOKEN)).toEqual([]);
  expect(comments[0]).toStartWith("Linked from PR #12: https://github.com/o/r/pull/12");
});

/** A local YouTrack: comments are kept and every request is logged. */
const youTrackServer = () => {
  const requests: Array<{ method: string; path: string }> = [];
  const comments: Array<{ id: string; text: string; deleted: boolean }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      if (/\/api\/issues\/[^/]+\/comments$/u.test(url.pathname)) {
        if (request.method === "POST") {
          const comment = {
            id: `c${comments.length + 1}`,
            text: String((JSON.parse(await request.text()) as { text: unknown }).text),
            deleted: false,
          };
          comments.push(comment);
          return Response.json(comment);
        }
        return Response.json(comments);
      }
      return Response.json({ id: "x" });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, comments, stop: () => server.stop() };
};

test("pr create: given backlink true and a YouTrack issue, then the comment is posted once through the YouTrack API, and without WORKFLOW_YT_WRITE=1 nothing is written", async () => {
  const yt = youTrackServer();
  const previous = process.env.WORKFLOW_YT_WRITE;
  try {
    const { repo } = setup("github", githubRoutes());
    const token = path.join(configHome.configDir, "youtrack.token");
    writeFileSync(token, "perm:abc\n", { mode: 0o600 });
    writeFileSync(
      path.join(configHome.configDir, "youtrack.json"),
      JSON.stringify({ baseUrl: yt.url, tokenFile: token }),
    );
    workspace(repo, { issues: { provider: "youtrack", backlink: true } });

    delete process.env.WORKFLOW_YT_WRITE;
    const refused = await run(createIssue("IRPT-74"), repo.cwd);
    expect(refused.code).toBe(0);
    expect(refused.json().data.backlinks).toEqual([
      {
        issue: "IRPT-74",
        status: "failed",
        note: "YouTrack writes need WORKFLOW_YT_WRITE=1 (as for workit youtrack note)",
      },
    ]);
    expect(yt.requests).toEqual([]);

    process.env.WORKFLOW_YT_WRITE = "1";
    const posted = await run(createIssue("IRPT-74"), repo.cwd);
    expect(posted.json().data.backlinks).toEqual([{ issue: "IRPT-74", status: "done" }]);
    expect(yt.comments).toHaveLength(1);
    expect(yt.comments[0].text).toStartWith(
      "Linked from PR #12: https://github.com/o/r/pull/12\n\n<!-- workit-action:",
    );
    // The body links through youtrack.json's baseUrl when the workspace names none.
    expect(posted.json().data.issues[0].line).toBe(`Related to: ${yt.url}/issue/IRPT-74`);

    const again = await run(createIssue("IRPT-74"), repo.cwd);
    expect(again.json().data.backlinks).toEqual([{ issue: "IRPT-74", status: "already_done" }]);
    expect(yt.comments).toHaveLength(1);
    expect(linkedRows(repo.cwd).at(-1)).toMatchObject({ tracker: "youtrack", relation: "related" });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_YT_WRITE;
    else process.env.WORKFLOW_YT_WRITE = previous;
    await yt.stop();
  }
});

test("pr create: given backlink false (the default), then no issue comment is read or posted", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  workspace(repo, { vcs: { provider: "github" }, issues: { provider: "github" } });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "42", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data.backlinks).toBeUndefined();
  expect(runner.calls.some((call) => call.endpoint.includes("/issues/"))).toBe(false);
});

test("pr create: an open PR for the branch is reused, its body is left alone and no link is recorded", async () => {
  const { repo, runner } = setup(
    "github",
    githubRoutes({ "graphql find": fixture("github/find-pr.json") }),
  );
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "42"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("issues not linked: the PR was already open");
  expect(runner.calls.some((call) => call.method === "POST")).toBe(false);
  expect(linkedRows(repo.cwd)).toEqual([]);
});

test("pr status: given a linked PR, then it lists the linked issues", async () => {
  const { repo } = setup(
    "github",
    githubRoutes({
      'graphql status {"owner":"o","name":"r","number":"12"}': fixture("github/pr-passing.json"),
    }),
  );
  workspace(repo, {
    issues: { provider: "github" },
    youtrack: { baseUrl: "https://yt.example.test" },
  });
  const created = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--issue", "42", "--issue", "IRPT-74"],
    repo.cwd,
  );
  expect(created.code).toBe(0);
  forgeDeps.runner = replayRunner(
    {
      ...githubRoutes(),
      "graphql find": fixture("github/find-pr.json"),
      'graphql status {"owner":"o","name":"r","number":"12"}': fixture("github/pr-passing.json"),
    },
    repo.subs,
  );
  const status = await run(["pr", "status", "--log-lines", "0", "--json"], repo.cwd);
  expect(status.code).toBe(0);
  expect(status.json().data.issues).toEqual([
    expect.objectContaining({ tracker: "github", issue: "42", relation: "closes" }),
    expect.objectContaining({ tracker: "youtrack", issue: "IRPT-74" }),
  ]);
  const human = await run(["pr", "status", "--log-lines", "0"], repo.cwd);
  expect(human.stdout).toContain("issues: #42 (closes), IRPT-74 (related)");
});

test("pr create: given a fanout slice with issue #324 on the branch, then the PR links it without --issue", async () => {
  const { repo, runner } = setup("github", githubRoutes());
  const plan = path.join(repo.root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "link",
          branch: "feature/x",
          tier: "standard",
          goal: "link issues",
          scope: ["src/**"],
          acceptance: ["links"],
          verify: ["bun test"],
          forbidden: ["no merges"],
          issue: "#324",
        },
      ],
    }),
  );
  const planned = await run(["fanout", "plan", plan, "--json"], repo.cwd);
  expect(planned.code).toBe(0);
  const brief = await run(["fanout", "brief", "link"], repo.cwd);
  expect(brief.stdout).toContain("ISSUE: #324");
  const result = await run(["pr", "create", "--base", "main", "--title", "feat: x"], repo.cwd);
  expect(result.code).toBe(0);
  expect(postedBody(runner.calls)).toBe("Closes #324");
  expect(linkedRows(repo.cwd)).toEqual([
    expect.objectContaining({ issue: "324", source: "fanout" }),
  ]);
});
