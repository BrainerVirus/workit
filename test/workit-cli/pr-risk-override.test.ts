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

// #891 part 4: the user lists a risk path in the workspace's sealed
// `additiveRiskPaths`; a purely additive edit to it then follows the review
// lane of the rest of the diff, so a small change with a guarded CI append
// merges on the author's own verdict. Unsealed, the list is ignored with a
// note; an edit that is not purely additive keeps the risk path.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-risk-override-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
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
const APPEND = CI.replace(
  "npm run lint\n",
  `npm run lint && (npm run tidy:check || echo "::warning title=tidy::tidy check failed")\n`,
);
const WIDEN = CI.replace("contents: read", "contents: write");
const APP = "export const app = 1;\n";

const writeFiles = (repo: ForgeRepo, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, file), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
};

/** An open PR #12 whose feature/x changes `files` on a base holding ci.yml and src/app.ts. */
const setup = (
  files: Record<string, string>,
  entry: Record<string, unknown>,
  configDir = configHome.configDir,
) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  repo.git("reset", "-q", "--hard", "main");
  writeFiles(repo, { ".github/workflows/ci.yml": CI, "src/app.ts": APP }, "base");
  repo.git("branch", "-q", "-f", "main", "HEAD");
  writeFiles(repo, files, "feat: tidy check");
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
          ...entry,
        },
      ],
    }),
  );
  return { repo, runner };
};

const merges = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

const OVERRIDE = { additiveRiskPaths: [".github/workflows/ci.yml"] };
const CHANGE = { ".github/workflows/ci.yml": APPEND, "src/app.ts": "export const app = 2;\n" };

const lane = async (repo: ForgeRepo) =>
  (await run(["pr", "status", "--json"], repo.cwd)).json().data.verdict.lane;

const selfVerdict = async (repo: ForgeRepo) =>
  expect(
    (await run(["ledger", "verdict", "tests-verified", "--self", "--how", "bun test"], repo.cwd))
      .code,
  ).toBe(0);

test("Given no override, When a small change rides an additive ci.yml append, Then the lane stays focused and the author's own verdict does not merge", async () => {
  const { repo, runner } = setup(CHANGE, {});
  expect(await lane(repo)).toMatchObject({ lane: "focused", need: "non-author" });
  await selfVerdict(repo);
  expect((await run(["pr", "merge", "--json"], repo.cwd)).code).toBe(3);
  expect(merges(runner.calls)).toEqual([]);
});

test("Given a sealed override for .github/workflows/ci.yml additive edits, Then an additive edit lands on the lane of the rest of the diff and the author's verdict merges", async () => {
  const { repo, runner } = setup(CHANGE, OVERRIDE);
  const read = await lane(repo);
  expect(read).toMatchObject({ lane: "self", need: "self", riskFiles: [] });
  expect(read.reasons.at(-1)).toBe(
    "sealed additiveRiskPaths (workspace w): .github/workflows/ci.yml (jobs.lint.with.lint_command appended) follows the rest of the diff",
  );
  expect(read.reasons[0]).toBe("small change: 2 lines in 1 file, no risk path");
  await selfVerdict(repo);
  const merged = await run(["pr", "merge", "--json"], repo.cwd);
  expect(merged.code, merged.stdout).toBe(0);
  expect(merges(runner.calls)).toHaveLength(1);
});

test("Given a sealed override and only the additive ci.yml edit, Then no verdict is needed", async () => {
  const { repo } = setup({ ".github/workflows/ci.yml": APPEND }, OVERRIDE);
  expect(await lane(repo)).toMatchObject({
    lane: "none",
    need: "none",
    reasons: [
      "only edits the sealed additiveRiskPaths allow changed",
      expect.stringContaining("follows the rest of the diff"),
    ],
  });
});

test("Given a sealed override, When the ci.yml edit widens permissions, Then the risk path stays full and says why", async () => {
  const { repo } = setup({ ".github/workflows/ci.yml": WIDEN }, OVERRIDE);
  const read = await lane(repo);
  expect(read).toMatchObject({ lane: "full", riskFiles: [".github/workflows/ci.yml"] });
  expect(read.reasons.at(-1)).toStartWith(
    "additiveRiskPaths names .github/workflows/ci.yml, but its edit is not purely additive",
  );
});

test("Given the override is not sealed, Then it is ignored with a note and the lane is unchanged", async () => {
  const manual = useConfigHome("wk-risk-override-unsealed-", { seal: "manual" });
  try {
    const { repo } = setup(CHANGE, OVERRIDE, manual.configDir);
    const read = await lane(repo);
    expect(read.lane).toBe("focused");
    expect(read.reasons.at(-1)).toBe(
      "additiveRiskPaths of workspace w names .github/workflows/ci.yml but is ignored: the seal is not valid (the user runs workit workspace seal)",
    );
  } finally {
    manual.restore();
  }
});

test("Given an agent shell, When it sets additiveRiskPaths, Then workspace set refuses and writes nothing", async () => {
  const { repo } = setup(CHANGE, {});
  const refused = await run(
    ["workspace", "set", "w", 'additiveRiskPaths=[".github/workflows/ci.yml"]', "--json"],
    repo.cwd,
  );
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("grant_raise_refused");
  expect(refused.json().error).toContain(
    "additiveRiskPaths which risk paths an additive edit leaves",
  );
  const bad = await run(["workspace", "set", "w", "additiveRiskPaths=../x", "--json"], repo.cwd);
  expect(bad.code).toBe(2);
});
