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

// Merge guard: `pr merge` refuses to land on a base whose head CI is red
// (base_red), proceeds with a note while it runs, and --base-red-ok --reason
// overrides, recorded in the merge rows. All forge calls are replayed stubs.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-base-red-config-");
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

const RUN_URL = "https://github.com/o/r/actions/runs/777";

type Node = Record<string, unknown>;
const checkRun = (name: string, status: string, conclusion: string | null): Node => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: RUN_URL,
  databaseId: 1,
  checkSuite: { workflowRun: { databaseId: 777, workflow: { name: "CI" } } },
});
const baseChecks = (nodes: Node[] | null) =>
  JSON.stringify({
    data: {
      repository: {
        object: {
          oid: "basehead",
          statusCheckRollup: nodes
            ? { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
            : null,
        },
      },
    },
  });

/** A docs-only READY PR (lane none: no verdict needed) whose base checks are `nodes`. */
const setup = (nodes: Node[] | null) => {
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
    "graphql status": () => fixture(merged ? "github/pr-merged.json" : "github/pr-passing.json"),
    "graphql branch-checks": baseChecks(nodes),
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
        },
      ],
    }),
  );
  return { repo, runner };
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));
const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test("given a base whose head CI failed, when merging, then it is refused as base_red naming the check and run URL, and nothing merges", async () => {
  const { repo, runner } = setup([
    checkRun("unit", "COMPLETED", "SUCCESS"),
    checkRun("test-leak", "COMPLETED", "FAILURE"),
  ]);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("base_red");
  expect(result.json().error).toContain("CI / test-leak");
  expect(result.json().error).not.toContain("CI / unit");
  expect(result.json().error).toContain(RUN_URL);
  expect(result.json()).toMatchObject({
    data: { reason: "base_red", blockers: ["CI / test-leak"] },
  });
  expect(result.json().unblock).toContain("--base-red-ok --reason");
  expect(merges(runner.calls)).toEqual([]);
  expect(rows(repo.cwd, "pr.merge.intent")).toEqual([]);
});

test("given a base whose CI is still running, when merging, then it merges with a one-line note", async () => {
  const { repo, runner } = setup([checkRun("unit", "IN_PROGRESS", null)]);
  const result = await run(["pr", "merge"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("CI is still running (CI / unit); merging without waiting");
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given a green base, when merging, then it merges with no base note", async () => {
  const { repo, runner } = setup([checkRun("unit", "COMPLETED", "SUCCESS")]);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.baseCi).toEqual({ note: null, override: null });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given a base with no checks, when merging, then it merges", async () => {
  const { repo, runner } = setup(null);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data.baseCi.note).toBeNull();
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given a red base, when --base-red-ok --reason is passed, then it merges and both merge rows record the reason", async () => {
  const { repo, runner } = setup([checkRun("test-leak", "COMPLETED", "FAILURE")]);
  const result = await run(
    ["pr", "merge", "--base-red-ok", "--reason", "user asked: the fix for main itself", "--json"],
    repo.cwd,
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json().data.baseCi.override).toEqual({
    reason: "user asked: the fix for main itself",
  });
  expect(merges(runner.calls)).toHaveLength(1);
  expect(rows(repo.cwd, "pr.merge.intent")).toEqual([
    expect.objectContaining({ baseRedOk: "user asked: the fix for main itself" }),
  ]);
  expect(rows(repo.cwd, "pr.merged")).toEqual([
    expect.objectContaining({ baseRedOk: "user asked: the fix for main itself" }),
  ]);
});

test("--base-red-ok without --reason is a usage error and nothing is called", async () => {
  const { repo, runner } = setup([checkRun("test-leak", "COMPLETED", "FAILURE")]);
  const result = await run(["pr", "merge", "--base-red-ok", "--json"], repo.cwd);
  expect(result.code).toBe(2);
  expect(result.stderr + result.stdout).toContain("--base-red-ok needs --reason");
  expect(runner.calls).toEqual([]);
});
