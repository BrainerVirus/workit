// #835: cleanup by default when work finishes. After `workit pr merge` lands a
// squash merge (fake forge, local bare remote), the registered processes in
// the slice worktree stop before it goes, a clean checkout on the merged
// branch moves to the remote trunk and the branch goes, and workspace
// `cleanup: keep` or a keep decision leaves things in place, saying so. The
// process table is a fake behind the procTree seam: nothing real is signalled.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { browserDeps } from "@/packages/workit-core/src/core/browsers";
import {
  cleanupAfterMerge,
  cleanupLines,
  managedWorktreeRoot,
} from "@/packages/workit-core/src/core/cleanup";
import { procTree } from "@/packages/workit-core/src/core/proc-tree";
import { openProcs, updateExtra } from "@/packages/workit-core/src/core/procs";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { readProc, upsertProc, type ProcRow } from "@/packages/workit-core/src/store/threads/procs";
import {
  fixture,
  makeForgeRepo,
  replayRunner,
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

setDefaultTimeout(60_000);

const SESSION = "author-1";
let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
const savedTree = { ...procTree };
const savedBrowsers = { ...browserDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-endclean-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

/** The fake process table: pid -> its group, start time and whether it runs. */
const table = new Map<number, { pgid: number; start: string; alive: boolean }>();
let nextPid = 50_000;
const esrch = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
beforeEach(() => {
  procTree.platform = "linux";
  procTree.start = (pid) => (table.get(pid)?.alive ? table.get(pid)!.start : null);
  procTree.kill = (target, signal) => {
    const members = [...table.entries()]
      .filter(([pid, proc]) => proc.alive && (target < 0 ? proc.pgid === -target : pid === target))
      .map(([, proc]) => proc);
    if (members.length === 0) throw esrch();
    if (signal === 0) return;
    for (const proc of members) proc.alive = false;
  };
  procTree.table = () => null;
  procTree.sleep = async () => {};
  browserDeps.processes = () => [];
});

const repos: ForgeRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  Object.assign(procTree, savedTree);
  Object.assign(browserDeps, savedBrowsers);
  table.clear();
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let env: NodeJS.ProcessEnv = {};

const run = async (argv: string[], cwd: string, session = SESSION) => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, stdout, json: () => JSON.parse(stdout) };
};

const GH_STATUS = 'graphql status {"owner":"o","name":"r","number":"12"}';

type Options = { workspace?: Record<string, unknown>; children?: number[] };

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();

/** The forge's squash merge: one commit with feature/x's change lands on the remote main. */
const squashOnRemote = (repo: ForgeRepo) => {
  const clone = path.join(repo.root, "squash");
  git(repo.root, "clone", "-q", path.join(repo.root, "remote.git"), clone);
  git(clone, "merge", "-q", "--squash", "origin/feature/x");
  git(clone, "commit", "-q", "-m", "feat: x (#12)");
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
};

/** A READY PR merged under merge: verified; its remote head branch lives in a local bare remote. */
const setup = (options: Options = {}) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "wk-endclean-state-"));
  dirs.push(state);
  env = { ...process.env, WORKIT_STATE_DIR: state };
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
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
  const remote = { squash: "" };
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    [GH_STATUS]: () =>
      merged ? fixture("github/pr-merged.json") : fixture("github/pr-passing.json"),
    "GET repos/o/r/pulls/12": () =>
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
      }),
    "GET repos/o/r/pulls?state=open&base=feature%2Fx&per_page=100": () =>
      JSON.stringify((options.children ?? []).map((number) => ({ number }))),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged = true;
      remote.squash = squashOnRemote(repo);
      return JSON.stringify({ sha: remote.squash, merged: true, message: "merged" });
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
  return { repo, remote };
};

const merge = async (repo: ForgeRepo) => {
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it", "--branch", "feature/x"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code, verdict.stdout).toBe(0);
  return run(["pr", "merge", "--pr", "12", "--json"], repo.cwd);
};

/** A slice worktree on feature/x under the managed root, the main checkout back on main. */
const sliceWorktree = (repo: ForgeRepo) => {
  const dir = path.join(managedWorktreeRoot(env), "r", "slice");
  repo.git("switch", "-q", "main");
  repo.git("worktree", "add", "-q", dir, "feature/x");
  return dir;
};

let counter = 0;
/** A running dev server registered by this session, started in `cwd`. */
const server = (cwd: string, fields: Partial<ProcRow> = {}): ProcRow => {
  const pid = (nextPid += 1);
  table.set(pid, { pgid: pid, start: `start-${pid}`, alive: true });
  const store = openProcs(env);
  try {
    const id = `pend${(counter += 1).toString().padStart(4, "0")}`;
    updateExtra(env, id, { name: `dev${counter}`, state: "running" });
    return upsertProc(store, id, () => ({
      session: SESSION,
      lead: SESSION,
      host: "claude-code",
      hostPid: null,
      cmd: "bun run dev",
      kind: "server",
      startedAt: new Date().toISOString(),
      pid,
      pgid: pid,
      pidStart: `start-${pid}`,
      cwd,
      ...fields,
    }));
  } finally {
    store.close();
  }
};

const running = (row: ProcRow) => table.get(row.pid!)?.alive === true;

const ended = (row: ProcRow) => {
  const store = openProcs(env);
  try {
    return readProc(store, row.id)?.endedAt ?? null;
  } finally {
    store.close();
  }
};

const cleanupRows = (repo: ForgeRepo) => {
  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === "cleanup.removed");
};

test("Given a slice squash-merged with pr merge and a registered server in its worktree, Then the server stops, the worktree and local branch go, and one cleanup.removed row names all three", async () => {
  const { repo } = setup();
  const dir = sliceWorktree(repo);
  const dev = server(path.join(dir, "web"));
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const cleanup = result.json().data.localCleanup;
  expect(cleanup).toMatchObject({
    branchDeleted: true,
    procsStopped: [{ id: dev.id, cmd: "bun run dev" }],
    notes: [],
  });
  expect(running(dev)).toBe(false);
  expect(ended(dev)).not.toBeNull();
  expect(existsSync(dir)).toBe(false);
  expect(repo.git("branch", "--list", "feature/x")).toBe("");
  expect(cleanupRows(repo)).toEqual([
    expect.objectContaining({
      trigger: "pr merge",
      branch: "feature/x",
      worktrees: [cleanup.worktreeRemoved],
      branches: ["feature/x"],
      procs: [dev.id],
    }),
  ]);
});

test("Given another session's server in the slice worktree, Then it keeps running and the worktree and branch stay, saying whose it is", async () => {
  const { repo } = setup();
  const dir = sliceWorktree(repo);
  const theirs = server(dir, { session: "someone-else", lead: "someone-else" });
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const cleanup = result.json().data.localCleanup;
  expect(cleanup).toMatchObject({ branchDeleted: false, worktreeRemoved: null, procsStopped: [] });
  expect(cleanup.notes.join("\n")).toContain(`process ${theirs.id}`);
  expect(cleanup.notes.join("\n")).toContain("owned by session someone-else");
  expect(running(theirs)).toBe(true);
  expect(existsSync(dir)).toBe(true);
});

test("Given the checkout the command runs in, clean and on the merged branch, Then it ends on main at the remote main's commit and the branch is deleted", async () => {
  const { repo, remote } = setup();
  expect(repo.git("branch", "--show-current")).toBe("feature/x");
  const dev = server(repo.cwd);
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const cleanup = result.json().data.localCleanup;
  expect(cleanup).toMatchObject({
    branchDeleted: true,
    switched: { path: expect.any(String), to: "main", head: remote.squash },
    procsStopped: [{ id: dev.id }],
  });
  expect(repo.git("branch", "--show-current")).toBe("main");
  expect(repo.git("rev-parse", "HEAD")).toBe(remote.squash);
  expect(repo.git("branch", "--list", "feature/x")).toBe("");
  expect(running(dev)).toBe(false);
  const human = await run(["ledger", "list", "--type", "cleanup.removed"], repo.cwd);
  expect(human.stdout).toContain("cleanup.removed");
  expect(cleanupRows(repo)).toEqual([
    expect.objectContaining({
      branches: ["feature/x"],
      procs: [dev.id],
      switched: { path: cleanup.switched.path, to: "main", head: remote.squash },
    }),
  ]);
});

test("Given the checkout the command runs in is dirty on the merged branch, Then nothing changes and the output says why", async () => {
  const { repo } = setup();
  const before = repo.git("rev-parse", "HEAD");
  writeFileSync(path.join(repo.cwd, "wip.txt"), "unsaved\n");
  const dev = server(repo.cwd);
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it", "--branch", "feature/x"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code).toBe(0);
  const result = await run(["pr", "merge", "--pr", "12"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("1 uncommitted change (wip.txt)");
  expect(result.stdout).toContain("kept both");
  expect(repo.git("branch", "--show-current")).toBe("feature/x");
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
  expect(existsSync(path.join(repo.cwd, "wip.txt"))).toBe(true);
  expect(running(dev)).toBe(true);
  expect(cleanupRows(repo)).toEqual([]);
});

test("Given workspace cleanup keep, Then nothing is removed or stopped and the output says `kept: workspace cleanup keep`", async () => {
  const { repo } = setup({ workspace: { cleanup: "keep" } });
  const dir = sliceWorktree(repo);
  const dev = server(dir);
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it", "--branch", "feature/x"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code).toBe(0);
  const result = await run(["pr", "merge", "--pr", "12"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain("kept: workspace cleanup keep (w)");
  expect(running(dev)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  expect(repo.git("branch", "--list", "feature/x")).not.toBe("");
  expect(cleanupRows(repo)).toEqual([]);
});

test("Given a keep decision for proc:<id>, Then that process keeps running, its worktree stays, and the output names the decision id", async () => {
  const { repo } = setup();
  const dir = sliceWorktree(repo);
  const dev = server(dir);
  const decision = await run(
    [
      "ledger",
      "decision",
      "keep the demo server",
      "--why",
      "the user: leave the demo running for the review",
      "--keep",
      `proc:${dev.id}`,
      "--json",
    ],
    repo.cwd,
  );
  expect(decision.code, decision.stdout).toBe(0);
  const id = decision.json().data.id;
  const verdict = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it", "--branch", "feature/x"],
    repo.cwd,
    "reviewer-2",
  );
  expect(verdict.code).toBe(0);
  const result = await run(["pr", "merge", "--pr", "12"], repo.cwd);
  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain(`process ${dev.id} (bun run dev) kept (decision ${id})`);
  expect(running(dev)).toBe(true);
  expect(existsSync(dir)).toBe(true);
});

test("Given a local branch with a commit the merge did not include, Then it is kept with its worktree and server, with the reason", async () => {
  // pr merge refuses a branch ahead of its PR, so the delivery end is driven directly.
  const { repo } = setup();
  const dir = sliceWorktree(repo);
  const merged = git(dir, "rev-parse", "HEAD");
  const dev = server(dir);
  writeFileSync(path.join(dir, "later.txt"), "later\n");
  git(dir, "add", "later.txt");
  git(dir, "commit", "-q", "-m", "later");
  const out = await cleanupAfterMerge(repo.cwd, "feature/x", merged, {
    actor: { host: "claude-code", session: SESSION, agentId: null },
    trigger: "pr merge",
    env,
  });
  expect(cleanupLines(out, "feature/x")).toEqual([
    "local feature/x has commits that were not merged; kept it",
  ]);
  expect(running(dev)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  expect(repo.git("branch", "--list", "feature/x")).not.toBe("");
});

test("Given an open PR into the branch, Then the remote and local branch and the worktree are kept with the reason", async () => {
  const { repo } = setup({ children: [13] });
  const dir = sliceWorktree(repo);
  const result = await merge(repo);
  expect(result.code, result.stdout).toBe(0);
  const data = result.json().data;
  expect(JSON.stringify(data.deletedBranch)).toContain("#13");
  expect(data.localCleanup).toBeNull();
  expect(existsSync(dir)).toBe(true);
  expect(repo.git("branch", "--list", "feature/x")).not.toBe("");
});
