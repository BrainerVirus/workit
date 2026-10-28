import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit pr create` without --base follows the git-flow route of the
// branch's kind: feature/bugfix -> develop, release/hotfix -> main (with a
// merge-back reminder); github-flow keeps the default target.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-gitflow-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

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

const routes = (): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  "graphql find": fixture("github/find-none.json"),
  "POST repos/o/r/pulls": JSON.stringify({
    number: 13,
    html_url: "https://github.com/o/r/pull/13",
    state: "open",
    head: { ref: "feature/x", sha: "{{HEAD}}" },
  }),
});

/** feature/x pushed; a local develop makes git-flow's integration branch exist. */
const POLICIES = {
  gitflow: { preset: "gitflow" },
  "github-flow": { preset: "github-flow" },
  custom: { preset: "custom", allowed: ["feature/*", "release/*"], protected: ["main"] },
} as const;

const setup = (preset: keyof typeof POLICIES, extra: Record<string, Reply> = {}) => {
  const branchPolicy = POLICIES[preset];
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ branchPolicy }));
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("branch", "develop", "main");
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          branchPolicy,
        },
      ],
    }),
  );
  const runner = replayRunner({ ...routes(), ...extra }, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

/** Put HEAD on `branch` (same commit as feature/x) and push it. */
const onBranch = (repo: ForgeRepo, branch: string) => {
  repo.git("switch", "-q", "-c", branch);
  repo.git("push", "-q", path.join(repo.root, "remote.git"), `${branch}:refs/heads/${branch}`);
};

const posted = (calls: readonly Call[]) =>
  calls.find((call) => call.method === "POST" && call.endpoint === "repos/o/r/pulls");

test("Given git-flow, When a feature PR is created without --base, Then it targets develop; --base main is refused", async () => {
  const { repo, runner } = setup("gitflow");
  const refused = await run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--json"],
    repo.cwd,
  );
  expect(refused.code).toBe(3);
  expect(refused.json().error).toBe(
    "gitflow_target: git-flow lands feature/* on develop, not main",
  );
  expect(refused.json().unblock).toContain("without --base it targets develop");
  expect(posted(runner.calls)).toBeUndefined();

  const created = await run(["pr", "create", "--title", "feat: x", "--json"], repo.cwd);
  expect(created.code, created.stdout + created.stderr).toBe(0);
  expect(created.json().data).toMatchObject({ base: "develop", flow: { kind: "feature" } });
  expect(posted(runner.calls)?.vars).toMatchObject({ base: "develop" });
});

test("Given git-flow, When a release or hotfix PR is created without --base, Then it targets main and reminds about merging back into develop", async () => {
  for (const branch of ["release/4.1.0", "hotfix/crash"]) {
    const { repo, runner } = setup("gitflow");
    onBranch(repo, branch);
    const created = await run(["pr", "create", "--title", "chore: release"], repo.cwd);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(created.stdout).toContain(`${branch} -> main`);
    expect(created.stdout).toContain(
      `merge back: git-flow: once ${branch} lands on main, bring main into develop`,
    );
    expect(created.stdout).toContain("workit git push --release develop");
    expect(posted(runner.calls)?.vars).toMatchObject({ base: "main" });
    // A fresh repository for the next kind.
    repos.splice(0).forEach((done) => done.cleanup());
  }
});

test("Given github-flow, When a release PR is created without --base, Then it targets main with no git-flow reminder", async () => {
  const { repo, runner } = setup("github-flow");
  onBranch(repo, "release/4.1.0");
  const created = await run(["pr", "create", "--title", "chore: release", "--json"], repo.cwd);
  expect(created.code, created.stdout + created.stderr).toBe(0);
  expect(created.json().data.base).toBe("main");
  expect(created.json().data.flow).toBeUndefined();
  expect(posted(runner.calls)?.vars).toMatchObject({ base: "main" });
});

test("Given git-flow, When a release PR names develop explicitly, Then the back-merge target is accepted", async () => {
  const { repo } = setup("gitflow");
  onBranch(repo, "release/4.1.0");
  const created = await run(
    ["pr", "create", "--base", "develop", "--title", "chore: back-merge", "--json"],
    repo.cwd,
  );
  expect(created.code, created.stdout + created.stderr).toBe(0);
  expect(created.json().data.base).toBe("develop");
});

test("Given a release branch with an open PR into main, When pr create --base develop runs, Then it opens the back-merge PR instead of reusing the main one", async () => {
  const openIntoMain = JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 12,
              url: "https://github.com/o/r/pull/12",
              state: "OPEN",
              baseRefName: "main",
              headRefName: "release/4.1.0",
              headRepositoryOwner: { login: "o" },
              headRefOid: "{{HEAD}}",
            },
          ],
        },
      },
    },
  });
  const { repo, runner } = setup("gitflow", { "graphql find": openIntoMain });
  onBranch(repo, "release/4.1.0");
  // Into main: the open PR is reused, nothing is posted.
  const reused = await run(["pr", "create", "--title", "chore: release", "--json"], repo.cwd);
  expect(reused.code, reused.stdout + reused.stderr).toBe(0);
  expect(reused.json().data).toMatchObject({ number: 12, base: "main", created: false });
  expect(posted(runner.calls)).toBeUndefined();
  // Into develop: a new PR, not #12.
  const backMerge = await run(
    ["pr", "create", "--base", "develop", "--title", "chore: back-merge", "--json"],
    repo.cwd,
  );
  expect(backMerge.code, backMerge.stdout + backMerge.stderr).toBe(0);
  expect(backMerge.json().data).toMatchObject({ number: 13, base: "develop", created: true });
  expect(posted(runner.calls)?.vars).toMatchObject({ base: "develop" });
});

test("per preset, When pr create runs on feature and release branches, Then the target follows the preset and only git-flow refuses --base main or reminds about merging back", async () => {
  const table = {
    gitflow: {
      feature: "develop",
      release: "main",
      featureMain: "gitflow_target",
      mergeBack: true,
    },
    "github-flow": { feature: "main", release: "main", featureMain: null, mergeBack: false },
    custom: { feature: "develop", release: "develop", featureMain: null, mergeBack: false },
  } as const;
  for (const [preset, expected] of Object.entries(table) as Array<
    [keyof typeof table, (typeof table)[keyof typeof table]]
  >) {
    {
      const { repo } = setup(preset);
      const target = await run(["pr", "create", "--title", "feat: x", "--json"], repo.cwd);
      expect(target.code, `${preset}: ${target.stdout}`).toBe(0);
      expect(target.json().data.base, preset).toBe(expected.feature);
      const intoMain = await run(
        ["pr", "create", "--base", "main", "--title", "feat: x", "--json"],
        repo.cwd,
      );
      if (expected.featureMain)
        expect(intoMain.json().error, preset).toContain(expected.featureMain);
      else expect(intoMain.code, `${preset}: ${intoMain.stdout}`).toBe(0);
      repos.splice(0).forEach((done) => done.cleanup());
    }
    const { repo } = setup(preset);
    onBranch(repo, "release/4.1.0");
    const release = await run(["pr", "create", "--title", "chore: release"], repo.cwd);
    expect(release.code, `${preset}: ${release.stdout}`).toBe(0);
    expect(release.stdout, preset).toContain(`release/4.1.0 -> ${expected.release}`);
    expect(release.stdout.includes("merge back:"), preset).toBe(expected.mergeBack);
    repos.splice(0).forEach((done) => done.cleanup());
  }
});

// ---------------------------------------------------------------------------
// The forge lookup: head AND base, a missing base field fails open (reuse),
// and no base named with open PRs into several bases is never guessed.

const RELEASE = "release/4.1.0";

const githubFind = (nodes: Array<Record<string, unknown>>) =>
  JSON.stringify({ data: { repository: { pullRequests: { nodes } } } });
const githubNode = (number: number, base: string | undefined) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: "OPEN",
  ...(base === undefined ? {} : { baseRefName: base }),
  headRefName: RELEASE,
  headRepositoryOwner: { login: "o" },
  headRefOid: "{{HEAD}}",
});

const GL = "projects/group%2Fproject";
const GL_FIND = `GET ${GL}/merge_requests?source_branch=${encodeURIComponent(RELEASE)}&order_by=created_at&sort=desc&per_page=20`;
const gitlabMr = (iid: number, target: string | undefined) => ({
  iid,
  state: "opened",
  source_branch: RELEASE,
  web_url: `https://gitlab.com/group/project/-/merge_requests/${iid}`,
  sha: "{{HEAD}}",
  ...(target === undefined ? {} : { target_branch: target }),
  source_project_id: 34675721,
});

/** A git-flow checkout on release/4.1.0 (pushed) against GitLab. */
const gitlabSetup = (find: unknown[]) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: POLICIES.gitflow }),
  );
  const repo = makeForgeRepo("gitlab");
  repos.push(repo);
  repo.git("branch", "develop", "main");
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "gitlab", account: "octo" },
          branchPolicy: POLICIES.gitflow,
        },
      ],
    }),
  );
  const runner = replayRunner(
    {
      "GET user": fixture("gitlab/user.json"),
      [`GET ${GL}`]: fixture("gitlab/project.json"),
      [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
      [GL_FIND]: JSON.stringify(find),
      [`POST ${GL}/merge_requests`]: JSON.stringify(gitlabMr(13, "develop")),
    },
    repo.subs,
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  onBranch(repo, RELEASE);
  return { repo, runner };
};

const glPosted = (calls: readonly Call[]) =>
  calls.find((call) => call.method === "POST" && call.endpoint === `${GL}/merge_requests`);

test("GitLab: an open MR into main is reused for main; --base develop opens the back-merge MR", async () => {
  const { repo, runner } = gitlabSetup([gitlabMr(12, "main")]);
  const reused = await run(["pr", "create", "--title", "chore: release", "--json"], repo.cwd);
  expect(reused.code, reused.stdout + reused.stderr).toBe(0);
  expect(reused.json().data).toMatchObject({ number: 12, base: "main", created: false });
  expect(glPosted(runner.calls)).toBeUndefined();
  const backMerge = await run(
    ["pr", "create", "--base", "develop", "--title", "chore: back-merge", "--json"],
    repo.cwd,
  );
  expect(backMerge.code, backMerge.stdout + backMerge.stderr).toBe(0);
  expect(backMerge.json().data).toMatchObject({ number: 13, created: true });
  expect(glPosted(runner.calls)?.vars).toMatchObject({ target_branch: "develop" });
});

test("a forge reply without the base field fails open: the open PR or MR is reused, on GitHub and GitLab", async () => {
  {
    const { repo, runner } = setup("gitflow", {
      "graphql find": githubFind([githubNode(12, undefined)]),
    });
    onBranch(repo, RELEASE);
    const reused = await run(
      ["pr", "create", "--base", "develop", "--title", "chore: x", "--json"],
      repo.cwd,
    );
    expect(reused.code, reused.stdout + reused.stderr).toBe(0);
    expect(reused.json().data).toMatchObject({ number: 12, created: false });
    expect(posted(runner.calls)).toBeUndefined();
    repos.splice(0).forEach((done) => done.cleanup());
  }
  const { repo, runner } = gitlabSetup([gitlabMr(12, undefined)]);
  const reused = await run(
    ["pr", "create", "--base", "develop", "--title", "chore: x", "--json"],
    repo.cwd,
  );
  expect(reused.code, reused.stdout + reused.stderr).toBe(0);
  expect(reused.json().data).toMatchObject({ number: 12, created: false });
  expect(glPosted(runner.calls)).toBeUndefined();
});

test("Given open PRs into main and develop, When pr status or pr merge run without --pr, Then the ambiguity is reported, never the newest guessed", async () => {
  {
    const { repo } = setup("gitflow", {
      "graphql find": githubFind([githubNode(13, "develop"), githubNode(12, "main")]),
    });
    onBranch(repo, RELEASE);
    grantMerge();
    for (const verb of ["status", "merge"]) {
      const result = await run(["pr", verb, "--json"], repo.cwd);
      expect(result.code, verb).toBe(3);
      expect(result.json().error, verb).toBe(
        `ambiguous_pr: ${RELEASE} has open pull requests #13 -> develop, #12 -> main`,
      );
      expect(result.json().unblock).toContain("--pr 13");
    }
    repos.splice(0).forEach((done) => done.cleanup());
  }
  const { repo } = gitlabSetup([gitlabMr(13, "develop"), gitlabMr(12, "main")]);
  const result = await run(["pr", "status", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain(
    "ambiguous_pr: release/4.1.0 has open merge requests !13 -> develop, !12 -> main",
  );
});

/** Add the merge grant to the workspace setup() wrote. */
const grantMerge = () => {
  const ws = path.join(configDir, "workspaces.json");
  const doc = JSON.parse(readFileSync(ws, "utf8"));
  doc.workspaces[0].autonomy = { merge: "verified" };
  writeFileSync(ws, JSON.stringify(doc));
};

test("Given git-flow, When pr merge lands a release PR on main, Then it reports the merge back into develop", async () => {
  let landed = false;
  const { repo } = setup("gitflow", {
    "graphql find": githubFind([githubNode(12, "main")]),
    'graphql status {"owner":"o","name":"r","number":"12"}': () =>
      fixture(landed ? "github/pr-merged.json" : "github/pr-passing.json").replaceAll(
        '"feature/x"',
        `"${RELEASE}"`,
      ),
    "PUT repos/o/r/pulls/12/merge": () => {
      landed = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  });
  onBranch(repo, RELEASE);
  grantMerge();
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code, verdict.stdout + verdict.stderr).toBe(0);
  const merged = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(merged.code, merged.stdout + merged.stderr).toBe(0);
  expect(merged.json().data).toMatchObject({
    base: "main",
    mergeBack: ["develop"],
    mergeBackTrack: "git-flow",
  });
});
