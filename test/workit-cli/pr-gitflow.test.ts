import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
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
const setup = (preset: "gitflow" | "github-flow") => {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ branchPolicy: { preset } }));
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
          branchPolicy: { preset },
        },
      ],
    }),
  );
  const runner = replayRunner(routes(), repo.subs);
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
