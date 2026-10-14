import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { fixture, replayRunner, replyError, type Reply } from "@/test/shared/helpers/forge-replay";
import {
  makeRemoteRepo,
  sshForgeRemote,
  withHome,
  type RemoteRepo,
} from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// `workit release start|finish|publish` (#290) against a real checkout whose
// origin is a local bare repository: classic git-flow (the release branch
// stays local, finish merges, tags, merges back and pushes production,
// develop and the tag), per preset and per release track, and the resume
// cases of an interrupted finish.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-release-config-");
  configDir = configHome.configDir;
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  Object.assign(forgeDeps, original);
  for (const name of ["workspaces.json", "config.json", "vcs.json"])
    rmSync(path.join(configDir, name), { force: true });
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

const workspace = (repo: RemoteRepo, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${repo.root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const GRANTED = { autonomy: { release: true } };

/** main plus a develop one commit ahead, both on origin; the checkout on develop. */
const flowRepo = (branchPolicy: Record<string, unknown> = { preset: "gitflow" }): RemoteRepo => {
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ branchPolicy }));
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  return repo;
};

const CHANGELOG = (version: string) =>
  `# Changelog\n\n## [${version}] - 2026-10-14\n\n### Fixed\n\n- the widget\n\n## [0.9.0] - 2026-09-01\n\n- older\n`;

/** The release work: a version bump and a changelog section, committed on the release branch. */
const bump = (repo: RemoteRepo, version: string) => {
  repo.write("VERSION", `${version}\n`);
  repo.write("CHANGELOG.md", CHANGELOG(version));
  repo.git("add", "-A");
  repo.git("commit", "-qm", `chore(release): ${version}`);
  return repo.git("rev-parse", "HEAD");
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const parents = (repo: RemoteRepo, ref: string) =>
  repo.git("rev-list", "--parents", "-n", "1", ref).split(" ").slice(1);

const merges = (repo: RemoteRepo, ref: string) =>
  repo.git("rev-list", "--merges", ref).split("\n").filter(Boolean).length;

const remoteTag = (repo: RemoteRepo, tag: string) =>
  repo.git("ls-remote", "origin", `refs/tags/${tag}^{}`).split("\t")[0] || null;

test("Given git-flow, When release start runs, Then release/<v> starts from develop locally, is never pushed, and a second release is refused", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  const develop = repo.git("rev-parse", "develop");
  const started = await run(["release", "start", "1.0.0", "--json"], repo.cwd);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  expect(started.json().data).toMatchObject({
    branch: "release/1.0.0",
    base: "develop",
    baseSha: develop,
    tag: "v1.0.0",
  });
  expect(repo.git("branch", "--show-current")).toBe("release/1.0.0");
  expect(repo.remoteTip("release/1.0.0")).toBeNull();
  expect(rows(repo.cwd, "release.started").at(-1)).toMatchObject({
    branch: "release/1.0.0",
    version: "1.0.0",
    observer: "workit_cli",
  });
  const again = await run(["release", "start", "1.1.0", "--json"], repo.cwd);
  expect(again.code).toBe(3);
  expect(again.json().error).toContain("release_exists: release/1.0.0");
});

test("Given a local release branch with the bump and changelog, When release finish runs, Then it merges --no-ff into main, tags from the changelog, merges the tag back into develop, deletes the branch and pushes main, develop and the tag, never the release branch", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  await run(["release", "start", "1.0.0"], repo.cwd);
  const tip = bump(repo, "1.0.0");
  const finished = await run(["release", "finish", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  const mainSha = repo.git("rev-parse", "main");
  // main: a real merge of the release tip, tagged with the changelog section.
  expect(parents(repo, "main")).toEqual([expect.any(String), tip]);
  expect(repo.git("rev-parse", "v1.0.0^{commit}")).toBe(mainSha);
  expect(repo.git("cat-file", "-t", "v1.0.0")).toBe("tag");
  expect(repo.git("tag", "-l", "--format=%(contents)", "v1.0.0")).toContain("- the widget");
  expect(repo.git("tag", "-l", "--format=%(contents)", "v1.0.0")).not.toContain("0.9.0");
  // develop: a merge of the tag (git-flow merges back through the tag).
  expect(parents(repo, "develop")[1]).toBe(mainSha);
  expect(repo.git("branch", "--list", "release/*")).toBe("");
  expect(repo.git("branch", "--show-current")).toBe("develop");
  expect(repo.remoteTip("main")).toBe(mainSha);
  expect(repo.remoteTip("develop")).toBe(repo.git("rev-parse", "develop"));
  expect(remoteTag(repo, "v1.0.0")).toBe(mainSha);
  expect(repo.remoteTip("release/1.0.0")).toBeNull();
  for (const type of [
    "release.merged",
    "release.tagged",
    "release.merged_back",
    "release.branch_deleted",
    "release.pushed",
    "release.finished",
  ])
    expect(rows(repo.cwd, type), type).toHaveLength(1);
  expect(rows(repo.cwd, "delivery.verified").at(-1)).toMatchObject({ expect: "released" });
});

test("Given no release grant, When finish runs (or --dry-run), Then it is blocked naming the grant and nothing merges", async () => {
  const repo = flowRepo();
  await run(["release", "start", "1.0.0"], repo.cwd);
  bump(repo, "1.0.0");
  const mainSha = repo.git("rev-parse", "main");
  const dry = await run(["release", "finish", "--dry-run", "--json"], repo.cwd);
  expect(dry.code).toBe(3);
  expect(dry.json().error).toContain("release is not granted");
  expect(dry.json().data.steps.map((step: { done: boolean }) => step.done)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  const refused = await run(["release", "finish", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().unblock).toContain("release=true");
  expect(repo.git("rev-parse", "main")).toBe(mainSha);
  expect(repo.git("tag", "-l")).toBe("");
});

test("Given a finish interrupted after the merge into main (merged, not tagged), When finish runs again, Then it tags and merges back without a second merge into main", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  await run(["release", "start", "1.0.0"], repo.cwd);
  bump(repo, "1.0.0");
  repo.git("switch", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "--no-edit", "release/1.0.0");
  const merged = repo.git("rev-parse", "main");
  const dry = await run(["release", "finish", "1.0.0", "--dry-run", "--json"], repo.cwd);
  expect(dry.json().data.steps[0]).toMatchObject({ done: true });
  const finished = await run(["release", "finish", "1.0.0", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  expect(repo.git("rev-parse", "main")).toBe(merged);
  expect(merges(repo, "main")).toBe(1);
  expect(repo.git("rev-parse", "v1.0.0^{commit}")).toBe(merged);
  expect(remoteTag(repo, "v1.0.0")).toBe(merged);
});

test("Given a finish interrupted at the push (tagged, not pushed), When finish runs again, Then it pushes without re-merging or re-tagging", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  await run(["release", "start", "1.0.0"], repo.cwd);
  bump(repo, "1.0.0");
  // The remote is unreachable for the first attempt.
  repo.git("remote", "set-url", "origin", path.join(repo.root, "missing.git"));
  const first = await run(["release", "finish", "--json"], repo.cwd);
  expect(first.code).not.toBe(0);
  expect(first.json().data).toMatchObject({ step: "push", resume: "workit release finish 1.0.0" });
  repo.git("remote", "set-url", "origin", repo.bare);
  const tagObject = repo.git("rev-parse", "v1.0.0");
  const develop = repo.git("rev-parse", "develop");
  const second = await run(["release", "finish", "1.0.0", "--json"], repo.cwd);
  expect(second.code, second.stdout + second.stderr).toBe(0);
  expect(second.json().data.ran).toEqual([]);
  expect(repo.git("rev-parse", "v1.0.0")).toBe(tagObject);
  expect(repo.git("rev-parse", "develop")).toBe(develop);
  expect(merges(repo, "main")).toBe(1);
  expect(repo.remoteTip("main")).toBe(repo.git("rev-parse", "main"));
  expect(rows(repo.cwd, "release.merged")).toHaveLength(1);
  expect(rows(repo.cwd, "release.tagged")).toHaveLength(1);
});

test("Given git-flow's empty tag prefix, When a release finishes, Then the tag is the bare version and --release accepts it", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  repo.git("config", "gitflow.prefix.versiontag", "");
  await run(["release", "start", "2.0.0"], repo.cwd);
  bump(repo, "2.0.0");
  const finished = await run(["release", "finish", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  expect(finished.json().data.tag).toBe("2.0.0");
  expect(remoteTag(repo, "2.0.0")).toBe(repo.git("rev-parse", "main"));
});

test("Given git-flow, When a hotfix starts and finishes, Then it starts from main and lands on main and develop", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  const mainSha = repo.git("rev-parse", "main");
  const started = await run(["release", "start", "1.0.1", "--hotfix", "--json"], repo.cwd);
  expect(started.json().data).toMatchObject({
    branch: "hotfix/1.0.1",
    base: "main",
    baseSha: mainSha,
  });
  repo.write("fix.txt", "fix\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "fix: the widget");
  const fix = repo.git("rev-parse", "HEAD");
  const finished = await run(["release", "finish", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  expect(parents(repo, "main")).toEqual([mainSha, fix]);
  expect(repo.git("merge-base", "--is-ancestor", fix, "develop")).toBe("");
  expect(remoteTag(repo, "v1.0.1")).toBe(repo.git("rev-parse", "main"));
});

test("Given a published release branch, When it finishes, Then git-flow's remote branch goes too; publish is the only verb that pushed it", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  await run(["release", "start", "1.0.0"], repo.cwd);
  bump(repo, "1.0.0");
  expect(repo.remoteTip("release/1.0.0")).toBeNull();
  const published = await run(["release", "publish", "--json"], repo.cwd);
  expect(published.code, published.stdout + published.stderr).toBe(0);
  expect(repo.remoteTip("release/1.0.0")).toBe(repo.git("rev-parse", "release/1.0.0"));
  expect(rows(repo.cwd, "release.published")).toHaveLength(1);
  const finished = await run(["release", "finish", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  expect(repo.remoteTip("release/1.0.0")).toBeNull();
});

test("Given local main behind origin/main, When finish runs, Then it is refused before any merge", async () => {
  const repo = flowRepo();
  workspace(repo, GRANTED);
  await run(["release", "start", "1.0.0"], repo.cwd);
  bump(repo, "1.0.0");
  repo.pushFromElsewhere("main");
  const refused = await run(["release", "finish", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("branch_behind: local main");
  expect(repo.git("tag", "-l")).toBe("");
});

// ---------------------------------------------------------------------------
// release tracks: the ri-web shape (nun-develop -> nun-master beside develop -> master)

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
    mergeBackBranches: ["nun-develop"],
    tagNamespace: "nun/",
  },
  standard: {
    strategy: "gitflow",
    productionBranch: "master",
    integrationBranch: "develop",
    mergeBackBranches: ["develop"],
    tagNamespace: "",
  },
};

test("Given release tracks, When a nun release starts and finishes, Then it uses nun-develop, lands on nun-master as nun/v1.0.0, merges back into nun-develop and leaves master and develop alone", async () => {
  const repo = flowRepo();
  repo.git("switch", "-q", "-c", "master", "main");
  repo.git("switch", "-q", "-c", "nun-master", "main");
  repo.git("switch", "-q", "-c", "nun-develop");
  repo.write("nun.txt", "nun\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: nun");
  repo.git("push", "-q", "origin", "master", "nun-master", "nun-develop");
  workspace(repo, {
    ...GRANTED,
    vcs: { provider: "github", defaultTargetBranch: "nun-develop" },
    branchPolicy: { preset: "gitflow", developBranch: "nun-develop", protected: ["main"] },
    releaseTracks: TRACKS,
  });
  const master = repo.git("rev-parse", "master");
  const develop = repo.git("rev-parse", "develop");
  const started = await run(["release", "start", "1.0.0", "--track", "nun", "--json"], repo.cwd);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  expect(started.json().data).toMatchObject({
    branch: "release/nun-1.0.0",
    base: "nun-develop",
    tag: "nun/v1.0.0",
    track: "nun",
  });
  bump(repo, "1.0.0");
  const finished = await run(["release", "finish", "--json"], repo.cwd);
  expect(finished.code, finished.stdout + finished.stderr).toBe(0);
  const nunMaster = repo.git("rev-parse", "nun-master");
  expect(remoteTag(repo, "nun/v1.0.0")).toBe(nunMaster);
  expect(repo.remoteTip("nun-master")).toBe(nunMaster);
  expect(parents(repo, "nun-develop")[1]).toBe(nunMaster);
  expect(repo.remoteTip("nun-develop")).toBe(repo.git("rev-parse", "nun-develop"));
  expect(repo.git("rev-parse", "master")).toBe(master);
  expect(repo.git("rev-parse", "develop")).toBe(develop);
  expect(repo.remoteTip("release/nun-1.0.0")).toBeNull();
});

// ---------------------------------------------------------------------------
// forge releases (replayed gh) and the release PR outside git-flow

const forgeRoutes = (extra: Record<string, Reply>): Record<string, Reply> => ({
  "GET user": fixture("github/user.json"),
  "GET repos/o/r": fixture("github/repo.json"),
  "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
  ...extra,
});

const forgeRepo = (branchPolicy?: Record<string, unknown>) => {
  const repo = flowRepo(branchPolicy);
  sshForgeRemote(repo, "git@github.com:o/r.git");
  workspace(repo, { ...GRANTED, vcs: { provider: "github", account: "octo" } });
  return repo;
};

test.skipIf(process.platform === "win32")(
  "Given a GitHub remote, When finish is interrupted before the forge release (pushed, no release), Then the rerun creates it once, and a later rerun finds it instead of duplicating it",
  async () => {
    const repo = forgeRepo();
    await run(["release", "start", "1.0.0"], repo.cwd);
    bump(repo, "1.0.0");
    let created = false;
    let failNext = true;
    const runner = replayRunner(
      forgeRoutes({
        "GET repos/o/r/releases/tags/v1.0.0": () =>
          created
            ? JSON.stringify({
                tag_name: "v1.0.0",
                html_url: "https://github.com/o/r/releases/tag/v1.0.0",
              })
            : replyError("gh: Not Found (HTTP 404)"),
        "POST repos/o/r/releases": () => {
          if (failNext) {
            failNext = false;
            return replyError("gh: Server Error (HTTP 502)");
          }
          created = true;
          return JSON.stringify({
            tag_name: "v1.0.0",
            html_url: "https://github.com/o/r/releases/tag/v1.0.0",
          });
        },
      }),
    );
    Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
    const first = await withHome(configHome.home, () =>
      run(["release", "finish", "--json"], repo.cwd),
    );
    expect(first.code).not.toBe(0);
    expect(first.json().data).toMatchObject({ step: "forge-release" });
    expect(remoteTag(repo, "v1.0.0")).toBe(repo.git("rev-parse", "main"));
    const second = await withHome(configHome.home, () =>
      run(["release", "finish", "1.0.0", "--json"], repo.cwd),
    );
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.json().data.forgeRelease).toMatchObject({ created: true });
    const posts = () => runner.calls.filter((call) => call.method === "POST").length;
    expect(posts()).toBe(2);
    const body = runner.calls.find((call) => call.method === "POST");
    expect(body?.endpoint).toBe("repos/o/r/releases");
    expect(rows(repo.cwd, "release.forge_released")).toHaveLength(1);
    expect(rows(repo.cwd, "release.finished")).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "Given github-flow, When release finish runs, Then it pushes the release branch and opens a release PR into main instead of moving the trunk",
  async () => {
    const repo = forgeRepo({ preset: "github-flow" });
    await run(["release", "start", "1.0.0"], repo.cwd);
    const tip = bump(repo, "1.0.0");
    const mainSha = repo.git("rev-parse", "main");
    const runner = replayRunner(
      forgeRoutes({
        "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
        "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
        "graphql find": fixture("github/find-none.json"),
        "POST repos/o/r/pulls": JSON.stringify({
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          state: "open",
          head: { ref: "release/1.0.0", sha: tip },
        }),
      }),
    );
    Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
    const finished = await withHome(configHome.home, () =>
      run(["release", "finish", "--json"], repo.cwd),
    );
    expect(finished.code, finished.stdout + finished.stderr).toBe(0);
    const pr = runner.calls.find(
      (call) => call.method === "POST" && call.endpoint === "repos/o/r/pulls",
    );
    expect(pr?.vars).toMatchObject({
      base: "main",
      head: "release/1.0.0",
      title: "chore(release): 1.0.0",
    });
    expect(repo.remoteTip("main")).toBe(mainSha);
    expect(repo.git("tag", "-l")).toBe("");
    expect(rows(repo.cwd, "release.pr_opened")).toHaveLength(1);
  },
);
