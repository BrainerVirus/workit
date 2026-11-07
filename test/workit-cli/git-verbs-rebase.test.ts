import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// `workit git rebase`: update the current branch onto its fresh base. Real git
// against a local bare remote.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-rebase-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configHome.configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  return repo;
};

const SESSION = { ...process.env, WORKIT_SESSION_ID: "author-1" };

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: SESSION,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** feature/a with one commit on `file`, pushed with workit (so the lease is recorded). */
const pushedFeature = async (repo: RemoteRepo, file = "a.txt", text = "a\n") => {
  repo.git("switch", "-q", "-c", "feature/a");
  repo.write(file, text);
  expect((await run(["git", "commit", "-m", "feat: a", "--", file], repo.cwd)).code).toBe(0);
  expect((await run(["git", "push", "--set-upstream"], repo.cwd)).code).toBe(0);
  return repo.git("rev-parse", "HEAD");
};

const rebaseInProgress = (repo: RemoteRepo) =>
  existsSync(path.join(repo.cwd, ".git", "rebase-merge")) ||
  existsSync(path.join(repo.cwd, ".git", "rebase-apply"));

test("Given a feature branch behind origin/main without conflicts, When workit git rebase, Then it is rebased onto the fetched origin/main, the ledger records it and the next step is the force-with-lease push", async () => {
  const repo = setup();
  const before = await pushedFeature(repo);
  const mainTip = repo.pushFromElsewhere("main");

  const result = await run(["git", "rebase"], repo.cwd);
  expect(result.code).toBe(0);
  const head = repo.git("rev-parse", "HEAD");
  expect(head).not.toBe(before);
  expect(repo.git("rev-parse", "HEAD~1")).toBe(mainTip);
  expect(repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");
  const lines = result.stdout.trim().split("\n");
  expect(lines[0]).toContain("rebased feature/a onto origin/main");
  expect(lines.at(-1)).toBe("next: workit git push --force-with-lease");

  const ledger = readLedger(repo.cwd);
  if (!ledger.ok) throw new Error("ledger unreadable");
  const row = ledger.value.rows.findLast((entry) => entry.type === "branch.rebased") as
    | Record<string, unknown>
    | undefined;
  expect(row).toMatchObject({
    branch: "feature/a",
    base: "origin/main",
    baseSha: mainTip,
    previous: before,
    head,
    observer: "workit_cli",
  });

  const pushed = await run(["git", "push", "--force-with-lease"], repo.cwd);
  expect(pushed.code).toBe(0);
  expect(repo.remoteTip("feature/a")).toBe(head);
});

test("Given a conflicting rebase, When workit git rebase, Then it is aborted, the head is unchanged, the exit is non-zero and the conflicting paths are listed", async () => {
  const repo = setup();
  const before = await pushedFeature(repo, "base-0.txt", "mine\n");
  repo.pushFromElsewhere("main", "base-0.txt");

  const result = await run(["git", "rebase", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  const envelope = result.json();
  expect(envelope.code).toBe("failed");
  expect(envelope.data.reason).toBe("rebase_conflict");
  expect(envelope.error).toContain("base-0.txt");
  expect(envelope.data.conflicts).toEqual(["base-0.txt"]);
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
  expect(repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/a");
  expect(rebaseInProgress(repo)).toBe(false);
  expect(repo.git("status", "--porcelain")).toBe("");
});

test("Given the trunk is checked out, When workit git rebase, Then it refuses and leaves main as it was", async () => {
  const repo = setup();
  const before = repo.git("rev-parse", "HEAD");
  repo.pushFromElsewhere("main");
  const result = await run(["git", "rebase", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.json().error).toContain("protected_branch");
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
});

test("Given a branch already on its base, When workit git rebase, Then nothing is rewritten, no push is suggested and the ledger stays as it was", async () => {
  const repo = setup();
  const before = await pushedFeature(repo);
  const rows = () => {
    const ledger = readLedger(repo.cwd);
    return ledger.ok ? ledger.value.rows.filter((row) => row.type === "branch.rebased").length : -1;
  };
  const result = await run(["git", "rebase"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("already up to date");
  expect(result.stdout).not.toContain("force-with-lease");
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
  expect(rows()).toBe(0);
});

test("Given uncommitted changes to tracked files, When workit git rebase, Then it refuses before fetching or rewriting", async () => {
  const repo = setup();
  const before = await pushedFeature(repo);
  repo.pushFromElsewhere("main");
  repo.write("a.txt", "edited\n");
  const result = await run(["git", "rebase", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.json().error).toContain("uncommitted");
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
});

test("Given --onto a local stack parent, When workit git rebase, Then the branch is rebased onto that branch without a fetch", async () => {
  const repo = setup();
  repo.git("switch", "-q", "-c", "feature/parent");
  repo.write("p.txt", "p\n");
  expect((await run(["git", "commit", "-m", "feat: parent", "--", "p.txt"], repo.cwd)).code).toBe(
    0,
  );
  repo.git("switch", "-q", "-c", "feature/child", "main");
  repo.write("c.txt", "c\n");
  expect((await run(["git", "commit", "-m", "feat: child", "--", "c.txt"], repo.cwd)).code).toBe(0);
  const result = await run(["git", "rebase", "--onto", "feature/parent", "--json"], repo.cwd);
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    base: "feature/parent",
    rebased: true,
  });
  expect(repo.git("rev-parse", "HEAD~1")).toBe(repo.git("rev-parse", "feature/parent"));
  expect(result.json().data.next).toBe("workit git push --set-upstream");
});

test("git rebase: an unknown argument is a usage error", async () => {
  const repo = setup();
  const result = await run(["git", "rebase", "-i"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("workit git rebase");
});
