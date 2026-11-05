import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { mergeGateDeps } from "@/packages/workit-core/src/forge/report";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  replyError,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #269: `pr merge --allow-failing <check> --reason <why>` passes a failing
// OPTIONAL check, recorded as a `merge.waived` row; a required check is never
// waived (D1). A transient UNKNOWN mergeability is re-read with backoff; one
// that persists stops with wait-forge (D2). All forge calls are replayed.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const originalGate = { ...mergeGateDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-merge-waiver-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  Object.assign(mergeGateDeps, originalGate);
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

type Pr = {
  mergeable: string;
  mergeStateStatus: string;
  commits: {
    nodes: Array<{
      commit: { statusCheckRollup: { contexts: { nodes: Array<Record<string, unknown>> } } };
    }>;
  };
};

/** pr-passing.json plus a failing `codeql`: required (protected main) or nothing required. */
const prStatus = (options: { requiredFails?: boolean; mergeable?: string }): string => {
  const doc = JSON.parse(fixture("github/pr-passing.json")) as {
    data: { repository: { pullRequest: Pr } };
  };
  const pr = doc.data.repository.pullRequest;
  const nodes = pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
  // An unprotected main requires nothing: every check gates the merge.
  if (!options.requiredFails) for (const node of nodes) node.isRequired = false;
  nodes.push({
    __typename: "CheckRun",
    name: "codeql",
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/o/r/actions/runs/1/job/103",
    databaseId: 103,
    checkSuite: { workflowRun: { databaseId: 1, workflow: { name: "CI" } } },
    isRequired: options.requiredFails === true,
  });
  pr.mergeable = options.mergeable ?? "MERGEABLE";
  pr.mergeStateStatus = options.mergeable === "UNKNOWN" ? "UNKNOWN" : "UNSTABLE";
  return JSON.stringify(doc);
};

/** A docs-only PR (lane none: no verdict needed) on an unprotected main unless `protectedMain`. */
const setup = (options: {
  status: Reply;
  protectedMain?: boolean;
  author?: string;
  mergeError?: string;
}) => {
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
    "GET repos/o/r/branches/main": options.protectedMain
      ? fixture("github/branch-main.json")
      : JSON.stringify({ name: "main", protected: false }),
    "GET repos/o/r/rules/branches/main": "[]",
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    "graphql status": (call) =>
      merged
        ? fixture("github/pr-merged.json")
        : typeof options.status === "function"
          ? options.status(call)
          : options.status,
    ...(options.author
      ? {
          "GET repos/o/r/pulls/12": JSON.stringify({
            number: 12,
            state: "open",
            user: { login: options.author },
          }),
        }
      : {}),
    "PUT repos/o/r/pulls/12/merge": () => {
      if (options.mergeError) return replyError(options.mergeError);
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
const statusReads = (calls: readonly Call[]) => calls.filter((call) => call.op === "status");
const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test("Given an optional failing check, When pr merge runs without a waiver, Then it is refused as FIX_CI", async () => {
  const { repo, runner } = setup({ status: prStatus({}) });
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().data).toMatchObject({ reason: "not_ready", next: "FIX_CI" });
  expect(merges(runner.calls)).toEqual([]);
});

test("Given an optional failing check, When pr merge --allow-failing it --reason r, Then it merges and a waiver row records the check, head and reason", async () => {
  const { repo, runner } = setup({ status: prStatus({}) });
  const result = await run(
    [
      "pr",
      "merge",
      "--keep-branch",
      "--allow-failing",
      "CI / codeql",
      "--reason",
      "user decided: CodeQL is advisory here",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(merges(runner.calls)).toHaveLength(1);
  const waived = rows(repo.cwd, "merge.waived");
  expect(waived).toEqual([
    expect.objectContaining({
      check: "CI / codeql",
      head: repo.subs["{{HEAD}}"],
      pr: 12,
      reason: "user decided: CodeQL is advisory here",
      observer: "workit_cli",
    }),
  ]);
  expect(result.json().data.waived).toEqual([
    { check: "CI / codeql", recorded: String(waived[0].id) },
  ]);
});

test("Given a required failing check, When pr merge --allow-failing names it, Then the waiver is refused naming it and nothing merges", async () => {
  const { repo, runner } = setup({
    status: prStatus({ requiredFails: true }),
    protectedMain: true,
  });
  const result = await run(
    ["pr", "merge", "--keep-branch", "--allow-failing", "codeql", "--reason", "r", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(3);
  expect(result.json().error).toContain(
    "waiver_refused: CI / codeql (required by branch protection)",
  );
  expect(result.json().data).toEqual({ reason: "waiver_refused" });
  expect(merges(runner.calls)).toEqual([]);
  expect(rows(repo.cwd, "merge.waived")).toEqual([]);
});

test("Given --allow-failing without --reason, When pr merge runs, Then it is a usage error and nothing is called", async () => {
  const { repo, runner } = setup({ status: prStatus({}) });
  const result = await run(["pr", "merge", "--allow-failing", "codeql", "--json"], repo.cwd);
  expect(result.code).toBe(2);
  expect(result.stdout + result.stderr).toContain("--allow-failing needs --reason");
  expect(runner.calls).toEqual([]);
});

test("Given UNKNOWN then MERGEABLE from the forge, When pr merge runs, Then it re-reads after a short wait and merges", async () => {
  const waited: number[] = [];
  mergeGateDeps.sleep = (ms) => void waited.push(ms);
  let reads = 0;
  const passing = fixture("github/pr-passing.json");
  const { repo, runner } = setup({
    status: () =>
      reads++ === 0
        ? passing.replace('"mergeable": "MERGEABLE"', '"mergeable": "UNKNOWN"')
        : passing,
    protectedMain: true,
  });
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(waited).toEqual([500]);
  expect(merges(runner.calls)).toHaveLength(1);
});

test("Given a persistent UNKNOWN, When pr merge runs, Then it stops at the deadline with wait-forge and nothing merges", async () => {
  const waited: number[] = [];
  mergeGateDeps.sleep = (ms) => void waited.push(ms);
  const unknown = fixture("github/pr-passing.json").replace(
    '"mergeable": "MERGEABLE"',
    '"mergeable": "UNKNOWN"',
  );
  const { repo, runner } = setup({ status: unknown, protectedMain: true });
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(waited).toEqual([500, 1000, 2000]);
  expect(statusReads(runner.calls)).toHaveLength(4);
  expect(result.json().data).toMatchObject({
    reason: "not_ready",
    blockers: ["mergeability_unknown"],
    babysit: "wait-forge",
  });
  expect(result.json().unblock).toContain("still computing mergeability");
  expect(merges(runner.calls)).toEqual([]);
});

test("Given another author's PR with an optional failing check, When pr merge --allow-failing runs without --others-pr, Then it is refused as others_pr and no waiver row is recorded", async () => {
  const { repo, runner } = setup({ status: prStatus({}), author: "someone-else" });
  const result = await run(
    ["pr", "merge", "--keep-branch", "--allow-failing", "codeql", "--reason", "r", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(3);
  expect(result.json().data).toMatchObject({ reason: "others_pr" });
  expect(merges(runner.calls)).toEqual([]);
  expect(rows(repo.cwd, "merge.waived")).toEqual([]);
  expect(result.json().data.waived).toBeUndefined();
});

test("Given a waived check, When the forge refuses the merge call, Then no waiver row is recorded", async () => {
  const { repo, runner } = setup({
    status: prStatus({}),
    mergeError: "HTTP 405: Pull Request is not mergeable",
  });
  const result = await run(
    ["pr", "merge", "--keep-branch", "--allow-failing", "codeql", "--reason", "r", "--json"],
    repo.cwd,
  );
  expect(result.code).not.toBe(0);
  expect(merges(runner.calls)).toHaveLength(1);
  expect(rows(repo.cwd, "merge.waived")).toEqual([]);
});

test("Given a waived check, When the merge succeeds, Then exactly one waiver row records check, reason, actor and head after the merge intent", async () => {
  const { repo } = setup({ status: prStatus({}) });
  const result = await run(
    ["pr", "merge", "--keep-branch", "--allow-failing", "codeql", "--reason", "r", "--json"],
    repo.cwd,
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const waived = rows(repo.cwd, "merge.waived");
  expect(waived).toEqual([
    expect.objectContaining({
      check: "CI / codeql",
      reason: "r",
      head: repo.subs["{{HEAD}}"],
      actor: expect.objectContaining({ session: "author-1" }),
    }),
  ]);
  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  const order = ledger.value.rows.map((row) => row.type);
  expect(order.indexOf("merge.waived")).toBeGreaterThan(order.indexOf("pr.merge.intent"));
});
