import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #912: right after a merge, `workit ci wait --branch main` failed with "no
// pull request for branch main" and the agent fell back to `gh run watch`.
// With no PR, the wait reads the branch's push runs; `--ref <b>` is the same
// call. All forge calls are replayed stubs.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-ci-wait-branch-config-");
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

const MAIN_HEAD = "c".repeat(40);

type Node = Record<string, unknown>;
const checkRun = (conclusion: string | null, status = "COMPLETED"): Node => ({
  __typename: "CheckRun",
  name: "test",
  status,
  conclusion,
  detailsUrl: "https://github.com/o/r/actions/runs/777",
  databaseId: 1,
  checkSuite: { workflowRun: { databaseId: 777, workflow: { name: "CI" } } },
});
const branchChecks = (nodes: Node[]) =>
  JSON.stringify({
    data: {
      repository: {
        object: {
          oid: MAIN_HEAD,
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      },
    },
  });

/** main's checks, one reply per poll (the last one repeats). */
const setup = (polls: Node[][]) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  let poll = 0;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    // The PRs found are all from feature/x: none for main.
    "graphql find": fixture("github/find-pr.json"),
    "graphql branch-checks": () => branchChecks(polls[Math.min(poll++, polls.length - 1)]),
  };
  const runner = replayRunner(routes, repo.subs);
  let clock = 0;
  Object.assign(forgeDeps, {
    runner,
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
  });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", account: "octo" },
        },
      ],
    }),
  );
  return { repo, polls: () => poll };
};

test("Given no PR for main and its push run still in progress, When ci wait --branch main runs, Then it waits and exits 0 once the run is green", async () => {
  const { repo, polls } = setup([[checkRun(null, "IN_PROGRESS")], [checkRun("SUCCESS")]]);
  const result = await run(["ci", "wait", "--branch", "main", "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json().data).toMatchObject({
    state: "ready",
    target: "branch",
    branch: "main",
    sha: MAIN_HEAD,
    polls: 2,
  });
  expect(polls()).toBe(2);
});

test("Given no PR for main and a red push run, When ci wait --branch main runs, Then it exits 1 naming the failing check and the rerun", async () => {
  const { repo } = setup([[checkRun("FAILURE")]]);
  const result = await run(["ci", "wait", "--branch", "main", "--json"], repo.cwd);
  expect(result.code).toBe(1);
  expect(result.json()).toMatchObject({
    code: "failed",
    data: { state: "failed", branch: "main" },
  });
  expect(result.json().error).toContain("CI fail on main");
  expect(result.json().unblock).toContain("workit ci rerun --ref main --failed --reason flake");
});

test("Given ci wait --ref main, When it runs, Then it behaves as --branch main", async () => {
  const { repo } = setup([[checkRun(null, "IN_PROGRESS")], [checkRun("SUCCESS")]]);
  const result = await run(["ci", "wait", "--ref", "main", "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json().data).toMatchObject({ state: "ready", branch: "main" });
  const human = await run(["ci", "wait", "--ref", "main"], repo.cwd);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("CI pass on main");
});

test("Given main's run still pending at the timeout, When ci wait --branch main ends, Then it exits 4 with a working Retry as", async () => {
  const { repo } = setup([[checkRun(null, "IN_PROGRESS")]]);
  const result = await run(
    ["ci", "wait", "--branch", "main", "--timeout", "1m", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(4);
  expect(result.json()).toMatchObject({
    code: "pending",
    unblock: "Retry as: workit ci wait --branch main",
  });
});

test("Given --ref with --branch, or a commit for --ref, When ci wait parses them, Then it refuses as usage naming the right call", async () => {
  const { repo } = setup([[checkRun("SUCCESS")]]);
  const both = await run(["ci", "wait", "--ref", "main", "--branch", "main"], repo.cwd);
  expect(both.code).toBe(2);
  const sha = await run(["ci", "wait", "--ref", "abcdef1"], repo.cwd);
  expect(sha.code).toBe(2);
  expect(sha.stderr).toContain("--head abcdef1");
});
