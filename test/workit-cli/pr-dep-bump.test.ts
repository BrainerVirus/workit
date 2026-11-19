import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #891: the dependency bump of the issue (two pins and a new script in
// package.json, the lockfile, a changelog line, an appended `with:` input in
// ci.yml) lands on the self lane; its self verdict counts only with green CI
// on the head.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-dep-bump-config-");
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

const CI = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  lint:
    uses: acme/workflows/.github/workflows/node.yml@v3
    with:
      lint_command: npm run lint
`;
const PKG = `{
  "name": "app",
  "scripts": {
    "lint": "eslint ."
  },
  "dependencies": {
    "@acme/ui": "4.1.0"
  },
  "devDependencies": {
    "@acme/tidy": "2.0.0"
  }
}
`;
const BASE = {
  "package.json": PKG,
  "package-lock.json": '{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
  "CHANGELOG.md": "# Changelog\n\n## Unreleased\n",
  ".github/workflows/ci.yml": CI,
};
const BUMP = {
  "package.json": PKG.replace('"4.1.0"', '"4.2.0"')
    .replace('"2.0.0"', '"2.3.1"')
    .replace('"lint": "eslint ."', '"lint": "eslint .",\n    "tidy:check": "tidy check"'),
  "package-lock.json":
    '{\n  "lockfileVersion": 3,\n  "packages": { "node_modules/@acme/ui": {} }\n}\n',
  "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- Bump @acme/ui and @acme/tidy.\n",
  ".github/workflows/ci.yml": CI.replace(
    "npm run lint\n",
    `npm run lint && (npm run tidy:check || echo "::warning title=tidy::tidy check failed")\n`,
  ),
};

const writeFiles = (repo: ForgeRepo, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, file), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
};

/** An open PR #12 whose feature/x holds the #891 bump on top of a base holding the manifests. */
const setup = (status: string) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("reset", "-q", "--hard", "main");
  writeFiles(repo, BASE, "base manifests");
  repo.git("branch", "-q", "-f", "main", "HEAD");
  writeFiles(repo, BUMP, "chore(deps): bump @acme/ui and @acme/tidy");
  const head = repo.git("rev-parse", "HEAD");
  repo.subs["{{HEAD}}"] = head;
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    'graphql status {"owner":"o","name":"r","number":"12"}': () =>
      fixture(merged ? "github/pr-merged.json" : status),
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
          deleteBranch: false,
        },
      ],
    }),
  );
  return { repo, runner, head };
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

const selfVerdict = async (repo: ForgeRepo) =>
  expect(
    (await run(["ledger", "verdict", "tests-verified", "--self", "--how", "CI green"], repo.cwd))
      .code,
  ).toBe(0);

test("given the #891 diff, when pr status runs, then the lane is self and its reasons name the dependency bump and the additive workflow edit", async () => {
  const { repo } = setup("github/pr-passing.json");
  const result = await run(["pr", "status", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  const lane = result.json().data.verdict.lane;
  expect(lane).toMatchObject({
    lane: "self",
    classification: "dependency-bump",
    riskFiles: [],
    need: "self",
    satisfied: false,
  });
  expect(lane.reasons).toEqual([
    "dependency-bump: 2 version pins in package.json, 1 new script (tidy:check), lockfile package-lock.json; green CI on the head is its evidence",
    "additive workflow edit: .github/workflows/ci.yml (jobs.lint.with.lint_command appended)",
  ]);
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain(
    "merge needs the author's own --self verdict (or an independent one) with green CI on the head",
  );
});

test("given green CI on the head and the author's self verdict, then the gate is met and pr merge lands it", async () => {
  const { repo, runner, head } = setup("github/pr-passing.json");
  await selfVerdict(repo);
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict.lane).toMatchObject({ satisfied: true, missing: null });
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code).toBe(0);
  expect(merged.json().data).toMatchObject({
    head,
    verdict: { lane: "self", need: "self", review: "self-reviewed" },
  });
  expect(merges(runner.calls)).toHaveLength(1);
});

test("given green CI absent on the head, then the dependency bump's self verdict does not meet the gate", async () => {
  const { repo } = setup("github/pr-pending.json");
  await selfVerdict(repo);
  const status = await run(["pr", "status", "--json"], repo.cwd);
  expect(status.json().data.verdict.lane).toMatchObject({
    lane: "self",
    classification: "dependency-bump",
    satisfied: false,
    missing: expect.stringMatching(/^green CI on the head \(CI is (?:pending|failing)\)$/u),
  });
  expect((await run(["pr", "status"], repo.cwd)).stdout).toContain("missing: green CI on the head");
});
