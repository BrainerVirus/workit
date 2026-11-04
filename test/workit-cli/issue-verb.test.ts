import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { runTaskCommand } from "@/packages/workit-cli/src/task";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { TaskStore } from "@/packages/workit-core/src/core";
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

// `workit issue` (#439, retro W2.11) and `workit finding record --queue` over
// recorded gh/glab API shapes: no real forge is reached.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-issue-config-");
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

const setup = (kind: "github" | "gitlab", routes: Record<string, Reply>) => {
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  const runner = replayRunner(routes, repo.subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { repo, runner };
};

const workspace = (repo: ForgeRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const writes = (calls: readonly Call[]) =>
  calls
    .filter((call) => call.method !== "GET" && call.method !== "CLI")
    .map((call) => [call.method, call.endpoint, Object.fromEntries(call.pairs)]);

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type) as unknown as Array<
    Record<string, unknown>
  >;
};

const githubBase = (): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
});
const ghIssue = (number: number, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    number,
    html_url: `https://github.com/o/r/issues/${number}`,
    title: "flaky retry",
    state: "open",
    state_reason: null,
    body: "the body",
    labels: [{ name: "bug" }],
    ...fields,
  });

/** An issue that reads open until the close PATCH lands, then closed. */
const closingIssue = (number: number): Record<string, Reply> => {
  let closed = false;
  return {
    [`GET repos/o/r/issues/${number}`]: () =>
      ghIssue(number, closed ? { state: "closed", state_reason: "not_planned" } : {}),
    [`PATCH repos/o/r/issues/${number}`]: () => {
      closed = true;
      return ghIssue(number, { state: "closed" });
    },
    [`POST repos/o/r/issues/${number}/comments`]: JSON.stringify({
      html_url: `https://github.com/o/r/issues/${number}#issuecomment-7`,
    }),
  };
};

test("issue close (GitHub): given the forge write granted, the comment then the not_planned close reach the forge and a ledger row records it", async () => {
  const { repo, runner } = setup("github", { ...githubBase(), ...closingIssue(321) });
  const result = await run(
    ["issue", "close", "321", "--reason", "not-planned", "--comment", "x", "--json"],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(writes(runner.calls)).toEqual([
    ["POST", "repos/o/r/issues/321/comments", { body: "x" }],
    ["PATCH", "repos/o/r/issues/321", { state: "closed", state_reason: "not_planned" }],
  ]);
  expect(result.json().data).toMatchObject({
    number: 321,
    reason: "not-planned",
    changed: true,
    commentUrl: "https://github.com/o/r/issues/321#issuecomment-7",
  });
  const [row] = rows(repo.cwd, "issue.closed");
  expect(row).toMatchObject({
    issue: 321,
    reason: "not-planned",
    forge: "github",
    repo: "o/r",
    commentUrl: "https://github.com/o/r/issues/321#issuecomment-7",
  });
});

test("issue close: given the pr grant is off, it is refused naming the grant and nothing is written", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    ...closingIssue(321),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  });
  workspace(repo, { vcs: { provider: "github", account: "octo" }, autonomy: { pr: false } });
  const result = await run(
    ["issue", "close", "321", "--reason", "not-planned", "--comment", "x", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(3);
  expect(result.json().error).toContain("grant_required: pr");
  expect(result.json().unblock).toContain("workit grant set w pr=");
  expect(writes(runner.calls)).toEqual([]);
  expect(rows(repo.cwd, "issue.closed")).toEqual([]);
});

test("issue close: an already closed issue is left alone and nothing is posted", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/issues/5": ghIssue(5, { state: "closed", state_reason: "completed" }),
  });
  const result = await run(["issue", "close", "5", "--reason", "completed", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ changed: false });
  expect(writes(runner.calls)).toEqual([]);
});

test("issue close: a missing or unknown --reason is a usage error before any forge call", async () => {
  const { repo, runner } = setup("github", githubBase());
  expect((await run(["issue", "close", "5"], repo.cwd)).code).toBe(2);
  expect((await run(["issue", "close", "5", "--reason", "wontfix"], repo.cwd)).code).toBe(2);
  expect(runner.calls).toEqual([]);
});

test("issue view (GitHub): a pull request number is refused, pointing at pr status", async () => {
  const { repo } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/issues/12": ghIssue(12, { pull_request: { url: "x" } }),
    "GET repos/o/r/issues/7": ghIssue(7),
  });
  const pr = await run(["issue", "view", "12", "--json"], repo.cwd);
  expect(pr.json()).toMatchObject({ code: "invalid_input", unblock: "workit pr status --pr 12" });
  const issue = await run(["issue", "view", "#7", "--json"], repo.cwd);
  expect(issue.json().data).toMatchObject({
    number: 7,
    state: "open",
    title: "flaky retry",
    labels: ["bug"],
  });
});

test("issue create (GitHub): title, body and labels reach the forge; issue.created is recorded", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "POST repos/o/r/issues": JSON.stringify({
      number: 44,
      html_url: "https://github.com/o/r/issues/44",
    }),
  });
  writeFileSync(path.join(repo.cwd, "body.md"), "rule: never X");
  const result = await run(
    [
      "issue",
      "create",
      "--title",
      "fix(cli): rule",
      "--body-file",
      "body.md",
      "--label",
      "agent",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code, result.stdout).toBe(0);
  expect(writes(runner.calls)).toEqual([
    [
      "POST",
      "repos/o/r/issues",
      { title: "fix(cli): rule", body: "rule: never X", "labels[]": "agent" },
    ],
  ]);
  expect(rows(repo.cwd, "issue.created")[0]).toMatchObject({ issue: 44, labels: ["agent"] });
});

test("issue comment (GitLab): the note is posted and its URL is the issue's anchor", async () => {
  const GL = "projects/group%2Fproject";
  const { repo, runner } = setup("gitlab", {
    "GET user": fixture("gitlab/user.json"),
    [`GET ${GL}`]: fixture("gitlab/project.json"),
    [`GET ${GL}/issues/9`]: JSON.stringify({
      iid: 9,
      web_url: "https://gitlab.com/group/project/-/issues/9",
      title: "t",
      state: "opened",
      description: "",
      labels: [],
    }),
    [`POST ${GL}/issues/9/notes`]: JSON.stringify({ id: 81 }),
  });
  const result = await run(["issue", "comment", "9", "--body-file", "-", "--json"], repo.cwd);
  expect(result.code).toBe(2);
  forgeDeps.readStdin = () => "done in !3";
  const posted = await run(["issue", "comment", "9", "--body-file", "-", "--json"], repo.cwd);
  expect(posted.code, posted.stdout).toBe(0);
  expect(posted.json().data.url).toBe("https://gitlab.com/group/project/-/issues/9#note_81");
  expect(writes(runner.calls)).toEqual([["POST", `${GL}/issues/9/notes`, { body: "done in !3" }]]);
});

// ---------------------------------------------------------------------------
// finding record --queue

const record = async (cwd: string, extra: string[]) => {
  let stdout = "";
  const code = await runTaskCommand(
    [
      "finding",
      "record",
      ...extra,
      "--payload",
      JSON.stringify({
        claim: "retry loop swallows the timeout",
        consequence: "a hung forge call is reported as success",
        scope: { description: "checkout", paths: ["."], exclusions: [] },
        candidateId: null,
        refs: [{ kind: "file", path: "src/retry.ts", digest: null }],
      }),
      "--json",
    ],
    { cwd, out: { write: (chunk) => void (stdout += chunk) }, err: { write: () => {} } },
  );
  return { code, json: () => JSON.parse(stdout) };
};

const findings = (cwd: string) => {
  const tasks = new TaskStore(cwd).listTasks();
  if (!tasks.ok) throw new Error(tasks.error);
  return tasks.data.flatMap((task) => task.findings);
};

test("finding record --queue: an issue is created on the forge and linked in the finding", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "POST repos/o/r/issues": JSON.stringify({
      number: 50,
      html_url: "https://github.com/o/r/issues/50",
    }),
  });
  const result = await record(repo.cwd, ["--queue"]);
  expect(result.code, JSON.stringify(result.json())).toBe(0);
  expect(result.json().data.queued).toEqual({
    url: "https://github.com/o/r/issues/50",
    issue: 50,
  });
  const [post] = writes(runner.calls);
  expect(post.slice(0, 2)).toEqual(["POST", "repos/o/r/issues"]);
  expect(post[2]).toMatchObject({ title: "retry loop swallows the timeout" });
  expect((post[2] as Record<string, string>).body).toContain(
    "Consequence: a hung forge call is reported as success",
  );
  const [finding] = findings(repo.cwd);
  expect(finding.data.refs).toContainEqual({
    kind: "external",
    url: "https://github.com/o/r/issues/50",
  });
  expect(rows(repo.cwd, "issue.created")[0]).toMatchObject({ issue: 50 });
});

test("finding record --queue <n>: a closed issue is refused with the open alternative and no finding is recorded", async () => {
  const { repo, runner } = setup("github", {
    ...githubBase(),
    "GET repos/o/r/issues/8": ghIssue(8, { state: "closed" }),
  });
  const result = await record(repo.cwd, ["--queue", "8"]);
  expect(result.code).toBe(1);
  expect(result.json()).toMatchObject({ code: "permission_denied" });
  expect(result.json().error).toContain("issue #8 is closed");
  expect(result.json().details.guidance).toContain("workit finding record --queue (no number)");
  expect(writes(runner.calls)).toEqual([]);
  expect(findings(repo.cwd)).toEqual([]);
});

test("finding record --queue: an invalid payload is refused before any forge call", async () => {
  const { repo, runner } = setup("github", githubBase());
  let stdout = "";
  const code = await runTaskCommand(
    ["finding", "record", "--queue", "--payload", '{"claim":"x"}', "--json"],
    { cwd: repo.cwd, out: { write: (chunk) => void (stdout += chunk) }, err: { write: () => {} } },
  );
  expect(code).toBe(1);
  expect(JSON.parse(stdout).code).toBe("invalid_input");
  expect(runner.calls).toEqual([]);
});
