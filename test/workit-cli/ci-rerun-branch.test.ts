import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { rerunLogPath } from "@/packages/workit-core/src/forge/reruns";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// `ci rerun --ref <b>`: reruns the failed jobs of a branch's latest CI run
// (a base gone red on a flake) with the PR form's record and once-per-head
// limit, and `pr merge`'s base_red refusal names it. All forge calls are
// replayed stubs.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-ci-rerun-branch-config-");
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

const BASE_HEAD = "b".repeat(40);
const RUN_URL = "https://github.com/o/r/actions/runs/777";

type Node = Record<string, unknown>;
const checkRun = (name: string, conclusion: string, runId: number, jobId: number): Node => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion,
  detailsUrl: RUN_URL,
  databaseId: jobId,
  checkSuite: { workflowRun: { databaseId: runId, workflow: { name: "CI" } } },
});
const branchChecks = (nodes: Node[]) =>
  JSON.stringify({
    data: {
      repository: {
        object: {
          oid: BASE_HEAD,
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      },
    },
  });

/** main's latest run: `fast checks` failed in run 777, `unit` passed in run 778. */
const RED_MAIN = [checkRun("unit", "SUCCESS", 778, 2), checkRun("fast checks", "FAILURE", 777, 1)];

const setup = (extra: Record<string, Reply> = {}) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    "graphql status": fixture("github/pr-passing.json"),
    "graphql branch-checks": branchChecks(RED_MAIN),
    "POST repos/o/r/actions/runs/777/rerun-failed-jobs": "",
    ...extra,
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
          autonomy: { rerun: true, merge: "verified" },
        },
      ],
    }),
  );
  return { repo, runner };
};

const posts = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "POST").map((call) => call.endpoint);
const rerunRows = (cwd: string) =>
  readFileSync(rerunLogPath(cwd)!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("given main's latest run has failed jobs, when ci rerun --ref main --failed --reason flake, then only that run's failed jobs are rerun and a row records branch, run id and reason", async () => {
  const { repo, runner } = setup();
  const result = await run(
    ["ci", "rerun", "--ref", "main", "--failed", "--reason", "flake", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toEqual({
    pr: null,
    branch: "main",
    head: BASE_HEAD,
    reason: "flake",
    forced: false,
    rerun: [{ name: "CI / fast checks", runId: 777, jobId: 1 }],
    skipped: [],
    recorded: true,
  });
  // The failed-jobs endpoint of the failed run only; the green run is left alone.
  expect(posts(runner.calls)).toEqual(["repos/o/r/actions/runs/777/rerun-failed-jobs"]);
  expect(rerunRows(repo.cwd)).toEqual([
    expect.objectContaining({
      type: "ci.rerun",
      repo: "o/r",
      pr: null,
      branch: "main",
      head: BASE_HEAD,
      runId: 777,
      check: "CI / fast checks",
      reason: "flake",
      forced: false,
    }),
  ]);
});

test("given main's head was already rerun once, when it is rerun again, then it is refused with the PR form's rerun_limit, and --force reruns it", async () => {
  const { repo, runner } = setup();
  const argv = ["ci", "rerun", "--ref", "main", "--failed", "--reason", "flake", "--json"];
  expect((await run(argv, repo.cwd)).code).toBe(0);
  const second = await run(argv, repo.cwd);
  expect(second.code).toBe(3);
  expect(second.json()).toMatchObject({
    code: "blocked",
    error: `rerun_limit: CI / fast checks already rerun once on head ${BASE_HEAD.slice(0, 12)}`,
    unblock:
      "treat it as a real failure and fix it; if it is a confirmed flake, rerun with --force",
  });
  expect(posts(runner.calls)).toHaveLength(1);
  const forced = await run([...argv, "--force"], repo.cwd);
  expect(forced.code).toBe(0);
  expect(forced.json().data.forced).toBe(true);
  expect(rerunRows(repo.cwd)).toHaveLength(2);
});

test("given main's latest run is green, when ci rerun --ref main --failed, then nothing is rerun", async () => {
  const { repo, runner } = setup({
    "graphql branch-checks": branchChecks([checkRun("unit", "SUCCESS", 778, 2)]),
  });
  const result = await run(
    ["ci", "rerun", "--ref", "main", "--failed", "--reason", "flake", "--json"],
    repo.cwd,
  );
  expect(result.code).not.toBe(0);
  expect(result.json().code).toBe("not_found");
  expect(posts(runner.calls)).toEqual([]);
});

test("given pr merge refuses with base_red, then its unblock line is the ci rerun --ref <base> command", async () => {
  const { repo } = setup();
  repo.git("rm", "-q", "feature.txt");
  writeFileSync(path.join(repo.cwd, "README.md"), "# Feature\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "--amend", "-m", "feature");
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().data.reason).toBe("base_red");
  expect(result.json().unblock).toStartWith("workit ci rerun --ref main --failed --reason flake");
  expect(result.json().unblock).toContain("--base-red-ok --reason");
});

test("given neither --pr nor --branch and no PR for the current branch, then the error names the PR and the --ref forms", async () => {
  const { repo, runner } = setup({ "graphql find": fixture("github/find-none.json") });
  const result = await run(["ci", "rerun", "--failed", "--reason", "flake", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  const envelope = result.json();
  expect(envelope.code).toBe("not_found");
  expect(envelope.unblock).toContain("workit ci rerun --pr <n>");
  expect(envelope.unblock).toContain("workit ci rerun --ref <branch>");
  expect(posts(runner.calls)).toEqual([]);
});

test("given --branch <b> with no PR, then the unblock is the ci rerun --ref <b> command", async () => {
  const { repo, runner } = setup({ "graphql find": fixture("github/find-none.json") });
  const result = await run(
    ["ci", "rerun", "--branch", "feature/x", "--failed", "--reason", "flake", "--json"],
    repo.cwd,
  );
  expect(result.code).not.toBe(0);
  expect(result.json().code).toBe("not_found");
  expect(result.json().unblock).toStartWith(
    "workit ci rerun --ref feature/x --failed --reason flake",
  );
  expect(posts(runner.calls)).toEqual([]);
});

test("given --branch <b> with an open PR, then the PR's head is rerun, as before --ref existed", async () => {
  const { repo, runner } = setup({
    "graphql status": fixture("github/pr-failing-thread.json"),
    "POST repos/o/r/actions/runs/1/rerun-failed-jobs": "",
  });
  const result = await run(
    ["ci", "rerun", "--branch", "feature/x", "--failed", "--reason", "flake", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ pr: 12, branch: null, head: repo.head });
  expect(posts(runner.calls)).toEqual(["repos/o/r/actions/runs/1/rerun-failed-jobs"]);
  expect(runner.calls.some((call) => call.op === "branch-checks")).toBe(false);
});

test("given --pr, --branch and --ref together, then it is a usage error naming them", async () => {
  const { repo, runner } = setup();
  const result = await run(
    [
      "ci",
      "rerun",
      "--branch",
      "feature/x",
      "--ref",
      "main",
      "--failed",
      "--reason",
      "flake",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.json()).toMatchObject({ code: "invalid_input" });
  expect(result.json().error).toContain("--branch and --ref");
  expect(posts(runner.calls)).toEqual([]);
});
