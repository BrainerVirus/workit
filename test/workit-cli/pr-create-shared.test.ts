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

// A `shared: true` workspace (#879): `pr create` and `pr edit` warn, never
// block, when the PR title, body or a doc the branch adds names Workit.
// Isolated config home, fake gh, a throwaway repo.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-shared-");
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
  return { code, stdout, stderr };
};

const pull = (head: string) =>
  JSON.stringify({
    number: 12,
    html_url: "https://github.com/o/r/pull/12",
    node_id: "PR_kwNode12",
    state: "open",
    merged: false,
    draft: false,
    title: "feat: x",
    base: { ref: "main" },
    head: { ref: "feature/x", sha: head },
    user: { login: "octo" },
  });

const routes: Record<string, Reply> = {
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
  "GET repos/o/r/pulls/12": () => pull("{{HEAD}}"),
  "PATCH repos/o/r/pulls/12": () => pull("{{HEAD}}"),
};

const posted = (calls: readonly Call[]): boolean =>
  calls.some((call) => call.method === "POST" && call.endpoint.endsWith("pulls"));

/** A repo on feature/x; `shared` set on its workspace unless undefined; `doc` commits a new file. */
const setup = (shared: boolean | undefined, doc?: { file: string; text: string }) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  let subs = repo.subs;
  if (doc) {
    mkdirSync(path.dirname(path.join(repo.cwd, doc.file)), { recursive: true });
    writeFileSync(path.join(repo.cwd, doc.file), doc.text);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "docs: add");
    repo.git("push", "-q", path.join(repo.root, "remote.git"), "feature/x");
    repo.git("update-ref", "refs/remotes/origin/feature/x", "HEAD");
    subs = { ...subs, "{{HEAD}}": repo.git("rev-parse", "HEAD") };
  }
  const runner = replayRunner(routes, subs);
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "team",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          ...(shared === undefined ? {} : { shared }),
        },
      ],
    }),
  );
  return { repo, runner };
};

const create = (cwd: string, body: string, title = "feat: x") =>
  run(["pr", "create", "--base", "main", "--title", title, "--body", body], cwd);

const warnings = (stderr: string): string[] =>
  stderr.split("\n").filter((line) => line.startsWith("warning: workspace team is shared"));

test("Given shared: true and a body naming Workit, When pr create runs, Then a warning names the body line and the PR is still opened", async () => {
  const { repo, runner } = setup(true);
  const result = await create(repo.cwd, "Why: y\n\nMade with workit.");
  expect(result.code, result.stderr).toBe(0);
  expect(posted(runner.calls)).toBe(true);
  expect(warnings(result.stderr)).toEqual([
    "warning: workspace team is shared: the PR body (line 3) names Workit; reword it so the team repo does not mention it (a warning only)",
  ]);
});

test("Given shared: true and a title naming Workit, When pr create runs, Then the title is named", async () => {
  const { repo } = setup(true);
  const result = await create(repo.cwd, "Why: y", "feat: add the Workit hook");
  expect(result.code, result.stderr).toBe(0);
  expect(warnings(result.stderr)).toHaveLength(1);
  expect(warnings(result.stderr)[0]).toContain("the PR title names Workit");
});

test("Given shared: true and only the Workit-Session trailer and a workit marker, When pr create runs, Then nothing warns", async () => {
  const { repo } = setup(true);
  const result = await create(
    repo.cwd,
    "Why: y\n<!-- workit-backlink:https://x.test/1 -->\n\nWorkit-Session: s-1",
  );
  expect(result.code, result.stderr).toBe(0);
  expect(warnings(result.stderr)).toEqual([]);
});

test("Given shared: true and a new tracked doc naming Workit, When pr create runs, Then a warning names the file", async () => {
  const { repo, runner } = setup(true, {
    file: "docs/notes.md",
    text: "# Notes\n\nRun `workit check` first.\n",
  });
  const result = await create(repo.cwd, "Why: y");
  expect(result.code, result.stderr).toBe(0);
  expect(posted(runner.calls)).toBe(true);
  expect(warnings(result.stderr)).toEqual([
    "warning: workspace team is shared: new doc docs/notes.md (line 3) names Workit; reword it so the team repo does not mention it (a warning only)",
  ]);
});

test("Given shared unset or false, When pr create names Workit everywhere, Then nothing warns", async () => {
  for (const shared of [undefined, false]) {
    const { repo } = setup(shared, { file: "a.md", text: "workit\n" });
    const result = await create(repo.cwd, "workit", "feat: workit");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("names Workit");
    for (const r of repos.splice(0)) r.cleanup();
  }
});

test("Given shared: true, When pr edit sets a body naming Workit, Then it warns and the edit lands", async () => {
  const { repo, runner } = setup(true);
  const bodyFile = path.join(repo.root, "body.md");
  writeFileSync(bodyFile, "Summary\n\nBuilt with Workit.\n");
  const result = await run(["pr", "edit", "--pr", "12", "--body-file", bodyFile], repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(runner.calls.some((call) => call.method === "PATCH")).toBe(true);
  expect(warnings(result.stderr)).toEqual([
    "warning: workspace team is shared: the PR body (line 3) names Workit; reword it so the team repo does not mention it (a warning only)",
  ]);
});

test("Given an unshared workspace, When workspace set team shared=true runs, Then pr create warns; a non-boolean is refused", async () => {
  const { repo } = setup(undefined);
  expect((await run(["workspace", "set", "team", "shared=yes"], repo.cwd)).code).toBe(2);
  const set = await run(["workspace", "set", "team", "shared=true"], repo.cwd);
  expect(set.code, set.stderr).toBe(0);
  const result = await create(repo.cwd, "Made with Workit");
  expect(result.code, result.stderr).toBe(0);
  expect(warnings(result.stderr)).toHaveLength(1);
});

test("Given shared: true, When pr create and pr edit run with --json, Then data.sharedWarnings lists each line by place, line and text and stderr still warns", async () => {
  const { repo } = setup(true, { file: "docs/notes.md", text: "# Notes\n\nRun `workit check`.\n" });
  const created = await run(
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "feat: workit hook",
      "--body",
      "Why\n\nUse Workit.",
      "--json",
    ],
    repo.cwd,
  );
  expect(created.code, created.stderr).toBe(0);
  expect(JSON.parse(created.stdout).data.sharedWarnings).toEqual([
    { place: "title", line: 1, text: "feat: workit hook" },
    { place: "body", line: 3, text: "Use Workit." },
    { place: "docs/notes.md", line: 3, text: "Run `workit check`." },
  ]);
  expect(warnings(created.stderr)).toHaveLength(3);
  const bodyFile = path.join(repo.root, "body.md");
  writeFileSync(bodyFile, "Summary\nWorkit-Session: s-1\n");
  const clean = await run(
    ["pr", "edit", "--pr", "12", "--body-file", bodyFile, "--json"],
    repo.cwd,
  );
  expect(clean.code, clean.stderr).toBe(0);
  // The trailer is exempt; the branch's new doc still names Workit.
  expect(JSON.parse(clean.stdout).data.sharedWarnings).toEqual([
    { place: "docs/notes.md", line: 3, text: "Run `workit check`." },
  ]);
  writeFileSync(bodyFile, "Summary\nby workit\n");
  const edited = await run(
    ["pr", "edit", "--pr", "12", "--body-file", bodyFile, "--json"],
    repo.cwd,
  );
  expect(edited.code, edited.stderr).toBe(0);
  expect(JSON.parse(edited.stdout).data.sharedWarnings).toEqual([
    { place: "body", line: 2, text: "by workit" },
    { place: "docs/notes.md", line: 3, text: "Run `workit check`." },
  ]);
  expect(warnings(edited.stderr)).toHaveLength(2);
});
