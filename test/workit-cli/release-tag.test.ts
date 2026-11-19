import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { readLedger } from "@/packages/workit-core/src/ledger";
import { fixture, replayRunner, type Call, type Reply } from "@/test/shared/helpers/forge-replay";
import {
  makeRemoteRepo,
  sshForgeRemote,
  withHome,
  type RemoteRepo,
} from "@/test/shared/helpers/git-remote";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// Tag-driven releases (#895): `workit release tag <vX.Y.Z>` cuts the tag on
// the fetched remote trunk once CI is green and the changelog has the
// section, pushes it and (with --wait) watches the release workflow; `workit
// release notes edit <tag> --from-changelog` backfills a published release's
// body. A real checkout whose origin is a local bare repository behind a fake
// ssh, and a replayed gh: never the real forge.

setDefaultTimeout(60_000);

let configDir = "";
let configHome: ConfigHome;
const original = { ...forgeDeps };
beforeAll(() => {
  configHome = useConfigHome("wk-release-tag-config-");
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
  const code = await withHome(configHome.home, () => main(argv, io));
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const SECTION = "### Added\n\n- the widget";
const changelog = (version: string) =>
  `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-11-18\n\n${SECTION}\n\n## [1.0.0] - 2026-09-01\n\n- older\n`;

/**
 * github-flow on a goreleaser-style repo: origin/main carries the changelog
 * and one more commit pushed from elsewhere, so the local main is behind.
 */
const tagRepo = (autonomy: Record<string, unknown>, version = "1.2.3") => {
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.write("CHANGELOG.md", changelog(version));
  repo.git("add", "-A");
  repo.git("commit", "-qm", `chore(release): ${version}`);
  repo.git("push", "-q", "origin", "main");
  const head = repo.pushFromElsewhere("main");
  sshForgeRemote(repo, "git@github.com:o/r.git");
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "w",
          glob: `${repo.root.replaceAll("\\", "/")}/**`,
          autonomy,
          vcs: { provider: "github", account: "octo" },
        },
      ],
    }),
  );
  return { repo, head, local: repo.git("rev-parse", "main") };
};

type Node = Record<string, unknown>;
const checkRun = (conclusion: string | null, status = "COMPLETED"): Node => ({
  __typename: "CheckRun",
  name: "test",
  status,
  conclusion,
  detailsUrl: "https://github.com/o/r/actions/runs/777",
  databaseId: 1,
  checkSuite: { workflowRun: { databaseId: 777, workflow: { name: "CI" } } },
});
const trunkChecks = (oid: string, nodes: Node[]) =>
  JSON.stringify({
    data: {
      repository: {
        object: {
          oid,
          statusCheckRollup: {
            contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      },
    },
  });

const RUNS = "GET repos/o/r/actions/runs?branch=v1.2.3&event=push&per_page=20";
const RELEASE = "GET repos/o/r/releases/tags/v1.2.3";

/** Replayed gh; each JSON body sent is kept with its call. */
const forge = (extra: Record<string, Reply>) => {
  const inputs: Array<{ call: Call; body: Record<string, string> }> = [];
  const replay = replayRunner({
    "GET user": fixture("github/user.json"),
    "GET repos/o/r": fixture("github/repo.json"),
    "CLI auth token --hostname github.com --user octo": "gho_token_for_octo_0000000000000000",
    "GET repos/o/r/branches/main": fixture("github/branch-main.json"),
    "GET repos/o/r/rules/branches/main": fixture("github/rules-main.json"),
    ...extra,
  });
  const runner = Object.assign(
    (...args: Parameters<typeof replay>) => {
      const result = replay(...args);
      const input = (args[2] as { input?: string }).input;
      if (input) inputs.push({ call: replay.calls.at(-1) as Call, body: JSON.parse(input) });
      return result;
    },
    { calls: replay.calls },
  );
  Object.assign(forgeDeps, { runner, sleep: async () => {}, now: () => 0 });
  return { calls: replay.calls, inputs };
};

const bareTag = (repo: RemoteRepo, tag: string) => ({
  type: repo.git("--git-dir", repo.bare, "cat-file", "-t", `refs/tags/${tag}`),
  commit: repo.git("--git-dir", repo.bare, "rev-parse", `refs/tags/${tag}^{commit}`),
});

const remoteHasTag = (repo: RemoteRepo, tag: string) =>
  repo.git("ls-remote", repo.bare, `refs/tags/${tag}`) !== "";

const rows = (cwd: string, type: string) => {
  const ledger = readLedger(cwd);
  if (!ledger.ok) throw new Error(ledger.error);
  return ledger.value.rows.filter((row) => row.type === type);
};

test.skipIf(process.platform === "win32")(
  "Given release: true, green CI on origin/main and a ## [1.2.3] section, When workit release tag v1.2.3 --wait runs, Then an annotated tag on origin/main's head is pushed and verified, the release workflow's release is found and the local branch is untouched",
  async () => {
    const { repo, head, local } = tagRepo({ release: true });
    const replay = forge({
      "graphql branch-checks": () => trunkChecks(head, [checkRun("SUCCESS")]),
      [RUNS]: JSON.stringify({
        workflow_runs: [
          {
            id: 9,
            name: "release",
            head_branch: "v1.2.3",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/o/r/actions/runs/9",
          },
        ],
      }),
      [RELEASE]: JSON.stringify({
        id: 5,
        tag_name: "v1.2.3",
        html_url: "https://github.com/o/r/releases/tag/v1.2.3",
      }),
    });
    const done = await run(["release", "tag", "v1.2.3", "--wait", "--json"], repo.cwd);
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(bareTag(repo, "v1.2.3")).toEqual({ type: "tag", commit: head });
    expect(repo.git("rev-parse", "main")).toBe(local);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(done.json().data.forgeRelease.url).toBe("https://github.com/o/r/releases/tag/v1.2.3");
    expect(repo.git("tag", "-l", "--format=%(contents)", "v1.2.3")).toContain("- the widget");
    // Workit never creates the forge release: the release workflow does.
    expect(replay.calls.some((call) => call.method === "POST")).toBe(false);
    expect(rows(repo.cwd, "release.tagged")).toEqual([
      expect.objectContaining({ tag: "v1.2.3", head }),
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "Given no release grant, When workit release tag runs, Then it is refused naming the release grant before anything is fetched or tagged",
  async () => {
    const { repo } = tagRepo({});
    const replay = forge({});
    const refused = await run(["release", "tag", "v1.2.3", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("release");
    expect(refused.json().unblock).toContain("release");
    expect(replay.calls).toEqual([]);
    expect(repo.git("tag", "-l")).toBe("");
  },
);

test.skipIf(process.platform === "win32")(
  "Given red CI on origin/main, When workit release tag runs, Then it is refused ci_red with the rerun fix and nothing is tagged",
  async () => {
    const { repo, head } = tagRepo({ release: true });
    forge({ "graphql branch-checks": () => trunkChecks(head, [checkRun("FAILURE")]) });
    const refused = await run(["release", "tag", "v1.2.3", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("ci_red");
    expect(refused.json().unblock).toContain("workit ci rerun --ref main");
    expect(repo.git("tag", "-l")).toBe("");
    expect(remoteHasTag(repo, "v1.2.3")).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "Given CI still running on origin/main, When workit release tag runs, Then it is refused ci_pending",
  async () => {
    const { repo, head } = tagRepo({ release: true });
    forge({ "graphql branch-checks": () => trunkChecks(head, [checkRun(null, "IN_PROGRESS")]) });
    const refused = await run(["release", "tag", "v1.2.3", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("ci_pending");
  },
);

test.skipIf(process.platform === "win32")(
  "Given the tag already on the remote, When workit release tag runs, Then it is refused tag_exists naming the next version",
  async () => {
    const { repo, head } = tagRepo({ release: true });
    repo.git("--git-dir", repo.bare, "tag", "v1.2.3", head);
    forge({});
    const refused = await run(["release", "tag", "v1.2.3", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("tag_exists");
    expect(refused.json().unblock).toContain("workit release tag v<next version>");
  },
);

test.skipIf(process.platform === "win32")(
  "Given a CHANGELOG.md without a ## [1.2.4] section, When workit release tag v1.2.4 runs, Then it is refused changelog_section_missing naming the roll of the Unreleased entries",
  async () => {
    const { repo } = tagRepo({ release: true });
    forge({});
    const refused = await run(["release", "tag", "v1.2.4", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain(
      "changelog_section_missing: CHANGELOG.md at origin/main",
    );
    expect(refused.json().unblock).toContain("roll the Unreleased entries");
    expect(repo.git("tag", "-l")).toBe("");
  },
);

test.skipIf(process.platform === "win32")(
  "Given a tag that is not on the release line, When workit release tag runs, Then it is a usage error",
  async () => {
    const { repo } = tagRepo({ release: true });
    const refused = await run(["release", "tag", "1.2.3", "--json"], repo.cwd);
    expect(refused.code, refused.stdout).toBe(2);
    expect(refused.json().error).toContain("v<version>");
  },
);

test.skipIf(process.platform === "win32")(
  "Given a published release, When workit release notes edit v1.2.3 --from-changelog runs twice, Then the body starts with the section once and the second run writes nothing",
  async () => {
    const { repo, head } = tagRepo({ release: true });
    repo.git("--git-dir", repo.bare, "tag", "v1.2.3", head);
    let body = "## Changelog\n\n* abc123 feat: the widget";
    const replay = forge({
      [RELEASE]: () =>
        JSON.stringify({
          id: 5,
          tag_name: "v1.2.3",
          body,
          html_url: "https://github.com/o/r/releases/tag/v1.2.3",
        }),
      "PATCH repos/o/r/releases/5": () => JSON.stringify({ id: 5 }),
    });
    const first = await run(
      ["release", "notes", "edit", "v1.2.3", "--from-changelog", "--json"],
      repo.cwd,
    );
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.json().data.changed).toBe(true);
    expect(replay.inputs).toHaveLength(1);
    body = replay.inputs[0].body.body;
    expect(body).toStartWith(
      "<!-- workit:changelog v1.2.3 -->\n### Added\n\n- the widget\n<!-- /workit:changelog -->",
    );
    expect(body).toEndWith("## Changelog\n\n* abc123 feat: the widget");
    const second = await run(
      ["release", "notes", "edit", "v1.2.3", "--from-changelog", "--json"],
      repo.cwd,
    );
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.json().data.changed).toBe(false);
    expect(replay.inputs).toHaveLength(1);
    expect(body.split("<!-- workit:changelog v1.2.3 -->")).toHaveLength(2);
  },
);

test.skipIf(process.platform === "win32")(
  "Given no changelog section for the tag, When workit release notes edit runs, Then it is refused and the forge is never written",
  async () => {
    const { repo, head } = tagRepo({ release: true });
    repo.git("--git-dir", repo.bare, "tag", "v2.0.0", head);
    const replay = forge({});
    const refused = await run(
      ["release", "notes", "edit", "v2.0.0", "--from-changelog", "--json"],
      repo.cwd,
    );
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toContain("changelog_section_missing");
    expect(replay.inputs).toEqual([]);
  },
);
