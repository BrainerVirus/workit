import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Release packages (#860): several packages released from one git-flow
// repository's own release line, each under its own tag namespace
// (`pkg-a@0.1.0` beside the bare `1.0.0`), on the main release commit.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-release-packages-");
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
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          autonomy: { release: true },
          ...entry,
        },
      ],
    }),
  );

// The main changelog at the root, one per package under projects/<name>/.
const PACKAGES = {
  changelogPath: ["CHANGELOG.md", "projects/*/CHANGELOG.md"],
  releasePackages: { "pkg-a": {} },
};

/** git-flow with bare version tags: main plus a develop one commit ahead, both on origin. */
const flowRepo = (): RemoteRepo => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("config", "gitflow.prefix.versiontag", "");
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  return repo;
};

const changelog = (version: string, line: string) =>
  `# Changelog\n\n## [${version}] - 2026-11-13\n\n### Added\n\n- ${line}\n\n## [0.0.1] - 2026-01-01\n\n- older\n`;

/** release/1.0.0 started, bumped (the main changelog and pkg-a's dated), and finished. */
const finished = async (repo: RemoteRepo): Promise<string> => {
  const started = await run(["release", "start", "1.0.0"], repo.cwd);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  repo.write("CHANGELOG.md", changelog("1.0.0", "the main widget"));
  repo.write("projects/pkg-a/CHANGELOG.md", changelog("0.1.0", "the pkg-a gadget"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore(release): 1.0.0");
  const done = await run(["release", "finish", "--json"], repo.cwd);
  expect(done.code, done.stdout + done.stderr).toBe(0);
  return repo.git("rev-parse", "1.0.0^{commit}");
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const remoteTag = (repo: RemoteRepo, tag: string) =>
  repo.git("ls-remote", "origin", `refs/tags/${tag}^{}`).split("\t")[0] || null;

test("Given releasePackages {pkg-a} and a finished 1.0.0, When workit git push --release pkg-a@0.1.0 runs for an annotated tag on the release commit, Then it pushes, verifies and records release.pushed; an unconfigured pkg-z@0.1.0 is refused naming every accepted shape", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  const release = await finished(repo);
  repo.git("tag", "-a", "pkg-a@0.1.0", release, "-m", "pkg-a 0.1.0");
  const pushed = await run(["git", "push", "--release", "pkg-a@0.1.0", "--json"], repo.cwd);
  expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
  expect(remoteTag(repo, "pkg-a@0.1.0")).toBe(release);
  expect(rows(repo.cwd, "release.pushed").at(-1)).toMatchObject({
    refs: [expect.objectContaining({ ref: "refs/tags/pkg-a@0.1.0", sha: expect.any(String) })],
  });
  repo.git("tag", "-a", "pkg-z@0.1.0", release, "-m", "pkg-z 0.1.0");
  const refused = await run(["git", "push", "--release", "pkg-z@0.1.0", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain(
    "release_push_refused: tag pkg-z@0.1.0 is not a release tag (<version>, pkg-a@<version>)",
  );
  expect(remoteTag(repo, "pkg-z@0.1.0")).toBeNull();
});

test("Given a package tag on a commit that is not on production, When it is pushed with --release, Then it is refused as tag_unreleased like a workspace release tag", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  await finished(repo);
  repo.write("unreleased.txt", "x\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat: unreleased");
  repo.git("tag", "-a", "pkg-a@0.2.0", "-m", "pkg-a 0.2.0");
  const refused = await run(["git", "push", "--release", "pkg-a@0.2.0", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("tag_unreleased: pkg-a@0.2.0");
  expect(remoteTag(repo, "pkg-a@0.2.0")).toBeNull();
});

test("Given changelogPath projects/*/CHANGELOG.md with three changelogs and only projects/main has 4.6.0, When release notes draft 4.6.0 runs, Then the draft holds that section", async () => {
  const repo = flowRepo();
  workspace(repo, { changelogPath: "projects/*/CHANGELOG.md" });
  repo.write("projects/main/CHANGELOG.md", changelog("4.6.0", "the main widget"));
  repo.write("projects/pkg-a/CHANGELOG.md", changelog("0.1.0", "the pkg-a gadget"));
  repo.write("projects/pkg-b/CHANGELOG.md", changelog("0.2.0", "the pkg-b gizmo"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: changelogs");
  const drafted = await run(["release", "notes", "draft", "4.6.0", "--json"], repo.cwd);
  expect(drafted.code, drafted.stdout + drafted.stderr).toBe(0);
  const { path: file, notes } = drafted.json().data;
  expect(notes).toContain("the main widget");
  expect(notes).not.toContain("gadget");
  expect(readFileSync(file, "utf8")).toBe(notes);
});

test("Given releasePackages {pkg-b: {changelogPath}}, When release notes draft pkg-b@0.1.0 runs, Then the draft holds pkg-b's 0.1.0 section at a path distinct from the 0.1.0 main-version draft; --package reads the same draft", async () => {
  const repo = flowRepo();
  workspace(repo, {
    changelogPath: "CHANGELOG.md",
    releasePackages: { "pkg-b": { changelogPath: "projects/pkg-b/CHANGELOG.md" } },
  });
  repo.write("CHANGELOG.md", changelog("0.1.0", "the main widget"));
  repo.write("projects/pkg-b/CHANGELOG.md", changelog("0.1.0", "the pkg-b gizmo"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: changelogs");
  const pkg = await run(["release", "notes", "draft", "pkg-b@0.1.0", "--json"], repo.cwd);
  expect(pkg.code, pkg.stdout + pkg.stderr).toBe(0);
  expect(pkg.json().data).toMatchObject({ tag: "pkg-b@0.1.0", package: "pkg-b" });
  expect(pkg.json().data.notes).toContain("the pkg-b gizmo");
  expect(pkg.json().data.notes).not.toContain("the main widget");
  const mainDraft = await run(["release", "notes", "draft", "0.1.0", "--json"], repo.cwd);
  expect(mainDraft.code, mainDraft.stdout + mainDraft.stderr).toBe(0);
  expect(mainDraft.json().data.notes).toContain("the main widget");
  expect(mainDraft.json().data.path).not.toBe(pkg.json().data.path);
  // The main draft did not overwrite the package's.
  expect(readFileSync(pkg.json().data.path, "utf8")).toContain("the pkg-b gizmo");
  const shown = await run(
    ["release", "notes", "show", "0.1.0", "--package", "pkg-b", "--json"],
    repo.cwd,
  );
  expect(shown.code, shown.stdout + shown.stderr).toBe(0);
  expect(shown.json().data.path).toBe(pkg.json().data.path);
  const unknown = await run(["release", "notes", "draft", "pkg-z@0.1.0", "--json"], repo.cwd);
  expect(unknown.code).not.toBe(0);
  expect(unknown.json().error).toContain("pkg-b@<version>");
});

test("Given a finished 1.0.0, When release package pkg-a 0.1.0 --dry-run runs, Then it prints the plan on the 1.0.0 release commit and changes nothing", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  const release = await finished(repo);
  const before = rows(repo.cwd, "release.package_tagged").length;
  const dry = await run(["release", "package", "pkg-a", "0.1.0", "--dry-run", "--json"], repo.cwd);
  expect(dry.code, dry.stdout + dry.stderr).toBe(0);
  expect(dry.json().data).toMatchObject({
    tag: "pkg-a@0.1.0",
    at: "1.0.0",
    target: release,
    latest: false,
  });
  expect(dry.json().data.changelog).toContain("the pkg-a gadget");
  expect(repo.git("tag", "-l", "pkg-a@*")).toBe("");
  expect(remoteTag(repo, "pkg-a@0.1.0")).toBeNull();
  expect(rows(repo.cwd, "release.package_tagged")).toHaveLength(before);
});

test("Given releaseNotes review and no approved draft for pkg-a@0.1.0, When release package runs, Then it refuses before tagging and names the package tag's draft and approve commands", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  await finished(repo);
  workspace(repo, { ...PACKAGES, releaseNotes: "review" });
  const refused = await run(["release", "package", "pkg-a", "0.1.0", "--json"], repo.cwd);
  expect(refused.code).toBe(3);
  expect(refused.json().error).toContain("release_notes_unapproved");
  expect(refused.json().error).toContain("pkg-a@0.1.0 has no draft");
  expect(refused.json().unblock).toContain("workit release notes approve pkg-a@0.1.0");
  expect(repo.git("tag", "-l", "pkg-a@*")).toBe("");
});

test("Given no workspace release tag on the remote production branch, When release package runs without --at, Then it fails naming --at and tags nothing", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  const refused = await run(["release", "package", "pkg-a", "0.1.0", "--json"], repo.cwd);
  expect(refused.code).not.toBe(0);
  expect(refused.json().error).toContain("no workspace release tag (<version>) is on origin/main");
  expect(refused.json().unblock).toContain("--at <ref>");
  expect(repo.git("tag", "-l")).toBe("");
});

test("Given a finished 1.0.0, When release package pkg-a 0.2.0 --at a commit not on production is refused at the push, Then the local tag it made is deleted and a rerun --at 1.0.0 tags and pushes", async () => {
  const repo = flowRepo();
  workspace(repo, PACKAGES);
  const release = await finished(repo);
  repo.write("unreleased.txt", "x\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "feat: unreleased");
  const refused = await run(
    ["release", "package", "pkg-a", "0.2.0", "--at", "HEAD", "--json"],
    repo.cwd,
  );
  expect(refused.code).not.toBe(0);
  expect(refused.json().error).toContain("tag_unreleased");
  expect(refused.json().error).toContain("deleted the local tag pkg-a@0.2.0 this run made");
  expect(refused.json().data).toMatchObject({ step: "push", untagged: "pkg-a@0.2.0" });
  expect(repo.git("tag", "-l", "pkg-a@*")).toBe("");
  expect(remoteTag(repo, "pkg-a@0.2.0")).toBeNull();
  const again = await run(
    ["release", "package", "pkg-a", "0.2.0", "--at", "1.0.0", "--json"],
    repo.cwd,
  );
  expect(again.code, again.stdout + again.stderr).toBe(0);
  expect(remoteTag(repo, "pkg-a@0.2.0")).toBe(release);
});

test("Given workspace w, When workspace set writes releasePackages.pkg-a.changelogPath, Then workspaces.json holds it and grant show lists pkg-a's tag shape and changelog; a bad namespace is refused with the reader's message and unset removes the package", async () => {
  const repo = flowRepo();
  workspace(repo, {});
  const file = path.join(configDir, "workspaces.json");
  const set = await run(
    [
      "workspace",
      "set",
      "w",
      "releasePackages.pkg-a.changelogPath=projects/pkg-a/CHANGELOG.md",
      "--json",
    ],
    repo.cwd,
  );
  expect(set.code, set.stdout + set.stderr).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).workspaces[0].releasePackages).toEqual({
    "pkg-a": { changelogPath: "projects/pkg-a/CHANGELOG.md" },
  });
  const shown = await run(["grant", "show", "--json"], repo.cwd);
  expect(shown.code, shown.stdout + shown.stderr).toBe(0);
  expect(shown.json().data.releasePackages.packages).toEqual([
    { name: "pkg-a", tagShape: "pkg-a@<version>", changelogPath: "projects/pkg-a/CHANGELOG.md" },
  ]);
  const text = await run(["grant", "show"], repo.cwd);
  expect(text.stdout).toContain(
    "release packages: pkg-a (pkg-a@<version>; changelog projects/pkg-a/CHANGELOG.md)",
  );

  const bad = await run(
    ["workspace", "set", "w", "releasePackages.pkg-a.tagNamespace=9x", "--json"],
    repo.cwd,
  );
  expect(bad.code).not.toBe(0);
  expect(bad.json().error).toContain('release package "pkg-a" tagNamespace "9x": not a tag prefix');
  expect(JSON.parse(readFileSync(file, "utf8")).workspaces[0].releasePackages["pkg-a"]).toEqual({
    changelogPath: "projects/pkg-a/CHANGELOG.md",
  });

  const unset = await run(
    ["workspace", "set", "w", "releasePackages.pkg-a=null", "--json"],
    repo.cwd,
  );
  expect(unset.code, unset.stdout + unset.stderr).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).workspaces[0].releasePackages).toEqual({});
});

// ---------------------------------------------------------------------------
// forge releases (replayed gh)

const ENCODED = "pkg-a%400.1.0";

/** gh replayed: no release for the package tag yet; each POST body kept. */
const github = (repo: RemoteRepo) => {
  sshForgeRemote(repo, "git@github.com:o/r.git");
  const posts: Array<Record<string, unknown>> = [];
  const replay = replayRunner({
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "GET repos/o/r/releases/tags/1.0.0": () => replyError("gh: Not Found (HTTP 404)"),
    [`GET repos/o/r/releases/tags/${ENCODED}`]: () => replyError("gh: Not Found (HTTP 404)"),
    "GET repos/o/r/releases/tags/pkg-a%400.1.1": () => replyError("gh: Not Found (HTTP 404)"),
    "POST repos/o/r/releases": JSON.stringify({
      tag_name: "pkg-a@0.1.0",
      html_url: "https://github.com/o/r/releases/tag/pkg-a@0.1.0",
    }),
  } satisfies Record<string, Reply>);
  const runner = Object.assign(
    (...args: Parameters<typeof replay>) => {
      if (args[2].input) posts.push(JSON.parse(args[2].input) as Record<string, unknown>);
      return replay(...args);
    },
    { calls: replay.calls },
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return posts;
};

const forgeWorkspace = (repo: RemoteRepo) =>
  workspace(repo, { ...PACKAGES, vcs: { provider: "github", account: "octo" } });

test.skipIf(process.platform === "win32")(
  "Given a GitHub remote and a finished 1.0.0, When release package pkg-a 0.1.0 runs, Then the tag lands on the release commit, is pushed and verified, and the forge release has the package notes and make_latest false; --latest sends true",
  async () => {
    const repo = flowRepo();
    workspace(repo, PACKAGES);
    const release = await finished(repo);
    forgeWorkspace(repo);
    const posts = github(repo);
    const done = await withHome(configHome.home, () =>
      run(["release", "package", "pkg-a", "0.1.0", "--json"], repo.cwd),
    );
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(repo.git("rev-parse", "pkg-a@0.1.0^{commit}")).toBe(release);
    expect(repo.git("cat-file", "-t", "pkg-a@0.1.0")).toBe("tag");
    expect(remoteTag(repo, "pkg-a@0.1.0")).toBe(release);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ tag_name: "pkg-a@0.1.0", make_latest: "false" });
    expect(String(posts[0].body)).toContain("the pkg-a gadget");
    expect(String(posts[0].body)).not.toContain("the main widget");
    expect(rows(repo.cwd, "release.package_tagged").at(-1)).toMatchObject({
      package: "pkg-a",
      tag: "pkg-a@0.1.0",
      head: release,
    });
    expect(rows(repo.cwd, "release.forge_released").at(-1)).toMatchObject({
      package: "pkg-a",
      tag: "pkg-a@0.1.0",
      latest: false,
    });
    expect(rows(repo.cwd, "delivery.verified").at(-1)).toMatchObject({ expect: "released" });
    // The tag exists now: a rerun refuses (a release tag never moves).
    const again = await withHome(configHome.home, () =>
      run(["release", "package", "pkg-a", "0.1.0", "--json"], repo.cwd),
    );
    expect(again.code).toBe(3);
    expect(again.json().error).toContain("tag_exists: pkg-a@0.1.0");

    const latest = await withHome(configHome.home, () =>
      run(["release", "package", "pkg-a", "0.1.1", "--latest", "--json"], repo.cwd),
    );
    expect(latest.code, latest.stdout + latest.stderr).toBe(0);
    expect(posts.at(-1)).toMatchObject({ tag_name: "pkg-a@0.1.1", make_latest: "true" });
  },
);

test.skipIf(process.platform === "win32")(
  "Given a GitHub remote, When workit git push --release pushes a package tag and the workspace tag, Then the package's forge release is not Latest and the workspace's keeps the forge default",
  async () => {
    const repo = flowRepo();
    workspace(repo, PACKAGES);
    const release = await finished(repo);
    forgeWorkspace(repo);
    const posts = github(repo);
    repo.git("tag", "-a", "pkg-a@0.1.0", release, "-m", "pkg-a 0.1.0");
    // 1.0.0 is already on the remote: its push is a no-op, its forge release is created.
    const pushed = await withHome(configHome.home, () =>
      run(["git", "push", "--release", "1.0.0,pkg-a@0.1.0", "--json"], repo.cwd),
    );
    expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
    const byTag = Object.fromEntries(posts.map((post) => [post.tag_name, post]));
    expect(byTag["pkg-a@0.1.0"]).toMatchObject({ make_latest: "false" });
    expect(String(byTag["pkg-a@0.1.0"].body)).toContain("the pkg-a gadget");
    expect(byTag["1.0.0"]).not.toHaveProperty("make_latest");
  },
);
