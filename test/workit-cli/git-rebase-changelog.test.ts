import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// `workit git rebase` over CHANGELOG.md (#791): fanout slices that each add an
// Unreleased entry rebase onto one another's merges without a manual step,
// with no merge driver installed; any other conflict still aborts.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-rebase-changelog-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  rmSync(path.join(configHome.configDir, "config.json"), { force: true });
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

const doc = (entries: string[], released = "- first\n") =>
  `# Changelog\n\n## [Unreleased]\n\n${entries.length ? `### Added\n\n${entries.map((e) => `- ${e}\n`).join("")}\n` : ""}## [1.0.0] - 2026-01-01\n\n### Added\n\n${released}`;

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repo whose main holds an empty-Unreleased CHANGELOG.md, with no merge driver. */
const setup = () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.write("CHANGELOG.md", doc([]));
  repo.git("add", "CHANGELOG.md");
  repo.git("commit", "-q", "-m", "docs: changelog");
  repo.git("push", "-q", "origin", "main");
  expect(existsSync(path.join(repo.cwd, ".gitattributes"))).toBe(false);
  return repo;
};

/** A slice branch cut from main that commits `files`, then main is checked out again. */
const slice = (repo: RemoteRepo, branch: string, files: Record<string, string>) => {
  repo.git("switch", "-q", "-c", branch, "main");
  for (const [file, text] of Object.entries(files)) repo.write(file, text);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `feat: ${branch}`);
  repo.git("switch", "-q", "main");
};

/** Land `branch` on the remote main by a squash merge made in another clone. */
const land = (repo: RemoteRepo, branch: string) => {
  const other = path.join(repo.root, `land-${branch.replaceAll("/", "-")}`);
  git(repo.root, "clone", "-q", repo.bare, other);
  git(other, "config", "user.name", "t");
  git(other, "config", "user.email", "t@t");
  git(other, "config", "commit.gpgsign", "false");
  git(other, "fetch", "-q", repo.cwd, `${branch}:${branch}`);
  git(other, "merge", "-q", "--squash", branch);
  git(other, "commit", "-q", "-m", `feat: land ${branch}`);
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
};

const changelog = (repo: RemoteRepo) => readFileSync(path.join(repo.cwd, "CHANGELOG.md"), "utf8");

test("Given 3 slices that each add an Unreleased entry, When slice 1 merges and slice 2 runs workit git rebase (then slice 2 merges and slice 3 rebases), Then each rebase succeeds keeping every entry, with no manual step", async () => {
  const repo = setup();
  slice(repo, "feature/one", { "one.txt": "1\n", "CHANGELOG.md": doc(["one"]) });
  slice(repo, "feature/two", { "two.txt": "2\n", "CHANGELOG.md": doc(["two"]) });
  slice(repo, "feature/three", { "three.txt": "3\n", "CHANGELOG.md": doc(["three"]) });

  land(repo, "feature/one");
  repo.git("switch", "-q", "feature/two");
  const two = await run(["git", "rebase", "--json"], repo.cwd);
  expect(two.code, two.stdout + two.stderr).toBe(0);
  expect(two.json().data).toMatchObject({ rebased: true, changelogMerged: ["CHANGELOG.md"] });
  expect(changelog(repo)).toBe(doc(["one", "two"]));
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(repo.git("log", "-1", "--format=%s")).toBe("feat: feature/two");

  land(repo, "feature/two");
  repo.git("switch", "-q", "feature/three");
  const three = await run(["git", "rebase"], repo.cwd);
  expect(three.code, three.stdout + three.stderr).toBe(0);
  expect(three.stdout).toContain("changelog: kept both sides' Unreleased entries in CHANGELOG.md");
  expect(changelog(repo)).toBe(doc(["one", "two", "three"]));
  expect(existsSync(path.join(repo.cwd, "three.txt"))).toBe(true);
});

test("Given both sides change the same released line in CHANGELOG.md, When workit git rebase, Then it still aborts naming CHANGELOG.md and the branch is unchanged", async () => {
  const repo = setup();
  slice(repo, "feature/one", { "CHANGELOG.md": doc(["one"], "- first, theirs\n") });
  slice(repo, "feature/two", { "CHANGELOG.md": doc(["two"], "- first, mine\n") });
  land(repo, "feature/one");
  repo.git("switch", "-q", "feature/two");
  const before = repo.git("rev-parse", "HEAD");

  const result = await run(["git", "rebase", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  const envelope = result.json();
  expect(envelope.data).toMatchObject({ reason: "rebase_conflict", conflicts: ["CHANGELOG.md"] });
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
  expect(repo.git("status", "--porcelain")).toBe("");
});

test("Given an append-only changelog conflict alongside a conflict in another file, When workit git rebase, Then it aborts naming both and the branch is unchanged", async () => {
  const repo = setup();
  slice(repo, "feature/one", { "base-0.txt": "theirs\n", "CHANGELOG.md": doc(["one"]) });
  slice(repo, "feature/two", { "base-0.txt": "mine\n", "CHANGELOG.md": doc(["two"]) });
  land(repo, "feature/one");
  repo.git("switch", "-q", "feature/two");
  const before = repo.git("rev-parse", "HEAD");

  const result = await run(["git", "rebase", "--json"], repo.cwd);
  expect(result.code).not.toBe(0);
  expect(result.json().data.conflicts.toSorted()).toEqual(["CHANGELOG.md", "base-0.txt"]);
  expect(repo.git("rev-parse", "HEAD")).toBe(before);
  expect(repo.git("status", "--porcelain")).toBe("");
});
