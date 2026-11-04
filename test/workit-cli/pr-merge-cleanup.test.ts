import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { RELEASE_COMMAND } from "@/packages/workit-core/src/core/cleanup";
import { readLedger } from "@/packages/workit-core/src/ledger";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #653: once `workit pr merge` lands a PR and deletes its remote branch, the
// branch's clean worktree under the managed root and the local branch go and
// a ledger row lists them; a dirty worktree is kept and named.

setDefaultTimeout(60_000);

let configDir = "";
let cacheHome = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-mergeclean-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: ForgeRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  cacheHome = "";
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string, session = "author-1") => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session, XDG_CACHE_HOME: cacheHome },
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

/** A worktree on feature/x under the managed root (XDG_CACHE_HOME/workit-wt/<repo>/<slice>). */
const managedWorktree = (repo: ForgeRepo) => {
  cacheHome = path.join(repo.root, "cache");
  const dir = path.join(cacheHome, "workit-wt", "r", "slice");
  repo.git("switch", "-q", "main");
  repo.git("worktree", "add", "-q", dir, "feature/x");
  return dir;
};

test("pr merge: the merged branch's clean managed worktree and local branch are removed, and the ledger lists them", async () => {
  const repo = setup();
  const dir = managedWorktree(repo);
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const cleanup = result.json().data.localCleanup;
  expect(cleanup).toMatchObject({ branchDeleted: true, dirty: null, notes: [] });
  expect(path.basename(String(cleanup.worktreeRemoved))).toBe("slice");
  expect(remoteHas(repo, "feature/x")).toBe(false);
  expect(existsSync(dir)).toBe(false);
  expect(repo.git("branch", "--list", "feature/x")).toBe("");
  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  const rows = ledger.value.rows.filter((row) => row.type === "cleanup.removed");
  expect(rows).toEqual([
    expect.objectContaining({
      trigger: "pr merge",
      branch: "feature/x",
      worktrees: [cleanup.worktreeRemoved],
      branches: ["feature/x"],
    }),
  ]);
});

test("pr merge: a dirty managed worktree is kept with its branch; the output names the paths and the release command", async () => {
  const repo = setup();
  const dir = managedWorktree(repo);
  writeFileSync(path.join(dir, "wip.txt"), "unsaved\n");
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const cleanup = result.json().data.localCleanup;
  expect(cleanup).toMatchObject({
    branchDeleted: false,
    worktreeRemoved: null,
    dirty: { paths: ["wip.txt"] },
    recorded: null,
  });
  expect(cleanup.notes.join("\n")).toContain("wip.txt");
  expect(cleanup.notes.join("\n")).toContain(RELEASE_COMMAND);
  expect(existsSync(path.join(dir, "wip.txt"))).toBe(true);
  expect(repo.git("branch", "--list", "feature/x")).not.toBe("");
});
