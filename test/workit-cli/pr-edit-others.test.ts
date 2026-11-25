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
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// `workit pr ready|edit` on a PR another author opened (#882): refused unless
// `--others-pr --reason`, as `pr merge` refuses it. Fake gh, no real forge.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-edit-others-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  rmSync(path.join(configHome.configDir, "config.json"), { force: true });
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

/** A draft PR #12 by `author`; the forge login (github/user.json) is octo. */
const setup = (author: string | null) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  let draft = true;
  let title = "feat: x";
  const pull = () =>
    JSON.stringify({
      number: 12,
      html_url: "https://github.com/o/r/pull/12",
      node_id: "PR_kwNode12",
      state: "open",
      merged: false,
      draft,
      title,
      base: { ref: "main" },
      head: { ref: "feature/x" },
      user: author === null ? null : { login: author },
    });
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "graphql find": fixture("github/find-pr.json"),
    "GET repos/o/r/pulls/12": pull,
    "PATCH repos/o/r/pulls/12": () => {
      title = "feat: y";
      return pull();
    },
    "graphql markPullRequestReadyForReview": () => {
      draft = false;
      return JSON.stringify({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      });
    },
  };
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

const writes = (calls: readonly Call[]) =>
  calls.filter(
    (call) =>
      (call.method !== "GET" && call.method !== "CLI" && call.endpoint !== "graphql") ||
      (call.endpoint === "graphql" && !["status", "find", "node"].includes(call.op ?? "")),
  );

test("Given another author's PR, When pr ready runs without --others-pr, Then it is refused naming the bypass and nothing is written", async () => {
  const { repo, runner } = setup("someone-else");
  const result = await run(["pr", "ready", "--pr", "12", "--json"], repo.cwd);
  expect(result.code, result.stdout).not.toBe(0);
  expect(result.json()).toMatchObject({ code: "blocked" });
  expect(result.json().error).toContain("others_pr: PR #12 is by someone-else, not octo");
  expect(result.json().unblock).toBe(
    'only if the user asks you to: workit pr ready --pr 12 --others-pr --reason "<why>"',
  );
  expect(writes(runner.calls)).toEqual([]);
});

test("Given another author's PR, When pr edit runs without --others-pr, Then it is refused and nothing is written", async () => {
  const { repo, runner } = setup("someone-else");
  const result = await run(["pr", "edit", "--pr", "12", "--title", "feat: y", "--json"], repo.cwd);
  expect(result.code, result.stdout).not.toBe(0);
  expect(result.json().error).toContain("others_pr:");
  expect(result.json().unblock).toContain("workit pr edit --pr 12 --others-pr --reason");
  expect(writes(runner.calls)).toEqual([]);
});

test("Given another author's PR, When pr ready and pr edit pass --others-pr --reason, Then each proceeds", async () => {
  const { repo, runner } = setup("someone-else");
  const bypass = ["--others-pr", "--reason", "the user asked me to finish their PR"];
  const ready = await run(["pr", "ready", "--pr", "12", ...bypass, "--json"], repo.cwd);
  expect(ready.code, ready.stdout).toBe(0);
  expect(ready.json().data).toMatchObject({ number: 12, draft: false, changed: true });
  const edited = await run(
    ["pr", "edit", "--pr", "12", "--title", "feat: y", ...bypass, "--json"],
    repo.cwd,
  );
  expect(edited.code, edited.stdout).toBe(0);
  expect(edited.json().data).toMatchObject({ number: 12, title: "feat: y", changed: ["title"] });
  expect(writes(runner.calls).map((call) => call.op ?? `${call.method} ${call.endpoint}`)).toEqual([
    "markPullRequestReadyForReview",
    "PATCH repos/o/r/pulls/12",
  ]);
});

test("Given the caller's own PR, When pr ready runs, Then no --others-pr is needed", async () => {
  const { repo } = setup("Octo");
  const result = await run(["pr", "ready", "--pr", "12", "--json"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
});

test("Given a PR whose author the forge does not name, When pr edit runs, Then it is refused as identity_unknown", async () => {
  const { repo, runner } = setup(null);
  const result = await run(["pr", "edit", "--pr", "12", "--title", "feat: y", "--json"], repo.cwd);
  expect(result.json().error).toContain("identity_unknown: the forge did not name the PR author");
  expect(writes(runner.calls)).toEqual([]);
});

test("Given --others-pr without --reason, or --reason alone, Then pr ready and pr edit are usage errors before any forge call", async () => {
  const { repo, runner } = setup("someone-else");
  for (const argv of [
    ["pr", "ready", "--pr", "12", "--others-pr"],
    ["pr", "ready", "--pr", "12", "--reason", "x"],
    ["pr", "edit", "--pr", "12", "--title", "t", "--others-pr", "--reason", " "],
  ]) {
    const result = await run(argv, repo.cwd);
    expect(result.code, argv.join(" ")).toBe(2);
  }
  expect(runner.calls).toEqual([]);
});
