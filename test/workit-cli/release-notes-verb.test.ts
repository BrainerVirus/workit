import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { runRelease } from "@/packages/workit-cli/src/verbs/release";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { fixture, replayRunner, replyError, type Reply } from "@/test/shared/helpers/forge-replay";
import {
  makeRemoteRepo,
  sshForgeRemote,
  withHome,
  type RemoteRepo,
} from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// Release notes on `workit release finish` (workspace or release track
// `releaseNotes`: auto by default, off, review) and `workit release notes
// draft|show|approve`, against a real git-flow checkout whose origin is a
// local bare repository and a replayed gh.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-release-notes-config-");
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

const AGENT_VARS = new Set([
  "CLAUDECODE",
  "OPENCODE",
  "CURSOR_AGENT",
  "PI_CODING_AGENT",
  "AI_AGENT",
  "AGENT",
]);
/** The user's own terminal: no agent marker in the environment. */
const userEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !AGENT_VARS.has(name) && !name.startsWith("CODEX_"),
    ),
  ),
  WORKIT_SESSION_ID: "user-1",
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

/** `workit release notes approve` with a chosen terminal, environment and typed answer. */
const approve = async (
  cwd: string,
  version: string,
  options: { interactive: boolean; env: NodeJS.ProcessEnv; answer?: string },
) => {
  let stdout = "";
  const io: Io = {
    json: true,
    cwd,
    env: options.env,
    stdout: (text) => void (stdout += text),
    stderr: () => {},
  };
  const code = await runRelease(["notes", "approve", version], io, {
    interactive: () => options.interactive,
    ask: async () => options.answer ?? version,
  });
  return { code, json: () => JSON.parse(stdout) };
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
          vcs: { provider: "github", account: "octo" },
          ...entry,
        },
      ],
    }),
  );

/** main tagged v0.9.0, develop one commit ahead, both on origin; the push URL a forge's. */
const forgeRepo = (url = "git@github.com:o/r.git"): RemoteRepo => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("tag", "v0.9.0", "main");
  repo.git("switch", "-q", "-c", "develop");
  repo.write("develop.txt", "develop\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: develop");
  repo.git("push", "-q", "origin", "develop");
  sshForgeRemote(repo, url);
  return repo;
};

const SECTION = "### Removed\n\n- the old flag\n\n### Fixed\n\n- the widget";

/** release/<v> started, with the bump and its changelog section committed. */
const started = async (repo: RemoteRepo, version = "1.0.0") => {
  await run(["release", "start", version], repo.cwd);
  repo.write("VERSION", `${version}\n`);
  repo.write(
    "CHANGELOG.md",
    `# Changelog\n\n## [${version}] - 2026-10-14\n\n${SECTION}\n\n## [0.9.0] - 2026-09-01\n\n- older\n`,
  );
  repo.git("add", "-A");
  repo.git("commit", "-qm", `chore(release): ${version}`);
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

/** gh replayed: no release yet; each created release's JSON body is kept. */
const forge = (extra: Record<string, Reply> = {}) => {
  const bodies: string[] = [];
  const replay = replayRunner({
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "GET repos/o/r/releases/tags/v1.0.0": () => replyError("gh: Not Found (HTTP 404)"),
    "POST repos/o/r/releases": JSON.stringify({
      tag_name: "v1.0.0",
      html_url: "https://github.com/o/r/releases/tag/v1.0.0",
    }),
    ...extra,
  });
  const runner = Object.assign(
    (...args: Parameters<typeof replay>) => {
      if (args[2].input) bodies.push((JSON.parse(args[2].input) as { body: string }).body);
      return replay(...args);
    },
    { calls: replay.calls },
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { bodies, calls: replay.calls };
};

const finish = (repo: RemoteRepo, ...flags: string[]) =>
  withHome(configHome.home, () =>
    run(["release", "finish", "1.0.0", ...flags, "--json"], repo.cwd),
  );

const draftPath = (repo: RemoteRepo) =>
  path.join(
    repo.git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    "workit",
    "release-notes",
    "1.0.0.md",
  );

const addHighlights = (repo: RemoteRepo, text = "- Faster startup for everyone") => {
  const file = draftPath(repo);
  writeFileSync(file, `## Highlights\n\n${text}\n\n${readFileSync(file, "utf8")}`);
};

const EXPECTED_BODY = [
  "## Breaking changes",
  "",
  "- the old flag",
  "",
  "## Changes",
  "",
  "### Removed",
  "",
  "- the old flag",
  "",
  "### Fixed",
  "",
  "- the widget",
  "",
  "**Full changelog**: https://github.com/o/r/compare/v0.9.0...v1.0.0",
  "",
].join("\n");

test.skipIf(process.platform === "win32")(
  "Given releaseNotes unset, When release finish reaches the forge release, Then the body is the notes built from the changelog section with the compare link",
  async () => {
    const repo = forgeRepo();
    workspace(repo, {});
    await started(repo);
    const replay = forge();
    const finished = await finish(repo);
    expect(finished.code, finished.stdout + finished.stderr).toBe(0);
    expect(replay.bodies).toEqual([EXPECTED_BODY]);
    // The tag message stays the changelog section.
    expect(repo.git("tag", "-l", "--format=%(contents)", "v1.0.0")).toContain("### Removed");
    expect(repo.git("tag", "-l", "--format=%(contents)", "v1.0.0")).not.toContain("Full changelog");
  },
);

test.skipIf(process.platform === "win32")(
  "Given releaseNotes off on the workspace, When finish runs, Then no forge release is created, the run says why, and merge, tag and push still happen",
  async () => {
    const repo = forgeRepo();
    workspace(repo, { releaseNotes: "off" });
    await started(repo);
    const replay = forge();
    const finished = await finish(repo);
    expect(finished.code, finished.stdout + finished.stderr).toBe(0);
    expect(finished.json().data.forgeRelease).toBeNull();
    expect(finished.json().data.notes.join("\n")).toContain("releaseNotes is off (workspace w)");
    expect(replay.calls.some((call) => call.endpoint.includes("releases"))).toBe(false);
    expect(repo.remoteTip("main")).toBe(repo.git("rev-parse", "main"));
    expect(repo.git("ls-remote", "origin", "refs/tags/v1.0.0")).not.toBe("");
    expect(rows(repo.cwd, "release.notes_skipped")).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "Given releaseNotes review on the workspace but off on the release track, When finish runs, Then the track wins: no approval asked and no forge release",
  async () => {
    const repo = forgeRepo();
    workspace(repo, {
      releaseNotes: "review",
      releaseTracks: {
        stable: {
          strategy: "gitflow",
          productionBranch: "main",
          integrationBranch: "develop",
          releaseNotes: "off",
        },
      },
    });
    await started(repo);
    const replay = forge();
    const finished = await finish(repo);
    expect(finished.code, finished.stdout + finished.stderr).toBe(0);
    expect(finished.json().data.notes.join("\n")).toContain("release track stable");
    expect(replay.calls.some((call) => call.endpoint.includes("releases"))).toBe(false);
  },
);

test("Given releaseNotes review and no approved draft, When finish runs (or --dry-run), Then it exits 3 with release_notes_unapproved before any merge, tag or push", async () => {
  const repo = forgeRepo();
  workspace(repo, { releaseNotes: "review" });
  await started(repo);
  const mainSha = repo.git("rev-parse", "main");
  const remoteMain = repo.remoteTip("main");
  for (const flags of [["--dry-run"], []]) {
    const refused = await finish(repo, ...flags);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("release_notes_unapproved");
    expect(refused.json().unblock).toContain("workit release notes draft 1.0.0");
    expect(refused.json().unblock).toContain("workit release notes approve 1.0.0");
  }
  expect(repo.git("rev-parse", "main")).toBe(mainSha);
  expect(repo.git("tag", "-l", "v1.0.0")).toBe("");
  expect(repo.remoteTip("main")).toBe(remoteMain);
  expect(rows(repo.cwd, "release.merged")).toHaveLength(0);
});

test.skipIf(process.platform === "win32")(
  "Given review mode and a draft the user approved, When finish runs, Then the forge release body is exactly the draft; an edit after approval is refused again",
  async () => {
    const repo = forgeRepo();
    workspace(repo, { releaseNotes: "review" });
    await started(repo);
    const drafted = await withHome(configHome.home, () =>
      run(["release", "notes", "draft", "1.0.0", "--json"], repo.cwd),
    );
    expect(drafted.code, drafted.stdout).toBe(0);
    addHighlights(repo);
    const approved = await approve(repo.cwd, "1.0.0", { interactive: true, env: userEnv() });
    expect(approved.code, JSON.stringify(approved.json())).toBe(0);
    const draft = readFileSync(draftPath(repo), "utf8");
    expect(rows(repo.cwd, "release.notes.approved").at(-1)).toMatchObject({
      version: "1.0.0",
      sha256: createHash("sha256").update(draft).digest("hex"),
    });
    // An edit after the approval invalidates it.
    writeFileSync(draftPath(repo), draft.replace("Faster startup", "Slower startup"));
    const refused = await finish(repo);
    expect(refused.code).toBe(3);
    expect(refused.json().error).toContain("changed after the user approved it");
    expect(repo.git("tag", "-l", "v1.0.0")).toBe("");
    // A wrong confirmation records nothing.
    const wrong = await approve(repo.cwd, "1.0.0", {
      interactive: true,
      env: userEnv(),
      answer: "yes",
    });
    expect(wrong.code).toBe(3);
    expect(rows(repo.cwd, "release.notes.approved")).toHaveLength(1);
    expect((await approve(repo.cwd, "1.0.0", { interactive: true, env: userEnv() })).code).toBe(0);
    const replay = forge();
    const finished = await finish(repo);
    expect(finished.code, finished.stdout + finished.stderr).toBe(0);
    expect(replay.bodies).toEqual([readFileSync(draftPath(repo), "utf8")]);
    expect(replay.bodies[0]).toContain("## Highlights\n\n- Slower startup for everyone");
  },
);

test("Given an agent shell or no terminal, When release notes approve runs, Then it refuses with the ask-the-user unblock and records nothing", async () => {
  const repo = forgeRepo();
  workspace(repo, { releaseNotes: "review" });
  await started(repo);
  await run(["release", "notes", "draft", "1.0.0"], repo.cwd);
  for (const options of [
    { interactive: true, env: { ...userEnv(), CLAUDECODE: "1" } },
    { interactive: false, env: userEnv() },
  ]) {
    const refused = await approve(repo.cwd, "1.0.0", options);
    expect(refused.code).toBe(3);
    expect(refused.json().unblock).toContain(
      "ask the user to run, in a terminal outside the agent host",
    );
    expect(refused.json().unblock).toContain("workit release notes approve 1.0.0");
  }
  expect(rows(repo.cwd, "release.notes.approved")).toHaveLength(0);
});

test("Given release notes draft run twice, Then the second keeps the Highlights the agent wrote unless --reset, and the draft is not in the worktree", async () => {
  const repo = forgeRepo();
  workspace(repo, {});
  await started(repo);
  const first = await withHome(configHome.home, () =>
    run(["release", "notes", "draft", "1.0.0", "--json"], repo.cwd),
  );
  expect(first.code, first.stdout).toBe(0);
  expect(first.json().data.notes).toBe(EXPECTED_BODY);
  expect(first.json().data.path).toBe(draftPath(repo));
  addHighlights(repo, "- One\n- Two");
  const again = await withHome(configHome.home, () =>
    run(["release", "notes", "draft", "1.0.0", "--json"], repo.cwd),
  );
  expect(again.json().data).toMatchObject({ keptHighlights: true });
  expect(again.json().data.notes).toBe(`## Highlights\n\n- One\n- Two\n\n${EXPECTED_BODY}`);
  const shown = await run(["release", "notes", "show", "1.0.0", "--json"], repo.cwd);
  expect(shown.json().data).toMatchObject({ approved: false, notes: again.json().data.notes });
  const reset = await withHome(configHome.home, () =>
    run(["release", "notes", "draft", "1.0.0", "--reset", "--json"], repo.cwd),
  );
  expect(reset.json().data.notes).toBe(EXPECTED_BODY);
  expect(repo.git("status", "--porcelain")).toBe("");
});

test("Given a GitLab remote, When the draft is written, Then its compare link is the GitLab one", async () => {
  const repo = forgeRepo("git@gitlab.com:g/sub/p.git");
  workspace(repo, { vcs: { provider: "gitlab" } });
  await started(repo);
  const drafted = await withHome(configHome.home, () =>
    run(["release", "notes", "draft", "1.0.0", "--json"], repo.cwd),
  );
  expect(drafted.code, drafted.stdout).toBe(0);
  expect(drafted.json().data.notes).toContain(
    "**Full changelog**: https://gitlab.com/g/sub/p/-/compare/v0.9.0...v1.0.0",
  );
});
