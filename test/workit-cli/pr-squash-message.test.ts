import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { systemRunner } from "@/packages/workit-core/src/forge/exec";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type Call,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit pr merge` squash message control (retro #268 C2): --subject/--body,
// or a workspace with `trailers: false`, sends the squash message itself as a
// JSON body on stdin (argv has a size limit), with Workit-Session lines
// dropped from each trailer block, on GitHub and GitLab.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-pr-squash-");
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string, session = "author-1") => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** The feature commit, rewritten to carry the author's trailers and pushed. */
const authoredHead = (repo: ForgeRepo) => {
  repo.git(
    "commit",
    "-q",
    "--amend",
    "-m",
    "feat: x\n\nWhy it matters.\n\nCo-Authored-By: A <a@b.c>\nWorkit-Session: author-1",
  );
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "-f", path.join(repo.root, "remote.git"), "feature/x");
  repo.subs["{{HEAD}}"] = head;
  return head;
};

const setup = (
  kind: "github" | "gitlab",
  routes: (repo: ForgeRepo) => Record<string, Reply>,
  entry: Record<string, unknown> = {},
) => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo(kind);
  repos.push(repo);
  const head = authoredHead(repo);
  const replay = replayRunner(routes(repo), repo.subs);
  const inputs: Array<{ args: readonly string[]; input: string }> = [];
  const runner = Object.assign(
    (...call: Parameters<typeof replay>) => {
      if (call[2].input !== undefined) inputs.push({ args: call[1], input: call[2].input });
      return replay(...call);
    },
    { calls: replay.calls, inputs },
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "work",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: kind, account: "octo" },
          autonomy: { merge: "verified" },
          ...entry,
        },
      ],
    }),
  );
  return { repo, runner, head };
};

const verdict = async (repo: ForgeRepo) => {
  const recorded = await run(
    ["ledger", "verdict", "verified", "--how", "exercised the CLI"],
    repo.cwd,
    "reviewer-2",
  );
  expect(recorded.code, recorded.stderr).toBe(0);
};

const mergeCall = (calls: readonly Call[]) =>
  calls.find((call) => call.method === "PUT" && call.endpoint.endsWith("/merge"));

/** The merge request's JSON body sent on stdin; its argv names `--input -` and no fields. */
const mergeBody = (runner: {
  calls: readonly Call[];
  inputs: Array<{ args: readonly string[]; input: string }>;
}): Record<string, unknown> => {
  expect(mergeCall(runner.calls)?.vars).toEqual({});
  const sent = runner.inputs.find(({ args }) => args.some((arg) => arg.endsWith("/merge")));
  expect(sent?.args.slice(-2)).toEqual(["--input", "-"]);
  return JSON.parse(sent?.input ?? "null") as Record<string, unknown>;
};

const github = (): Record<string, Reply> => {
  let merged = false;
  return {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    'graphql status {"owner":"o","name":"r","number":"12"}': () =>
      fixture(merged ? "github/pr-merged.json" : "github/pr-passing.json"),
    "GET repos/o/r/pulls/12": JSON.stringify({
      number: 12,
      html_url: "https://github.com/o/r/pull/12",
      node_id: "PR_kwNode12",
      state: "open",
      merged: false,
      draft: false,
      title: "feat: the PR title",
      base: { ref: "main" },
      head: { ref: "feature/x" },
    }),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
};

const GL = "projects/group%2Fproject";
const gitlab = (): Record<string, Reply> => {
  let merged = false;
  const mr = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...JSON.parse(fixture("gitlab/mr-failing-thread.json")),
      detailed_merge_status: "mergeable",
      head_pipeline: null,
      title: "feat: the MR title",
      ...overrides,
    });
  return {
    "GET user": fixture("gitlab/user.json"),
    [`GET ${GL}`]: fixture("gitlab/project.json"),
    [`GET ${GL}/repository/branches/main`]: fixture("gitlab/branch-main.json"),
    [`GET ${GL}/merge_requests/12/discussions?per_page=100&page=1`]: "[]",
    [`GET ${GL}/merge_requests?source_branch=feature%2Fx&order_by=created_at&sort=desc&per_page=20`]:
      fixture("gitlab/find-mr.json"),
    [`GET ${GL}/merge_requests/12`]: () => mr(merged ? { state: "merged" } : {}),
    [`PUT ${GL}/merge_requests/12/merge`]: () => {
      merged = true;
      return mr({ state: "merged", squash_commit_sha: "{{BASE}}" });
    },
  };
};

const DEFAULT_BODY = "* feat: x\n\nWhy it matters.\n\nCo-Authored-By: A <a@b.c>";

test("Given --subject and --body (GitHub), When squash-merging, Then the forge gets that message with Workit-Session lines stripped", async () => {
  const { repo, runner, head } = setup("github", github);
  await verdict(repo);
  const result = await run(
    [
      "pr",
      "merge",
      "--subject",
      "feat: landed (#12)",
      "--body",
      "Summary.\n\nWorkit-Session: author-1\nCo-Authored-By: A <a@b.c>",
      "--json",
    ],
    repo.cwd,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(runner)).toEqual({
    sha: head,
    merge_method: "squash",
    commit_title: "feat: landed (#12)",
    commit_message: "Summary.\n\nCo-Authored-By: A <a@b.c>",
  });
});

test("Given a workspace with trailers: false (GitHub), When squash-merging without flags, Then the PR title and the commits are sent without Workit-Session; a workspace that keeps trailers leaves the forge default", async () => {
  const off = setup("github", github, { trailers: false });
  await verdict(off.repo);
  const result = await run(["pr", "merge", "--json"], off.repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(off.runner)).toMatchObject({
    commit_title: "feat: the PR title (#12)",
    commit_message: DEFAULT_BODY,
  });

  const on = setup("github", github);
  await verdict(on.repo);
  expect((await run(["pr", "merge", "--json"], on.repo.cwd)).code).toBe(0);
  expect(mergeCall(on.runner.calls)?.vars).toEqual({ sha: on.head, merge_method: "squash" });
  expect(on.runner.inputs).toEqual([]);
});

test("Given a workspace with trailers: false (GitLab), When squash-merging, Then squash_commit_message is the MR title and stripped commits; --subject/--body override it", async () => {
  const first = setup("gitlab", gitlab, { trailers: false });
  await verdict(first.repo);
  const result = await run(["pr", "merge", "--json"], first.repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(first.runner)).toEqual({
    sha: first.head,
    squash: true,
    squash_commit_message: `feat: the MR title\n\n${DEFAULT_BODY}`,
  });

  const second = setup("gitlab", gitlab);
  await verdict(second.repo);
  const flagged = await run(
    ["pr", "merge", "--subject", "fix: s", "--body", "B\n\nWorkit-Session: x", "--json"],
    second.repo.cwd,
  );
  expect(flagged.code, flagged.stderr).toBe(0);
  expect(mergeBody(second.runner)).toMatchObject({
    squash_commit_message: "fix: s\n\nB",
  });
});

test("pr merge: --subject/--body with a non-squash method, or a multi-line subject, is a usage error and nothing is called", async () => {
  const { repo, runner } = setup("github", github);
  for (const [argv, error] of [
    [["--method", "merge", "--subject", "s"], "use --method squash"],
    [["--method", "rebase", "--body", "b"], "use --method squash"],
    [["--subject", "a\nb"], "--subject must be one non-empty line"],
    [["--body", "b", "--body-file", "-"], "pass --body or --body-file, not both"],
  ] as const) {
    const result = await run(["pr", "merge", ...argv], repo.cwd);
    expect(result.code, argv.join(" ")).toBe(2);
    expect(result.stderr).toContain(error);
  }
  expect(mergeCall(runner.calls)).toBeUndefined();
});

test("Given an explicit --body, Then it is sent byte for byte except Workit-Session lines in its final trailer block", async () => {
  const { repo, runner } = setup("github", github);
  await verdict(repo);
  const body =
    "  Indented.\n\nWorkit-Session: prose, not a trailer block\nbecause this line is prose\n\n\n\nKept: yes\n  Workit-Session: indented continuation\nWorkit-Session: author-1\n  folded value\nRefs: #1\n\n";
  const result = await run(["pr", "merge", "--subject", "s", "--body", body, "--json"], repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(runner).commit_message).toBe(
    "  Indented.\n\nWorkit-Session: prose, not a trailer block\nbecause this line is prose\n\n\n\nKept: yes\n  Workit-Session: indented continuation\nRefs: #1\n\n",
  );
});

test("Given --body-file alone, Then its text is the squash body; with --body too it is a usage error", async () => {
  const { repo, runner } = setup("github", github);
  await verdict(repo);
  const file = path.join(repo.root, "body.md");
  writeFileSync(file, "From a file.\n");
  const both = await run(["pr", "merge", "--body", "b", "--body-file", file], repo.cwd);
  expect(both.code).toBe(2);
  expect(both.stderr).toContain("pass --body or --body-file, not both");
  expect(mergeCall(runner.calls)).toBeUndefined();
  const result = await run(
    ["pr", "merge", "--subject", "s", "--body-file", file, "--json"],
    repo.cwd,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(runner).commit_message).toBe("From a file.\n");
});

test("Given several commits and a merge commit, When trailers are off, Then the squash body lists the non-merge commits oldest first", async () => {
  const { repo, runner } = setup("github", github, { trailers: false });
  // A side branch merged in: its own commit is listed, the merge commit is not.
  repo.git("switch", "-q", "-c", "side", "HEAD~1");
  writeFileSync(path.join(repo.cwd, "side.txt"), "s\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: side\n\nWorkit-Session: author-1");
  repo.git("switch", "-q", "feature/x");
  writeFileSync(path.join(repo.cwd, "y.txt"), "y\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: y");
  repo.git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "-f", path.join(repo.root, "remote.git"), "feature/x");
  repo.subs["{{HEAD}}"] = head;
  await verdict(repo);
  const result = await run(["pr", "merge", "--json"], repo.cwd);
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(runner).commit_message).toBe(`${DEFAULT_BODY}\n\n* feat: side\n\n* feat: y`);
});

test("Given a branch past the list bounds, Then the squash body lists the first 100 commits and counts the rest, and a 140 KB body still goes through stdin", async () => {
  const { repo, runner } = setup("github", github, { trailers: false });
  for (let n = 0; n < 102; n += 1) repo.git("commit", "-q", "--allow-empty", "-m", `chore: c${n}`);
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "-f", path.join(repo.root, "remote.git"), "feature/x");
  repo.subs["{{HEAD}}"] = head;
  await verdict(repo);
  expect((await run(["pr", "merge", "--json"], repo.cwd)).code).toBe(0);
  const listed = String(mergeBody(runner).commit_message).split("\n\n* ");
  expect(listed).toHaveLength(100);
  expect(String(mergeBody(runner).commit_message)).toEndWith(
    "* chore: c98\n\n… and 3 more commits",
  );

  const big = setup("github", github);
  await verdict(big.repo);
  const body = "x".repeat(140 * 1024);
  const result = await run(
    ["pr", "merge", "--subject", "s", "--body", body, "--json"],
    big.repo.cwd,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(mergeBody(big.runner).commit_message).toBe(body);
  // argv stays small whatever the message size.
  for (const { args } of big.runner.inputs) expect(args.join(" ").length).toBeLessThan(200);
});

test.skipIf(process.platform === "win32")(
  "Given an input, When the real runner starts gh, Then the input arrives on its stdin",
  () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "wk-gh-stdin-"));
    try {
      writeFileSync(path.join(bin, "gh"), "#!/bin/sh\ncat\n", { mode: 0o755 });
      const runner = systemRunner("github", "github.com", {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const body = JSON.stringify({ commit_message: "y".repeat(200 * 1024) });
      const piped = runner("gh", ["api", "--input", "-"], { timeoutMs: 10_000, input: body });
      expect(piped.status).toBe(0);
      expect(piped.stdout).toBe(body);
      // Without an input, stdin stays closed (nothing to read).
      expect(runner("gh", ["api"], { timeoutMs: 10_000 }).stdout).toBe("");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);
