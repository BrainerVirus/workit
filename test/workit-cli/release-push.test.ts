import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { runRelease } from "@/packages/workit-cli/src/verbs/release";
import { readLedger } from "@/packages/workit-core/src/ledger";
import {
  fixture,
  replayRunner,
  replyError,
  type Call,
  type Reply,
} from "@/test/shared/helpers/forge-replay";
import {
  makeRemoteRepo,
  sshForgeRemote,
  withHome,
  type RemoteRepo,
} from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// Release notes outside git-flow: `workit release finish` on github-flow
// opens the release PR with the notes as its body, and `workit git push
// --release <tag>` after the merge publishes the forge release with them
// (workspace `releaseNotes`: auto by default, off, review). A real checkout
// whose origin is a local bare repository behind a fake ssh, and replayed
// gh/glab.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-release-push-config-");
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

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await withHome(configHome.home, () => main(argv, io));
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

/** The user approves the draft at their own terminal. */
const approve = async (cwd: string, version: string) => {
  const io: Io = {
    json: true,
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !AGENT_VARS.has(name) && !name.startsWith("CODEX_"),
        ),
      ),
      WORKIT_SESSION_ID: "user-1",
    },
    stdout: () => {},
    stderr: () => {},
  };
  return runRelease(["notes", "approve", version], io, {
    interactive: () => true,
    ask: async () => version,
  });
};

type Kind = "github" | "gitlab";

const workspace = (repo: RemoteRepo, kind: Kind, entry: Record<string, unknown>) =>
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          autonomy: { release: true, pr: true },
          vcs:
            kind === "github"
              ? { provider: "github", account: "octo" }
              : { provider: "gitlab", account: "octo" },
          ...entry,
        },
      ],
    }),
  );

/** github-flow: main tagged v0.9.0 on origin; the push URL a forge's. */
const flowRepo = (kind: Kind, entry: Record<string, unknown> = {}): RemoteRepo => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("tag", "v0.9.0", "main");
  sshForgeRemote(
    repo,
    kind === "github" ? "git@github.com:o/r.git" : "git@gitlab.com:group/project.git",
  );
  workspace(repo, kind, entry);
  return repo;
};

const SECTION = "### Fixed\n\n- the widget";
const CHANGELOG = `# Changelog\n\n## [1.0.0] - 2026-10-14\n\n${SECTION}\n\n## [0.9.0] - 2026-09-01\n\n- older\n`;

/** release/1.0.0 from main with the changelog section; returns its tip. */
const started = async (repo: RemoteRepo) => {
  const begun = await run(["release", "start", "1.0.0", "--json"], repo.cwd);
  expect(begun.code, begun.stdout + begun.stderr).toBe(0);
  repo.write("CHANGELOG.md", CHANGELOG);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore(release): 1.0.0");
  return repo.git("rev-parse", "HEAD");
};

/** The release PR merged on the forge (simulated), then the merge tagged locally. */
const mergedAndTagged = (repo: RemoteRepo) => {
  repo.git("switch", "-q", "main");
  repo.git("merge", "-q", "--no-ff", "--no-edit", "release/1.0.0");
  repo.git("push", "-q", "origin", "main");
  repo.git("tag", "-a", "v1.0.0", "-m", "Release 1.0.0");
};

const BUILT = (compare: string) =>
  `## Changes\n\n### Fixed\n\n- the widget\n\n**Full changelog**: ${compare}\n`;
const GH_COMPARE = "https://github.com/o/r/compare/v0.9.0...v1.0.0";
const GL_COMPARE = "https://gitlab.com/group/project/-/compare/v0.9.0...v1.0.0";
const GL = "projects/group%2Fproject";

/** Replayed forge: identity, the release PR, and releases; each JSON body sent is kept. */
const forge = (kind: Kind, tip = "") => {
  const inputs: Array<{ endpoint: string; body: Record<string, string> }> = [];
  const routes: Record<string, Reply> =
    kind === "github"
      ? {
          "GET user": fixture("github/user.json"),
          "GET repos/o/r": fixture("github/repo.json"),
          "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
          "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
          "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
          "graphql find": fixture("github/find-none.json"),
          "POST repos/o/r/pulls": JSON.stringify({
            number: 7,
            html_url: "https://github.com/o/r/pull/7",
            state: "open",
            head: { ref: "release/1.0.0", sha: tip },
          }),
          "GET repos/o/r/releases/tags/v1.0.0": () => replyError("gh: Not Found (HTTP 404)"),
          "POST repos/o/r/releases": JSON.stringify({
            tag_name: "v1.0.0",
            html_url: "https://github.com/o/r/releases/tag/v1.0.0",
          }),
        }
      : {
          "GET user": fixture("gitlab/user.json"),
          [`GET ${GL}`]: fixture("gitlab/project.json"),
          [`GET ${GL}/releases/v1.0.0`]: () => replyError("glab: 404 Not Found"),
          [`POST ${GL}/releases`]: JSON.stringify({
            tag_name: "v1.0.0",
            _links: { self: "https://gitlab.com/group/project/-/releases/v1.0.0" },
          }),
        };
  const replay = replayRunner(routes);
  const runner = Object.assign(
    (...args: Parameters<typeof replay>) => {
      const result = replay(...args);
      const call = replay.calls.at(-1) as Call;
      if (args[2].input) inputs.push({ endpoint: call.endpoint, body: JSON.parse(args[2].input) });
      return result;
    },
    { calls: replay.calls },
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  const pr = () =>
    replay.calls.find((call) => call.method === "POST" && call.endpoint === "repos/o/r/pulls");
  const releases = () => inputs.filter((entry) => entry.endpoint.endsWith("/releases"));
  return { calls: replay.calls, pr, releases };
};

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

const draftPath = (repo: RemoteRepo) =>
  path.join(
    repo.git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    "workit",
    "release-notes",
    "1.0.0.md",
  );

const remoteTag = (repo: RemoteRepo) => repo.git("ls-remote", "origin", "refs/tags/v1.0.0");

test.skipIf(process.platform === "win32")(
  "Given github-flow and review with no approved draft, When release finish runs, Then it exits 3 release_notes_unapproved and opens no PR; after approval the PR body is the approved draft",
  async () => {
    const repo = flowRepo("github", { releaseNotes: "review" });
    const tip = await started(repo);
    const replay = forge("github", tip);
    const refused = await run(["release", "finish", "1.0.0", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("release_notes_unapproved");
    expect(refused.json().unblock).toContain("workit release notes approve 1.0.0");
    expect(replay.pr()).toBeUndefined();
    expect(repo.remoteTip("release/1.0.0")).toBeNull();
    expect((await run(["release", "notes", "draft", "1.0.0"], repo.cwd)).code).toBe(0);
    writeFileSync(
      draftPath(repo),
      `## Highlights\n\n- The widget works\n\n${readFileSync(draftPath(repo), "utf8")}`,
    );
    expect(await approve(repo.cwd, "1.0.0")).toBe(0);
    const opened = await run(["release", "finish", "1.0.0", "--json"], repo.cwd);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(replay.pr()?.vars.body).toBe(readFileSync(draftPath(repo), "utf8"));
  },
);

for (const kind of ["github", "gitlab"] as const)
  test.skipIf(process.platform === "win32")(
    `Given github-flow and auto on ${kind}, When the release PR merges and the tag is pushed with git push --release, Then the forge release carries the built notes`,
    async () => {
      const repo = flowRepo(kind);
      const tip = await started(repo);
      if (kind === "github") {
        const replay = forge(kind, tip);
        const opened = await run(["release", "finish", "1.0.0"], repo.cwd);
        expect(opened.code, opened.stdout + opened.stderr).toBe(0);
        expect(replay.pr()?.vars.body).toBe(BUILT(GH_COMPARE));
        expect(opened.stdout).toContain(
          "workit git push --release v1.0.0  # it also publishes the forge release",
        );
      }
      mergedAndTagged(repo);
      const replay = forge(kind);
      const pushed = await run(["git", "push", "--release", "v1.0.0", "--json"], repo.cwd);
      expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
      expect(remoteTag(repo)).not.toBe("");
      const [release] = replay.releases();
      expect(kind === "github" ? release.body.body : release.body.description).toBe(
        BUILT(kind === "github" ? GH_COMPARE : GL_COMPARE),
      );
      expect(pushed.json().data.forgeReleases).toEqual([
        expect.objectContaining({ tag: "v1.0.0", created: true }),
      ]);
      expect(rows(repo.cwd, "release.forge_released")).toHaveLength(1);
    },
  );

test.skipIf(process.platform === "win32")(
  "Given github-flow and review, When the draft is edited after approval and git push --release runs, Then it refuses before pushing anything",
  async () => {
    const repo = flowRepo("github", { releaseNotes: "review" });
    await started(repo);
    expect((await run(["release", "notes", "draft", "1.0.0"], repo.cwd)).code).toBe(0);
    expect(await approve(repo.cwd, "1.0.0")).toBe(0);
    writeFileSync(
      draftPath(repo),
      `## Highlights\n\n- edited\n\n${readFileSync(draftPath(repo), "utf8")}`,
    );
    mergedAndTagged(repo);
    const replay = forge("github");
    const refused = await run(["git", "push", "--release", "v1.0.0", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("release_notes_unapproved");
    expect(refused.json().error).toContain("nothing was pushed");
    expect(remoteTag(repo)).toBe("");
    expect(replay.releases()).toEqual([]);
    // Approved again, the same push publishes exactly the draft.
    expect(await approve(repo.cwd, "1.0.0")).toBe(0);
    const pushed = await run(["git", "push", "--release", "v1.0.0", "--json"], repo.cwd);
    expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
    expect(replay.releases()[0].body.body).toBe(readFileSync(draftPath(repo), "utf8"));
  },
);

test.skipIf(process.platform === "win32")(
  "Given github-flow and off, When the release PR opens and the tag is pushed, Then the PR body is the changelog section and no forge release is created",
  async () => {
    const repo = flowRepo("github", { releaseNotes: "off" });
    const tip = await started(repo);
    const replay = forge("github", tip);
    const opened = await run(["release", "finish", "1.0.0"], repo.cwd);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(replay.pr()?.vars.body).toBe(SECTION);
    mergedAndTagged(repo);
    const pushed = await run(["git", "push", "--release", "v1.0.0", "--json"], repo.cwd);
    expect(pushed.code, pushed.stdout + pushed.stderr).toBe(0);
    expect(remoteTag(repo)).not.toBe("");
    expect(replay.calls.some((call) => call.endpoint.includes("releases"))).toBe(false);
    expect(pushed.json().data.notes.join("\n")).toContain("releaseNotes is off");
  },
);
