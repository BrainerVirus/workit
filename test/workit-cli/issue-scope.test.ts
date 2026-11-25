import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// `workit issue create|comment|close --repo` outside the workspace's forge
// owners (#882): refused unless the entry's sealed `externalRepos` names the
// repository. The checkout is o/r on github.com; the login is octo. Fake gh.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-issue-scope-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string, env: Record<string, string> = {}) => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1", ...env },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const issueJson = (repo: string, number: number) =>
  JSON.stringify({
    number,
    html_url: `https://github.com/${repo}/issues/${number}`,
    title: "t",
    state: "open",
    state_reason: null,
    body: "",
    labels: [],
  });

/** Issue routes for every repo named: create (#900), view and comment on #7. */
const setup = (...others: string[]) => {
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
  };
  for (const other of others) {
    routes[`POST repos/${other}/issues`] = issueJson(other, 900);
    routes[`GET repos/${other}/issues/7`] = issueJson(other, 7);
    routes[`POST repos/${other}/issues/7/comments`] = JSON.stringify({
      html_url: `https://github.com/${other}/issues/7#issuecomment-1`,
    });
  }
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0, readStdin: () => "x" });
  return { repo, runner };
};

const workspace = (repo: ForgeRepo, entry: Record<string, unknown> = {}) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const writes = (calls: readonly Call[]) =>
  calls
    .filter((call) => call.method !== "GET" && call.method !== "CLI")
    .map((call) => call.endpoint);

const create = (repo: string) => [
  "issue",
  "create",
  "--repo",
  repo,
  "--title",
  "t",
  "--body-file",
  "-",
  "--json",
];
const comment = (repo: string) => [
  "issue",
  "comment",
  "7",
  "--repo",
  repo,
  "--body-file",
  "-",
  "--json",
];

test("Given --repo of another owner and no grant naming it, When issue create and comment run, Then each refuses with outside_owner and the grant command, and nothing is written", async () => {
  const { repo, runner } = setup("acme/tool");
  workspace(repo);
  for (const argv of [create("acme/tool"), comment("acme/tool")]) {
    const result = await run(argv, repo.cwd);
    expect(result.code, result.stdout).toBe(3);
    expect(result.json()).toMatchObject({ code: "blocked" });
    expect(result.json().error).toContain(
      "outside_owner: acme/tool is outside this workspace's forge owners (o) and no externalRepos grant names it",
    );
    expect(result.json().unblock).toContain(`workit workspace set w externalRepos='["acme/tool"]'`);
  }
  const close = await run(
    ["issue", "close", "7", "--repo", "acme/tool", "--reason", "completed", "--json"],
    repo.cwd,
  );
  expect(close.json().error).toContain("outside_owner:");
  expect(writes(runner.calls)).toEqual([]);
  // A read is not a write: view still works.
  const viewed = await run(["issue", "view", "7", "--repo", "acme/tool", "--json"], repo.cwd);
  expect(viewed.code, viewed.stdout).toBe(0);
});

test("Given an externalRepos grant naming the repository, or its owner with /*, When issue create and comment run, Then they proceed", async () => {
  const { repo, runner } = setup("acme/tool", "beta/lib");
  workspace(repo, { externalRepos: ["Acme/Tool", "beta/*"] });
  const created = await run(create("acme/tool"), repo.cwd);
  expect(created.code, created.stdout).toBe(0);
  const commented = await run(comment("beta/lib"), repo.cwd);
  expect(commented.code, commented.stdout).toBe(0);
  expect(writes(runner.calls)).toEqual([
    "repos/acme/tool/issues",
    "repos/beta/lib/issues/7/comments",
  ]);
});

test("Given --repo under the checkout's own owner, When issue create runs, Then no grant is needed", async () => {
  const { repo, runner } = setup("o/other");
  const created = await run(create("o/other"), repo.cwd);
  expect(created.code, created.stdout).toBe(0);
  expect(writes(runner.calls)).toEqual(["repos/o/other/issues"]);
});

test("Given --repo under the workspace tracker's owner, When issue comment runs, Then no grant is needed", async () => {
  const { repo } = setup("team/tracker", "team/other");
  workspace(repo, { issues: { provider: "github", repo: "team/tracker" } });
  const commented = await run(comment("team/other"), repo.cwd);
  expect(commented.code, commented.stdout).toBe(0);
});

test("Given an agent shell, When it sets externalRepos with workspace set, Then it is refused as a raise and nothing is written", async () => {
  const { repo } = setup();
  workspace(repo);
  const file = path.join(configHome.configDir, "workspaces.json");
  const before = readFileSync(file, "utf8");
  const result = await run(
    ["workspace", "set", "w", "externalRepos=acme/tool", "--json"],
    repo.cwd,
    { AI_AGENT: "1" },
  );
  expect(result.code, result.stdout).not.toBe(0);
  expect(result.json().error).toContain("grant_raise_refused");
  expect(readFileSync(file, "utf8")).toBe(before);
  const bad = await run(["workspace", "set", "w", "externalRepos=github.com/acme/tool"], repo.cwd);
  expect(bad.code).toBe(2);
});
