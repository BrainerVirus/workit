import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #384: `workit pr merge` deletes the head branch by default (workspace
// setting `deleteBranch`, `--keep-branch` opts out) and skips, with a note and
// never a refusal, a branch that must stay.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-delbranch-config-");
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

const run = async (argv: string[], cwd: string, session = "author-1") => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

type Options = {
  workspace?: Record<string, unknown>;
  pull?: Record<string, unknown>;
  children?: number[] | "error";
  /** The PR's head branch name when it is not feature/x. */
  head?: string;
};

const pull = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 12,
    html_url: "https://github.com/o/r/pull/12",
    state: "open",
    merged: false,
    draft: false,
    title: "feat: x",
    user: { login: "octo" },
    base: { ref: "main", repo: { full_name: "o/r" } },
    head: { ref: "feature/x", repo: { full_name: "o/r" } },
    ...fields,
  });

/** A READY PR merged under merge: verified; its remote head branch lives in a local bare remote. */
const setup = (options: Options = {}) => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  // The push URL names the forge so the PR resolves; core.sshCommand sends the
  // push itself to the local bare remote.
  const bare = path.join(repo.root, "remote.git");
  const ssh = path.join(repo.root, "fake-ssh.sh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n*receive-pack*) exec git-receive-pack '${bare}' ;;\n*) exec git-upload-pack '${bare}' ;;\nesac\n`,
  );
  chmodSync(ssh, 0o755);
  repo.git("remote", "set-url", "--push", "origin", "git@github.com:o/r.git");
  repo.git("config", "core.sshCommand", ssh);
  let merged = false;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () =>
      merged
        ? fixture("github/pr-merged.json")
        : fixture("github/pr-passing.json").replaceAll(
            '"headRefName": "feature/x"',
            `"headRefName": "${options.head ?? "feature/x"}"`,
          ),
    "GET repos/o/r/pulls/12": () =>
      pull({
        head: { ref: options.head ?? "feature/x", repo: { full_name: "o/r" } },
        ...options.pull,
      }),
    "GET repos/o/r/pulls?state=open&base=feature%2Fx&per_page=100": () =>
      options.children === "error"
        ? "not json"
        : JSON.stringify((options.children ?? []).map((number) => ({ number }))),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      return JSON.stringify({ sha: "{{BASE}}", merged: true, message: "merged" });
    },
  };
  Object.assign(forgeDeps, {
    runner: replayRunner(routes, repo.subs),
    sleep: async () => {},
    now: () => 0,
  });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          verification: "self",
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: "verified" },
          ...options.workspace,
        },
      ],
    }),
  );
  return repo;
};

const remoteHas = (repo: ForgeRepo, branch: string) =>
  repo.git("ls-remote", path.join(repo.root, "remote.git"), `refs/heads/${branch}`) !== "";

const merge = async (repo: ForgeRepo, ...flags: string[]) => {
  const branch = flags.includes("--develop") ? "develop" : "feature/x";
  if (branch === "develop") repo.git("branch", "-q", "develop", "feature/x");
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it", "--branch", branch],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code).toBe(0);
  // Leave feature/x so the local branch is not checked out in the main checkout.
  repo.git("switch", "-q", "main");
  return run(
    ["pr", "merge", "--pr", "12", "--json", ...flags.filter((f) => f !== "--develop")],
    repo.cwd,
  );
};

const localBranch = (repo: ForgeRepo) => repo.git("branch", "--list", "feature/x");

test("pr merge: by default the remote head branch is deleted and so is the local one", async () => {
  const repo = setup();
  expect(remoteHas(repo, "feature/x")).toBe(true);
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data).toMatchObject({
    deletedBranch: true,
    localCleanup: { branchDeleted: true, worktreeRemoved: null, notes: [] },
  });
  expect(remoteHas(repo, "feature/x")).toBe(false);
  expect(localBranch(repo)).toBe("");
});

test("pr merge --keep-branch: the branch stays on the remote and locally", async () => {
  const repo = setup();
  const result = await merge(repo, "--keep-branch");
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({ deletedBranch: false, localCleanup: null });
  expect(remoteHas(repo, "feature/x")).toBe(true);
  expect(localBranch(repo)).not.toBe("");
});

test("pr merge: workspace deleteBranch=false keeps the branch; --delete-branch still deletes it", async () => {
  const repo = setup({ workspace: { deleteBranch: false } });
  const result = await merge(repo);
  expect(result.code).toBe(0);
  expect(result.json().data.deletedBranch).toBe(false);
  expect(remoteHas(repo, "feature/x")).toBe(true);

  const again = setup({ workspace: { deleteBranch: false } });
  const explicit = await merge(again, "--delete-branch");
  expect(explicit.json().data.deletedBranch).toBe(true);
  expect(remoteHas(again, "feature/x")).toBe(false);
});

test("pr merge: --delete-branch and --keep-branch together are a usage error", async () => {
  const repo = setup();
  const result = await run(["pr", "merge", "--delete-branch", "--keep-branch"], repo.cwd);
  expect(result.code).toBe(2);
});

const skipped = async (options: Options, reason: RegExp) => {
  const repo = setup(options);
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const { deletedBranch } = result.json().data;
  expect(deletedBranch).toEqual({ skipped: expect.stringMatching(reason) });
  expect(remoteHas(repo, "feature/x")).toBe(true);
  expect(localBranch(repo)).not.toBe("");
};

test("pr merge: a fork PR's branch is kept, the merge still lands", async () => {
  await skipped(
    { pull: { head: { ref: "feature/x", repo: { full_name: "forker/r" } } } },
    /not known/,
  );
});

test("pr merge: a branch another open PR targets (a stack parent) is kept", async () => {
  await skipped({ children: [13] }, /#13 targets feature\/x/);
});

test("pr merge: a PR by someone other than vcs.account keeps its branch (#442)", async () => {
  await skipped({ pull: { user: { login: "christian" } } }, /by christian, not octo/);
});

test("pr merge: when the open-PR list cannot be read the branch is kept", async () => {
  await skipped({ children: "error" }, /could not list the open PRs/);
});

test("pr merge: a head branch a custom policy protects is kept, the merge still lands", async () => {
  const repo = setup();
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main", "feature/x"] },
    }),
  );
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.deletedBranch).toEqual({
    skipped: expect.stringMatching(/feature\/x is protected/),
  });
});

test("pr merge: a protected branch (develop -> main under gitflow) is kept, the merge still lands", async () => {
  const repo = setup({ head: "develop" });
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const result = await merge(repo, "--develop");
  expect(result.code, result.stdout).toBe(0);
  expect(result.json().data.deletedBranch).toEqual({
    skipped: expect.stringMatching(/develop is protected/),
  });
});
