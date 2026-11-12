import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
  type ForgeRepo,
  type Reply,
} from "@/test/shared/helpers/forge-replay";

// #311: `pr merge --pr N` from a checkout without the PR's branch reads the
// head from the forge, fetches it for the gate (a ref it removes afterwards),
// and finds a verdict mirrored from another clone of the same remote.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-merge-nobranch-config-");
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

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const run = async (argv: string[], cwd: string, session: string) => {
  let stdout = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: session },
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await main(argv, io);
  return { code, json: () => JSON.parse(stdout) };
};

const refs = (cwd: string): string => git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");

type Setup = { repo: ForgeRepo; clone: string; head: string; merges: () => number };

/**
 * The fake forge's PR #12 is feature/x at a commit pushed from a verifier's
 * clone. The bare remote names its own origin, so the checkout and the clone
 * share one verdict-mirror key, unique to the test. The checkout has no feature/x, local or
 * tracking, and not the head commit.
 */
const setup = (): Setup => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeForgeRepo("github");
  repos.push(repo);
  const bare = path.join(repo.root, "remote.git");
  // A remote of its own: the verdict mirror is per remote and outlives a test.
  const remote = `https://github.com/o/${path.basename(repo.root)}.git`;
  git(bare, "remote", "add", "origin", remote);
  const clone = path.join(repo.root, "verify");
  git(repo.root, "clone", "-q", "--branch", "feature/x", bare, clone);
  for (const [key, value] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "Workit Test"],
    ["commit.gpgsign", "false"],
  ] as const)
    git(clone, "config", key, value);
  writeFileSync(path.join(clone, "fix.txt"), "fix\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "fix");
  git(clone, "push", "-q", "origin", "feature/x");
  const head = git(clone, "rev-parse", "HEAD");
  repo.subs["{{HEAD}}"] = head;

  repo.git("switch", "-q", "main");
  repo.git("branch", "-q", "-D", "feature/x");
  repo.git("update-ref", "-d", "refs/remotes/origin/feature/x");

  let merged = 0;
  const routes: Record<string, Reply> = {
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "graphql find": fixture("github/find-pr.json"),
    'graphql status {"owner":"o","name":"r","number":"12"}': () =>
      fixture(merged ? "github/pr-merged.json" : "github/pr-passing.json"),
    "PUT repos/o/r/pulls/12/merge": () => {
      merged += 1;
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
          verification: "independent",
          deleteBranch: false,
          vcs: { provider: "github", account: "octo" },
          autonomy: { merge: true },
        },
      ],
    }),
  );
  return { repo, clone, head, merges: () => merged };
};

const verifyInClone = async (clone: string) => {
  const recorded = await run(
    ["ledger", "verdict", "verified", "--how", "exercised it in a clone", "--json"],
    clone,
    "reviewer-2",
  );
  expect(recorded.code).toBe(0);
  return recorded.json().data.id as string;
};

test("Given a verdict recorded in another clone and no local branch, When pr merge --pr 12 runs, Then it fetches the forge head, accepts the mirrored verdict and merges, leaving no new ref", async () => {
  const { repo, clone, head, merges } = setup();
  const verdictId = await verifyInClone(clone);
  rmSync(clone, { recursive: true, force: true });
  const before = refs(repo.cwd);

  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd, "author-1");
  expect(result.json()).toMatchObject({
    ok: true,
    data: { head, verdict: { accepted: true, verdictId } },
  });
  expect(result.code).toBe(0);
  expect(merges()).toBe(1);
  expect(refs(repo.cwd)).toBe(before);
});

test("Given no verdict for the forge head and no local branch, Then the refusal is NEEDS_VERDICT naming the head, not head_mismatch, and no ref is left", async () => {
  const { repo, head, merges } = setup();
  const before = refs(repo.cwd);

  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd, "author-1");
  expect(result.json()).toMatchObject({ ok: false, data: { reason: "needs_verdict" } });
  expect(result.json().error).toContain(`NEEDS_VERDICT: PR #12`);
  expect(result.json().error).toContain(head.slice(0, 12));
  expect(merges()).toBe(0);
  expect(refs(repo.cwd)).toBe(before);
});

test("Given a local branch behind the forge head, Then head_mismatch is unchanged", async () => {
  const { repo, clone, merges } = setup();
  await verifyInClone(clone);
  repo.git("branch", "-q", "feature/x", "main");

  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd, "author-1");
  expect(result.json()).toMatchObject({ ok: false, data: { reason: "head_mismatch" } });
  expect(result.json().error).toContain("head_mismatch: the verdict check reads feature/x at");
  expect(merges()).toBe(0);
});

test("Given the forge head cannot be fetched, Then the refusal names the head and the fetch command, and no ref is left", async () => {
  const { repo, head, merges } = setup();
  repo.git("remote", "set-url", "origin", path.join(repo.root, "gone.git"));
  const before = refs(repo.cwd);

  const result = await run(["pr", "merge", "--pr", "12", "--json"], repo.cwd, "author-1");
  expect(result.json()).toMatchObject({ ok: false, data: { reason: "head_unfetched" } });
  expect(result.json().error).toContain(head.slice(0, 12));
  expect(result.json().unblock).toContain("git fetch origin feature/x");
  expect(merges()).toBe(0);
  expect(refs(repo.cwd)).toBe(before);
});
