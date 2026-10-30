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

// The opt-in changelog gate on `workit pr create`: with the workspace's
// `changelog: update|create`, a user-facing PR whose branch adds no bullet
// under ## [Unreleased] is refused before any PR opens. Default off.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-changelog-");
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

const ROUTES: Record<string, Reply> = {
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
  "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
  "graphql find": fixture("github/find-none.json"),
  "POST repos/o/r/pulls": (call) =>
    JSON.stringify({
      number: 12,
      html_url: "https://github.com/o/r/pull/12",
      state: "open",
      head: { ref: call.vars.head, sha: "{{HEAD}}" },
    }),
};

/** A pushed feature/x checkout under workspace `w` with `entry`'s settings. */
const setup = (entry: Record<string, unknown> = {}) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );
  const runner = replayRunner(ROUTES, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

/** Commit the changelog `file` with `text` on feature/x and push it. */
const commitChangelog = (repo: ForgeRepo, text: string, file = "CHANGELOG.md") => {
  mkdirSync(path.dirname(path.join(repo.cwd, file)), { recursive: true });
  writeFileSync(path.join(repo.cwd, file), text);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "docs(changelog): entry");
  repo.git("push", "-q", path.join(repo.root, "remote.git"), "feature/x");
  repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
};

const opened = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "POST" && call.endpoint.endsWith("pulls"));

const create = (repo: ForgeRepo, ...extra: string[]) =>
  run(
    ["pr", "create", "--base", "main", "--title", "feat: x", "--body", "Why: y", ...extra],
    repo.cwd,
  );

test("Given a workspace with no changelog setting, When pr create runs on a branch with no entry, Then the PR opens as before", async () => {
  const { repo, runner } = setup();
  const result = await create(repo, "--json");
  expect(result.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
  expect(result.json().data.changelog).toBeUndefined();
});

test("Given changelog create and no CHANGELOG.md, When pr create --title 'feat: x' runs, Then it exits 3 with changelog_required, names workit changelog apply and opens nothing", async () => {
  const { repo, runner } = setup({ changelog: "create" });
  const human = await create(repo);
  expect(human.code).toBe(3);
  expect(human.stderr).toContain("workit: changelog_required: ");
  expect(human.stderr).toContain(
    `  unblock: workit changelog apply --entries '{"Added": ["<what users can now do>"]}'`,
  );
  const json = await create(repo, "--json");
  expect(json.code).toBe(3);
  expect(json.json().data.reason).toBe("changelog_required");
  expect(opened(runner.calls)).toHaveLength(0);
});

test("Given changelog update and no CHANGELOG.md, When pr create runs, Then it opens the PR and says there is nothing to update", async () => {
  const { repo, runner } = setup({ changelog: "update" });
  const result = await create(repo);
  expect(result.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
  expect(result.stdout).toContain(
    "changelog: update is on but this repo has no CHANGELOG.md; nothing to update\n",
  );
});

test("Given changelog create and a branch that adds an Unreleased bullet, When pr create runs, Then it opens the PR", async () => {
  const { repo, runner } = setup({ changelog: "create" });
  commitChangelog(repo, "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- You can now x\n");
  const result = await create(repo);
  expect(result.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
  expect(result.stdout).toContain("changelog: 1 new Unreleased entry in CHANGELOG.md\n");
});

test("Given the gate is on, When the PR title is a non-user-facing type, Then it opens without an entry", async () => {
  const { repo, runner } = setup({ changelog: "create" });
  const result = await run(
    ["pr", "create", "--base", "main", "--title", "chore: bump deps", "--body", "b"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
  expect(result.stdout).toContain("changelog: no entry needed (chore is not user-facing)\n");
});

test("Given the gate is on, When --no-changelog has a reason, Then the PR opens and its body records the reason", async () => {
  const { repo, runner } = setup({ changelog: "create" });
  const result = await create(repo, "--no-changelog", "internal flag, no user sees it");
  expect(result.code).toBe(0);
  const posted = opened(runner.calls);
  expect(posted).toHaveLength(1);
  expect(posted[0].vars.body).toBe(
    "Why: y\n\nChangelog: no entry (--no-changelog): internal flag, no user sees it",
  );
});

test("Given the gate is on, When --no-changelog has an empty reason, Then it is a usage error and opens nothing", async () => {
  const { repo, runner } = setup({ changelog: "create" });
  for (const reason of ["", "   "]) {
    const result = await create(repo, "--no-changelog", reason);
    expect(result.code, JSON.stringify(reason)).toBe(2);
  }
  expect(opened(runner.calls)).toHaveLength(0);
});

test("Given changelogPath docs/CHANGELOG.md, When the branch adds an entry there, Then the PR opens; without the setting, the refusal names the file and the command to point at it", async () => {
  const entry = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- You can now x\n";
  const pointed = setup({ changelog: "create", changelogPath: "docs/CHANGELOG.md" });
  commitChangelog(pointed.repo, entry, "docs/CHANGELOG.md");
  const passed = await create(pointed.repo);
  expect(passed.code).toBe(0);
  expect(passed.stdout).toContain("changelog: 1 new Unreleased entry in docs/CHANGELOG.md\n");

  const unset = setup({ changelog: "create" });
  commitChangelog(unset.repo, "# Changelog\n\n## [Unreleased]\n", "docs/CHANGELOG.md");
  const refused = await create(unset.repo);
  expect(refused.code).toBe(3);
  expect(opened(unset.runner.calls)).toHaveLength(0);
  expect(refused.stderr).toContain("this repo has docs/CHANGELOG.md");
  expect(refused.stderr).toContain("workit workspace set w changelogPath=docs/CHANGELOG.md");
});

test("Given the gate is on and a PR base that neither the remote nor the checkout has, When pr create runs, Then it blocks with changelog_base_unknown and a fetch fix, and opens nothing", async () => {
  const { repo, runner } = setup({ changelog: "update" });
  commitChangelog(repo, "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- You can now x\n");
  const result = await run(
    ["pr", "create", "--base", "release/9", "--title", "feat: x", "--body", "Why: y", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(3);
  expect(opened(runner.calls)).toHaveLength(0);
  const body = result.json();
  expect(body.data.reason).toBe("changelog_base_unknown");
  expect(body.unblock).toStartWith("git fetch ");
  expect(body.unblock).toContain(" release/9");
  expect(body.unblock).not.toContain("--no-changelog");
});
