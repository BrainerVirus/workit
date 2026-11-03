import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #442: `workit pr merge` refuses a PR whose author is not the forge login
// unless `--others-pr --reason`; the override is recorded and the branch kept.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-author-config-");
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
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const setup = (author: string | null) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("rm", "-q", "feature.txt");
  writeFileSync(path.join(repo.cwd, "README.md"), "# Feature\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "--amend", "-m", "feature");
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    'graphql status {"owner":"o","name":"r","number":"12"}': () =>
      fixture(merged ? "github/pr-merged.json" : "github/pr-passing.json"),
    "GET repos/o/r/pulls/12": JSON.stringify({
      number: 12,
      html_url: "https://github.com/o/r/pull/12",
      state: "open",
      merged: false,
      title: "feat: x",
      user: author === null ? null : { login: author },
      base: { ref: "main", repo: { full_name: "o/r" } },
      head: { ref: "feature/x", repo: { full_name: "o/r" } },
    }),
    "GET repos/o/r/pulls?state=open&base=feature%2Fx&per_page=100": "[]",
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: "verified" },
          deleteBranch: true,
        },
      ],
    }),
  );
  return { repo, runner };
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

test("given a PR by another author, when merging, then it refuses naming the author and the override flag", async () => {
  const { repo, runner } = setup("colleague");
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().data.reason).toBe("others_pr");
  expect(result.json().error).toContain("colleague");
  expect(result.json().unblock).toContain("--others-pr --reason");
  expect(merges(runner.calls)).toEqual([]);
});

test("given an unreadable PR author, when merging, then it refuses rather than guess", async () => {
  const { repo, runner } = setup(null);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().data.reason).toBe("others_pr");
  expect(merges(runner.calls)).toEqual([]);
});

test("given --others-pr without a reason, when merging, then usage names --reason", async () => {
  const { repo, runner } = setup("colleague");
  const result = await run(["pr", "merge", "--others-pr", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain("--others-pr needs --reason");
  expect(merges(runner.calls)).toEqual([]);
});

test("given --others-pr and a reason, when merging, then it merges, records the reason and keeps the branch", async () => {
  const { repo, runner } = setup("colleague");
  const result = await run(
    ["pr", "merge", "--others-pr", "--reason", "owner asked", "--delete-branch", "--json"],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.othersPr).toEqual({
    author: "colleague",
    login: "octo",
    reason: "owner asked",
  });
  expect(result.json().data.deletedBranch.skipped).toContain(
    "never deletes another author's branch",
  );
  expect(merges(runner.calls)).toHaveLength(1);
  const ledger = await run(["ledger", "list", "--json"], repo.cwd);
  expect(ledger.stdout).toContain("owner asked");
});

test("given my own PR, when merging, then nothing changes", async () => {
  const { repo, runner } = setup("octo");
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.othersPr).toBeNull();
  expect(merges(runner.calls)).toHaveLength(1);
});
