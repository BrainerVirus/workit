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

// `workit pr template` prints the template a PR body fills (workspace
// `prTemplate`, default auto: the repo's, else Workit's), and `workit pr
// create` refuses a body that leaves its headings out or keeps its comments.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-template-");
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

/** A pushed feature/x checkout with `files` committed, under workspace `w` with `entry`. */
const setup = (files: Record<string, string>, entry: Record<string, unknown> = {}) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  if (Object.keys(files).length) {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo.cwd, rel)), { recursive: true });
      writeFileSync(path.join(repo.cwd, rel), text);
    }
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "chore: template");
    repo.git("push", "-q", path.join(repo.root, "remote.git"), "feature/x");
    repo.subs["{{HEAD}}"] = repo.git("rev-parse", "HEAD");
  }
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

const opened = (calls: readonly Call[]) =>
  calls.filter((call) => call.method === "POST" && call.endpoint.endsWith("pulls"));

const GITHUB_TEMPLATE = "## Summary\n<!-- what changed and why -->\n\n## Testing\n- [ ] unit\n";

const create = (repo: ForgeRepo, body: string, ...extra: string[]) =>
  run(["pr", "create", "--base", "main", "--title", "feat: x", "--body", body, ...extra], repo.cwd);

test("Given prTemplate unset and .github/pull_request_template.md, When workit pr template runs, Then it prints that file and names it as the source", async () => {
  const { repo } = setup({ ".github/pull_request_template.md": GITHUB_TEMPLATE });
  const human = await run(["pr", "template"], repo.cwd);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain(
    "template: .github/pull_request_template.md (the repo's, prTemplate auto)\n",
  );
  expect(human.stdout).toContain(GITHUB_TEMPLATE.trimEnd());
  const json = (await run(["pr", "template", "--json"], repo.cwd)).json();
  expect(json.data).toMatchObject({
    source: "repo",
    path: ".github/pull_request_template.md",
    headings: ["Summary", "Testing"],
  });
});

test("Given no repo template, When workit pr template runs, Then it prints Workit's template and says the repo has none", async () => {
  const { repo } = setup({});
  const result = await run(["pr", "template"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "template: Workit's (prTemplate auto: this repo has no PR template;",
  );
  expect(result.stdout).toContain("## Merge danger");
});

test("Given GitLab Default.md and Feature.md, When prTemplate is auto, Then Default.md is printed; When it names Feature.md, Then Feature.md is", async () => {
  const files = {
    ".gitlab/merge_request_templates/Default.md": "## Default section\n",
    ".gitlab/merge_request_templates/Feature.md": "## Feature section\n",
  };
  const auto = setup(files);
  expect((await run(["pr", "template", "--json"], auto.repo.cwd)).json().data.path).toBe(
    ".gitlab/merge_request_templates/Default.md",
  );
  const named = setup(files, { prTemplate: ".gitlab/merge_request_templates/Feature.md" });
  const data = (await run(["pr", "template", "--json"], named.repo.cwd)).json().data;
  expect(data).toMatchObject({
    path: ".gitlab/merge_request_templates/Feature.md",
    headings: ["Feature section"],
  });
});

test("Given prTemplate repo and no repo template, When pr template or pr create runs, Then each exits 3 naming the paths searched and the setting to change, opening nothing", async () => {
  const { repo, runner } = setup({}, { prTemplate: "repo" });
  for (const argv of [
    ["pr", "template"],
    ["pr", "create", "--base", "main", "--title", "feat: x", "--body", "x"],
  ]) {
    const result = await run(argv, repo.cwd);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(
      "workit: pr_template_missing: prTemplate is repo and this repo has no PR template (looked in .gitlab/merge_request_templates/Default.md,",
    );
    expect(result.stderr).toContain(".github/pull_request_template.md");
    expect(result.stderr).toContain("workit workspace set w prTemplate=workit");
  }
  expect(opened(runner.calls)).toHaveLength(0);
});

test("Given a template with Summary and Testing, When the body omits Testing, Then pr create exits 3 with pr_template_unfilled naming Testing and the template, and opens nothing", async () => {
  const { repo, runner } = setup({ ".github/pull_request_template.md": GITHUB_TEMPLATE });
  const human = await create(repo, "## Summary\nFixes x\n");
  expect(human.code).toBe(3);
  expect(human.stderr).toContain(
    'workit: pr_template_unfilled: the body does not fill the repo template .github/pull_request_template.md: it has no heading "Testing"; opened nothing',
  );
  const json = await create(repo, "## Summary\nFixes x\n", "--json");
  expect(json.code).toBe(3);
  expect(json.json().data).toMatchObject({
    reason: "pr_template_unfilled",
    template: ".github/pull_request_template.md",
    missingHeadings: ["Testing"],
  });
  expect(opened(runner.calls)).toHaveLength(0);
});

test("Given a body that keeps the template's HTML comment, When pr create runs, Then it exits 3 with pr_template_unfilled and opens nothing", async () => {
  const { repo, runner } = setup({ ".github/pull_request_template.md": GITHUB_TEMPLATE });
  const result = await create(
    repo,
    "## Summary\n<!-- what changed and why -->\n\n## Testing\n- [ ] unit\n",
    "--json",
  );
  expect(result.code).toBe(3);
  expect(result.json().data).toMatchObject({
    reason: "pr_template_unfilled",
    missingHeadings: [],
    leftComments: ["<!-- what changed and why -->"],
  });
  expect(opened(runner.calls)).toHaveLength(0);
});

test("Given both headings present and the comment replaced, When pr create runs, Then the PR opens with that body", async () => {
  const { repo, runner } = setup({ ".github/pull_request_template.md": GITHUB_TEMPLATE });
  const body = "## Summary\nFixes x\n\n## Testing\n- [ ] unit\n";
  const result = await create(repo, body);
  expect(result.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
  expect(JSON.stringify(opened(runner.calls)[0])).toContain("## Testing");
});

test("Given no repo template, When pr create --body lacks Workit's headings, Then it is refused; When it has them, Then the PR opens", async () => {
  const { repo, runner } = setup({});
  const refused = await create(repo, "Why: y", "--json");
  expect(refused.code).toBe(3);
  expect(refused.json().data).toMatchObject({
    reason: "pr_template_unfilled",
    template: "workit",
    missingHeadings: ["Summary", "Evidence", "Merge danger"],
  });
  const filled = await create(repo, "## Summary\nx\n\n## Evidence\ny\n\n## Merge danger\nz\n");
  expect(filled.code).toBe(0);
  expect(opened(runner.calls)).toHaveLength(1);
});
