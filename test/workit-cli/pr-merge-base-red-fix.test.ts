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
  replyError,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #906: base_red lets through the PR that fixes the red base. A PR whose own
// head passes every check that is red on the base (same `<workflow> / <job>`
// name) merges without --base-red-ok and says it fixes the red base check; a
// PR that does not cover them is refused, naming the check it leaves red. All
// forge calls are replayed stubs.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-base-red-fix-config-");
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
const WINDOWS = "test (windows-latest)";

type Node = Record<string, unknown>;
const checkRun = (name: string, conclusion: string, isRequired?: boolean): Node => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion,
  detailsUrl: RUN_URL,
  databaseId: 1,
  checkSuite: { workflowRun: { databaseId: 777, workflow: { name: "CI" } } },
  ...(isRequired === undefined ? {} : { isRequired }),
});
const baseChecks = (nodes: Node[]) =>
  JSON.stringify({
    data: {
      repository: {
        object: {
          oid: "basehead",
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      },
    },
  });

/** The passing PR fixture with `extra` added to its head's checks. */
const prHead = (extra: Node[]): string => {
  const doc = JSON.parse(fixture("github/pr-passing.json"));
  doc.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push(
    ...extra,
  );
  return JSON.stringify(doc);
};

/** main's protection requiring the fixture's two checks and the windows job. */
const PROTECTION = JSON.stringify({
  name: "main",
  protected: true,
  protection: {
    enabled: true,
    required_status_checks: { contexts: ["fast checks", "test (ubuntu-latest)", WINDOWS] },
  },
});

/** A docs-only READY PR (lane none: no verdict needed) onto a main whose checks are `base`. */
const setup = (base: Node[], head: Node[], extra: Record<string, Reply> = {}) => {
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
    "GET repos/o/r/branches/main": PROTECTION,
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    "graphql status": () => (merged ? fixture("github/pr-merged.json") : prHead(head)),
    "graphql branch-checks": baseChecks(base),
    "GET repos/o/r/branches/main~1": replyError("HTTP 404 Branch not found"),
    "GET repos/o/r/rules/branches/main~1": "[]",
    ...extra,
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

/** The required set unreadable: every check that failed outright on main gates. */
const UNREADABLE_RULES = { "GET repos/o/r/rules/branches/main": replyError("HTTP 500") };
const previousRun = (nodes: Node[]) => ({
  [`graphql branch-checks ${JSON.stringify({ owner: "o", name: "r", ref: "refs/heads/main~1" })}`]:
    baseChecks(nodes),
});

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));
const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test("Given main red on test (windows-latest) and a PR whose head passes it, When pr merge runs with every other gate met, Then it merges without --base-red-ok and says it fixes the red base check", async () => {
  const { repo, runner } = setup(
    [checkRun("fast checks", "SUCCESS"), checkRun(WINDOWS, "FAILURE")],
    [checkRun(WINDOWS, "SUCCESS", true)],
  );
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json().data.baseCi).toEqual({
    note: `base main CI is red (CI / ${WINDOWS}); PR #12's head passes it, so this merge fixes the red base check`,
    override: null,
    fixes: [`CI / ${WINDOWS}`],
  });
  expect(merges(runner.calls)).toHaveLength(1);
  const intent = rows(repo.cwd, "pr.merge.intent");
  expect(intent).toEqual([expect.objectContaining({ baseRedFixed: [`CI / ${WINDOWS}`] })]);
  expect(intent[0]).not.toHaveProperty("baseRedOk");
  expect(rows(repo.cwd, "pr.merged")).toEqual([
    expect.objectContaining({ baseRedFixed: [`CI / ${WINDOWS}`] }),
  ]);
});

test("Given main red on a check the PR's head lacks, When pr merge runs, Then base_red refuses as before, naming the check and the exact next step", async () => {
  const { repo, runner } = setup([checkRun("windows shard", "FAILURE")], [], {
    ...UNREADABLE_RULES,
    ...previousRun([checkRun("windows shard", "SUCCESS")]),
  });
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  const out = result.json();
  expect(out.error).toStartWith("base_red: main");
  expect(out.error).toContain("PR #12's head does not pass CI / windows shard");
  expect(out.data).toMatchObject({
    reason: "base_red",
    blockers: ["CI / windows shard"],
    baseRedCause: "flaky",
  });
  expect(out.unblock).toBe(
    'workit ci rerun --ref main --check "CI / windows shard" --reason flake  # then merge once main is green',
  );
  expect(merges(runner.calls)).toEqual([]);
  expect(rows(repo.cwd, "pr.merge.intent")).toEqual([]);
});

test("Given main red on two checks and the PR's head passes only one, When pr merge runs, Then base_red refuses naming the other", async () => {
  const { repo, runner } = setup(
    [checkRun(WINDOWS, "FAILURE"), checkRun("windows shard", "FAILURE")],
    [checkRun(WINDOWS, "SUCCESS", true)],
    { ...UNREADABLE_RULES, ...previousRun([checkRun("windows shard", "FAILURE")]) },
  );
  const result = await run(["pr", "merge", "--keep-branch", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  const out = result.json();
  expect(out.error).toContain(`PR #12's head passes CI / ${WINDOWS} but not CI / windows shard`);
  expect(out.error).toContain("main is broken: CI / windows shard");
  expect(out.data).toMatchObject({
    reason: "base_red",
    blockers: ["CI / windows shard"],
    baseRedCause: "broken",
  });
  expect(out.unblock).toBe(
    'fix main first; or, if the user accepts it: workit pr merge --base-red-ok --reason "<why>"',
  );
  expect(merges(runner.calls)).toEqual([]);
});
