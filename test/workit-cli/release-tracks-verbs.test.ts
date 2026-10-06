import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { isProtectedTarget } from "@/packages/workit-core/src/core/branch";
import { vcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// Release tracks end to end against real git: the ri-web shape, two release
// lines in one repository (nun-develop -> nun-master, develop -> master) with
// the workspace default pointing at the nun line. Every "standard"
// expectation fails if runtime ignored the tracks and used that default.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-tracks-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  for (const name of ["workspaces.json", "config.json"])
    rmSync(path.join(configDir, name), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const TRACKS = {
  nun: {
    strategy: "gitflow",
    productionBranch: "nun-master",
    integrationBranch: "nun-develop",
    naming: {
      feature: "feature/{name}",
      release: "release/nun-{version}",
      hotfix: "hotfix/nun-{name}",
    },
    baseBranch: "nun-develop",
    mergeBackBranches: ["nun-develop"],
    pullRequestTarget: "nun-develop",
    tagNamespace: "nun/",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
  standard: {
    strategy: "gitflow",
    productionBranch: "master",
    integrationBranch: "develop",
    naming: { feature: "feature/{name}", release: "release/{version}", hotfix: "hotfix/{name}" },
    baseBranch: "develop",
    mergeBackBranches: ["develop"],
    pullRequestTarget: "develop",
    tagNamespace: "",
    versionSource: { kind: "git-tag" },
    requiredChecks: [],
  },
};

/** main -> master; develop = master + 1; nun-master = master; nun-develop = nun-master + 2. */
const setup = (releaseTracks: unknown = TRACKS): RemoteRepo => {
  // null: no releaseTracks key at all.
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({}));
  const repo = makeRemoteRepo();
  repos.push(repo);
  const commit = (file: string) => {
    repo.write(file, `${file}\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", `chore: ${file}`);
  };
  repo.git("switch", "-q", "-c", "master");
  repo.git("switch", "-q", "-c", "develop");
  commit("develop-1.txt");
  repo.git("switch", "-q", "-c", "nun-master", "master");
  repo.git("switch", "-q", "-c", "nun-develop");
  commit("nun-1.txt");
  commit("nun-2.txt");
  repo.git("push", "-q", "origin", "master", "develop", "nun-master", "nun-develop");
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "ri-web",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          vcs: { provider: "github", defaultTargetBranch: "nun-develop" },
          branchPolicy: {
            preset: "gitflow",
            developBranch: "nun-develop",
            allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
            protected: ["main"],
            integration: "pr",
          },
          ...(releaseTracks === null ? {} : { releaseTracks }),
        },
      ],
    }),
  );
  return repo;
};

/** A work branch cut from a sha (reflog "Created from <sha>"), so only ancestry can tell. */
const workBranchFrom = (repo: RemoteRepo, name: string, from: string) => {
  repo.git("switch", "-q", "-c", name, repo.git("rev-parse", from));
  repo.write(`${name.replaceAll("/", "-")}.txt`, "work\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `feat: ${name}`);
};

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

test("given two tracks, when a work branch derives from develop, then the PR target is develop (not the nun default)", () => {
  const repo = setup();
  workBranchFrom(repo, "feature/std", "develop");
  const resolved = vcsConfig("resolve", repo.cwd);
  expect(resolved.ok).toBe(true);
  expect(resolved.defaultTargetBranch).toBe("develop");
  expect(resolved.releaseTrack).toMatchObject({
    name: "standard",
    source: "ancestry",
    warnings: [],
  });
});

test("given two tracks, when a work branch derives from nun-develop, then the PR target is nun-develop", () => {
  const repo = setup();
  workBranchFrom(repo, "feature/nun", "nun-develop");
  const resolved = vcsConfig("resolve", repo.cwd);
  expect(resolved.defaultTargetBranch).toBe("nun-develop");
  expect(resolved.releaseTrack).toMatchObject({ name: "nun", source: "ancestry" });
});

test("given no tracks, then the workspace default is unchanged and no track is reported", () => {
  const repo = setup(null);
  workBranchFrom(repo, "feature/std", "develop");
  const resolved = vcsConfig("resolve", repo.cwd);
  expect(resolved.defaultTargetBranch).toBe("nun-develop");
  expect(resolved.releaseTrack).toBeNull();
  expect(isProtectedTarget(repo.cwd, "nun-master")).toBe(false);
});

test("git branch: on develop, a new branch starts from origin/develop and records its base", async () => {
  const repo = setup();
  repo.git("switch", "-q", "develop");
  const result = await run(
    ["git", "branch", "--kind", "feature", "--slug", "login", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    branch: "feature/login",
    base: "develop",
    baseRef: "refs/remotes/origin/develop",
    releaseTrack: { name: "standard", source: "branch" },
  });
  expect(repo.git("config", "--get", "branch.feature/login.workitBase")).toBe("develop");
  // The recorded base now decides the track for the new branch, before any commit.
  expect(vcsConfig("resolve", repo.cwd).releaseTrack).toMatchObject({
    name: "standard",
    source: "recorded-base",
  });
});

test("git branch --track nun names the branch with the nun template and bases it on nun-develop", async () => {
  const repo = setup();
  repo.git("switch", "-q", "develop");
  const result = await run(
    ["git", "branch", "--kind", "hotfix", "--slug", "crash", "--track", "nun", "--json"],
    repo.cwd,
  );
  expect(result.code).toBe(0);
  expect(result.json().data).toMatchObject({
    branch: "hotfix/nun-crash",
    base: "nun-develop",
    releaseTrack: { name: "nun", source: "flag" },
  });
});

test("git branch --track with an unknown track is refused before anything is created", async () => {
  const repo = setup();
  repo.git("switch", "-q", "develop");
  const result = await run(["git", "branch", "feature/a", "--track", "bogus", "--json"], repo.cwd);
  expect(result.code).toBe(3);
  expect(result.json().error).toContain('no release track "bogus"');
  expect(repo.git("branch", "--list", "feature/a")).toBe("");
});

test("the branch policy protects every track's branches (union with the explicit list)", async () => {
  const repo = setup();
  for (const name of ["master", "develop", "nun-master", "nun-develop", "main"])
    expect(isProtectedTarget(repo.cwd, name)).toBe(true);
  repo.git("switch", "-q", "develop");
  const blocked = await run(
    ["git", "branch", "nun-master", "--base", "develop", "--json"],
    repo.cwd,
  );
  expect(blocked.code).toBe(3);
  expect(blocked.json().error).toContain("protected_ref");
});

test("an ambiguous branch falls back to the workspace default and says so", async () => {
  const repo = setup();
  // Cut from master: develop and nun-develop are both strictly ahead of it by
  // different amounts, but neither contains the work, so ahead ties at 1; the
  // behind count still separates them (develop 1 < nun-develop 2).
  workBranchFrom(repo, "feature/old", "master");
  expect(vcsConfig("resolve", repo.cwd).releaseTrack).toMatchObject({
    name: "standard",
    source: "ancestry",
  });
  // Make both lines equally far: one more commit on develop.
  repo.git("switch", "-q", "develop");
  repo.write("develop-2.txt", "2\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: develop-2");
  repo.git("push", "-q", "origin", "develop");
  repo.git("switch", "-q", "feature/old");
  const resolved = vcsConfig("resolve", repo.cwd);
  expect(resolved.defaultTargetBranch).toBe("nun-develop");
  expect(resolved.releaseTrack).toMatchObject({ name: "nun", source: "default" });
  expect(resolved.releaseTrack.warnings.join("\n")).toContain("equally close");
});

test("grant show and doctor display the configured tracks and the one this checkout resolves to", async () => {
  const repo = setup();
  workBranchFrom(repo, "feature/std", "develop");
  const shown = await run(["grant", "show"], repo.cwd);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain(
    "release tracks: nun (nun-develop -> nun-master), standard (develop -> master)",
  );
  expect(shown.stdout).toContain("this checkout: standard");
  const shownJson = await run(["grant", "show", "--json"], repo.cwd);
  expect(shownJson.json().data.releaseTracks).toMatchObject({
    resolved: { name: "standard", source: "ancestry" },
  });
  const doctor = await run(["doctor", "--json"], repo.cwd);
  const check = JSON.parse(doctor.stdout).checks.find(
    (item: { id: string }) => item.id === "workspace_mismatch",
  );
  expect(check).toMatchObject({ status: "pass" });
  expect(check.detail).toContain("standard");
});
