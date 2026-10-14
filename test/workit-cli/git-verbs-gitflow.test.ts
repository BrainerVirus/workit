import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// git-flow awareness of `workit git branch` and `workit git push --release`
// per preset (gitflow configured or detected, github-flow, custom), against a
// real checkout whose origin is a local bare repository.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-gitflow-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json", "vcs.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** main plus a develop that is one commit ahead of it, both on origin. */
const flowRepo = (config: Record<string, unknown> | null): RemoteRepo => {
  if (config) writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  repo.git("switch", "-q", "main");
  return repo;
};

const workspace = (repo: RemoteRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

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

/** Branch, report the base, and return to main for the next case. */
const baseOf = async (repo: RemoteRepo, args: string[]) => {
  const result = await run(["git", "branch", ...args, "--json"], repo.cwd);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  repo.git("switch", "-q", "main");
  return result.json().data as { branch: string; base: string; notes: string[] };
};

const GITFLOW = { branchPolicy: { preset: "gitflow" } };

test("Given git-flow (configured), When a kind branches with no --base, Then feature, bugfix and release start from develop and hotfix from main", async () => {
  const repo = flowRepo(GITFLOW);
  const develop = repo.git("rev-parse", "develop");
  const mainSha = repo.git("rev-parse", "main");
  for (const [kind, base] of [
    ["feature", "develop"],
    ["bugfix", "develop"],
    ["release", "develop"],
    ["hotfix", "main"],
  ]) {
    const data = await baseOf(repo, ["--kind", kind, "--slug", `s-${kind}`]);
    expect(data, kind).toMatchObject({ branch: `${kind}/s-${kind}`, base });
    expect(repo.git("rev-parse", `${kind}/s-${kind}`)).toBe(base === "develop" ? develop : mainSha);
  }
  // A positional name routes by its prefix, and release/hotfix say where they land.
  const release = await baseOf(repo, ["release/4.1.0"]);
  expect(release.base).toBe("develop");
  expect(release.notes.join("\n")).toContain(
    "release/* lands on main (workit pr create targets it), then main merges back into develop",
  );
});

test("Given git-flow detected from develop + main (no policy configured), When feature branches with no --base, Then the base is develop, never main", async () => {
  const repo = flowRepo({});
  expect((await baseOf(repo, ["--kind", "feature", "--slug", "x"])).base).toBe("develop");
  // A global vcs.json default of main does not make main the integration branch.
  writeFileSync(path.join(configDir, "vcs.json"), JSON.stringify({ defaultTargetBranch: "main" }));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify(GITFLOW));
  expect((await baseOf(repo, ["--kind", "bugfix", "--slug", "y"])).base).toBe("develop");
  expect((await baseOf(repo, ["--kind", "hotfix", "--slug", "z"])).base).toBe("main");
});

test("Given git-flow, When --base names the other long-lived branch, Then it is refused with the route (a feature from main, a hotfix from develop)", async () => {
  const repo = flowRepo(GITFLOW);
  const feature = await run(
    ["git", "branch", "--kind", "feature", "--slug", "x", "--base", "main", "--json"],
    repo.cwd,
  );
  expect(feature.code).toBe(3);
  expect(feature.json().error).toBe(
    "gitflow_base: git-flow starts feature/* from develop, not main",
  );
  expect(feature.json().unblock).toContain("without --base it starts from develop");
  const hotfix = await run(["git", "branch", "hotfix/y", "--base", "origin/develop"], repo.cwd);
  expect(hotfix.code).toBe(3);
  expect(hotfix.stderr).toContain("git-flow starts hotfix/* from main, not develop");
  expect(repo.git("branch", "--list", "feature/*", "hotfix/*")).toBe("");
  // A stack parent (an unprotected local branch) stays a valid base.
  await baseOf(repo, ["feature/parent"]);
  expect((await baseOf(repo, ["feature/child", "--base", "feature/parent"])).base).toBe(
    "feature/parent",
  );
  // The workspace may name its integration branch.
  repo.git("push", "-q", "origin", "develop:refs/heads/dev");
  workspace(repo, { branchPolicy: { preset: "gitflow", developBranch: "dev" } });
  expect((await baseOf(repo, ["--kind", "release", "--slug", "5.0.0"])).base).toBe("dev");
});

test("Given github-flow, When any kind branches with no --base, Then it starts from main", async () => {
  const repo = flowRepo({ branchPolicy: { preset: "github-flow" } });
  for (const kind of ["feature", "bugfix", "release", "hotfix"])
    expect((await baseOf(repo, ["--kind", kind, "--slug", kind])).base, kind).toBe("main");
  // No git-flow route, so --base main is fine for a feature.
  expect((await baseOf(repo, ["feature/m", "--base", "main"])).base).toBe("main");
});

test("Given a custom preset, When kinds branch, Then the default target is the base and an off-policy kind names the allowed ones", async () => {
  const repo = flowRepo({
    branchPolicy: { preset: "custom", allowed: ["feature/*", "release/*"], protected: ["main"] },
  });
  expect((await baseOf(repo, ["--kind", "release", "--slug", "1.0.0"])).base).toBe("develop");
  const hotfix = await run(["git", "branch", "--kind", "hotfix", "--slug", "x"], repo.cwd);
  expect(hotfix.code).toBe(3);
  expect(hotfix.stderr).toContain("the allowed kinds are feature/, release/");
  const chore = await run(["git", "branch", "chore/deps"], repo.cwd);
  expect(chore.stderr).toContain('use "feature/deps"');
});

// ---------------------------------------------------------------------------
// push --release

/** Finish a release locally: merge it into main and tag main. */
const finishRelease = (repo: RemoteRepo, tag = "v1.0.0") => {
  repo.git("switch", "-q", "-c", "release/1.0.0", "develop");
  repo.git("switch", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "-m", "chore: release 1.0.0", "release/1.0.0");
  repo.git("tag", "-a", tag, "-m", tag);
  return repo.git("rev-parse", "HEAD");
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test("Given a finished git-flow release and no release grant, When pushed, Then plain push names --release and --release is refused naming the grant", async () => {
  const repo = flowRepo(GITFLOW);
  finishRelease(repo);
  const before = repo.remoteTip("main");
  const plain = await run(["git", "push", "--json"], repo.cwd);
  expect(plain.code).toBe(3);
  expect(plain.json().unblock).toContain("workit git push --release main");
  const refused = await run(["git", "push", "--release", "main", "v1.0.0", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json()).toMatchObject({ code: "blocked", data: { reason: "grant_required" } });
  expect(refused.json().error).toContain("release is not granted");
  expect(refused.json().unblock).toContain("release=true");
  expect(repo.remoteTip("main")).toBe(before);
});

test("Given the release grant, When main, develop and the v tag are pushed with --release, Then they land fast-forward, are verified and recorded", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  const head = finishRelease(repo);
  repo.git("switch", "-q", "develop");
  repo.git("merge", "-q", "--no-ff", "-m", "chore: back-merge 1.0.0", "main");
  const developHead = repo.git("rev-parse", "HEAD");
  repo.git("switch", "-q", "main");
  const pushed = await run(
    ["git", "push", "--release", "main", "develop", "v1.0.0", "--json"],
    repo.cwd,
  );
  expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
  expect(pushed.json().data.refs).toMatchObject([
    { kind: "branch", name: "main", sha: head, pushed: true },
    { kind: "branch", name: "develop", sha: developHead, pushed: true },
    { kind: "tag", name: "v1.0.0", ref: "refs/tags/v1.0.0", sha: head, pushed: true },
  ]);
  expect(repo.remoteTip("main")).toBe(head);
  expect(repo.remoteTip("develop")).toBe(developHead);
  const row = rows(repo.cwd, "release.pushed").at(-1);
  expect(row).toMatchObject({ observer: "workit_cli", grant: "autonomy", remote: "origin" });
  expect(row?.refs).toHaveLength(3);
  // Again: nothing moves, still verified.
  const again = await run(["git", "push", "--release"], repo.cwd);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("is already at");
});

test("Given the release grant, When --release names a feature branch, a non-v tag, a moved tag or a rewritten main, Then each is refused and nothing moves", async () => {
  const repo = flowRepo(GITFLOW);
  workspace(repo, { autonomy: { release: true } });
  finishRelease(repo);
  repo.git("branch", "feature/a");
  const feature = await run(["git", "push", "--release", "feature/a", "--json"], repo.cwd);
  expect(feature.code).toBe(3);
  expect(feature.json().error).toContain(
    "release_push_refused: feature/a is not a git-flow release branch (main, develop)",
  );
  repo.git("tag", "build-7");
  const tag = await run(["git", "push", "--release", "build-7", "--json"], repo.cwd);
  expect(tag.json().error).toContain("is not a release tag");
  // Someone else moved origin/main: a release push never rewrites it.
  repo.pushFromElsewhere("main");
  const behind = await run(["git", "push", "--release", "main", "--json"], repo.cwd);
  expect(behind.code).toBe(1);
  expect(behind.json().error).toContain("non_fast_forward");
  // A tag that exists remotely at another commit never moves.
  repo.git("push", "-q", "origin", "develop:refs/tags/v2.0.0");
  repo.git("tag", "v2.0.0", "main");
  const moved = await run(["git", "push", "--release", "v2.0.0", "--json"], repo.cwd);
  expect(moved.code).toBe(3);
  expect(moved.json().error).toContain("tag_exists");
  expect(rows(repo.cwd, "release.pushed")).toEqual([]);
});

test("Given github-flow, When --release names main, Then it is refused: only git-flow has release branches", async () => {
  const repo = flowRepo({ branchPolicy: { preset: "github-flow" } });
  workspace(repo, { autonomy: { release: true } });
  const refused = await run(["git", "push", "--release", "main", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("the workspace branch policy is not git-flow");
  // A v tag still pushes under the grant.
  repo.git("tag", "v0.1.0");
  const tag = await run(["git", "push", "--release", "v0.1.0", "--json"], repo.cwd);
  expect(tag.code, tag.stdout + tag.stderr).toBe(0);
  const usage = await run(["git", "push", "--release", "--set-upstream"], repo.cwd);
  expect(usage.code).toBe(2);
});
