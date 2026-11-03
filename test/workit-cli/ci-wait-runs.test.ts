import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
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

// #646: the check rollup listed a check pending after the head's Actions run
// had succeeded, and `ci wait` timed out "still pending". The runs API keys
// on the head SHA; when it says every run completed, ci wait trusts it.
// #638: the first line says how long the wait may take and how to background it.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-ci-wait-runs-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const repo of repos.splice(0)) repo.cleanup();
});

const STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';
const RUNS = "GET repos/o/r/actions/runs?head_sha={{HEAD}}&per_page=100";

const setup = (runs: Reply) => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const runner = replayRunner(
    {
      "GET user": fixture("github/user.json"),
      "GET repos/o/r": fixture("github/repo.json"),
      "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
      "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
      "graphql find": fixture("github/find-pr.json"),
      [STATUS]: fixture("github/pr-pending.json"),
      [RUNS.replace("{{HEAD}}", repo.head)]: runs,
    },
    repo.subs,
  );
  let clock = 0;
  Object.assign(forgeDeps, {
    runner,
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
  });
  return repo;
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: process.env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const runs = (status: string, conclusion: string | null) =>
  JSON.stringify({
    workflow_runs: [
      {
        id: 1,
        name: "CI",
        workflow_id: 7,
        head_sha: "{{HEAD}}",
        status,
        conclusion,
        html_url: "https://github.com/o/r/actions/runs/1",
      },
    ],
  });

test("Given the head's run already succeeded while the rollup still lists a check queued, When ci wait runs, Then it reports success on its first poll", async () => {
  const repo = setup(runs("completed", "success"));
  const result = await run(["ci", "wait", "--timeout", "2m", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json()).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      reason: "runs_passed",
      polls: 1,
      runs: [{ id: 1, name: "CI", conclusion: "success" }],
      rollupPending: ["CI / test (ubuntu-latest)"],
    },
  });
  const human = await run(["ci", "wait", "--timeout", "2m"], repo.cwd);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("CI pass (runs_passed) after 1 poll");
  expect(human.stdout).toContain("run 1 CI: success  https://github.com/o/r/actions/runs/1");
});

test("Given the head's run is still in progress, When ci wait times out, Then it still reports pending", async () => {
  const repo = setup(runs("in_progress", null));
  const result = await run(["ci", "wait", "--timeout", "1m", "--json"], repo.cwd);
  expect(result.code).toBe(4);
  expect(result.json()).toMatchObject({
    code: "pending",
    data: { state: "in_progress", reason: "checks_pending" },
  });
});

test("Given the head's run failed, When the rollup still lists a check queued, Then ci wait never reports success", async () => {
  const repo = setup(runs("completed", "failure"));
  const result = await run(["ci", "wait", "--timeout", "1m", "--json"], repo.cwd);
  expect(result.code).toBe(4);
});

test("Given ci wait starts, When it prints its first line, Then the line says how long it may wait and how to run it in the background", async () => {
  const repo = setup(runs("completed", "success"));
  const result = await run(["ci", "wait", "--pr", "12", "--timeout", "20m"], repo.cwd);
  const first = result.stderr.split("\n")[0];
  expect(first).toContain("waiting on CI for PR #12 for up to 20m");
  expect(first).toContain("run it in the background");
});
