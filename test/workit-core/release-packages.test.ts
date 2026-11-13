import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  packageOfTag,
  readReleasePackages,
  workspaceReleasePackages,
} from "@/packages/workit-core/src/core/release-packages";
import { createGitHubForge } from "@/packages/workit-core/src/forge/github";
import { releaseLinesOf } from "@/packages/workit-core/src/git/ops";
import { changelogSection, packageChangelogSection } from "@/packages/workit-core/src/git/release";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { replayRunner } from "@/test/shared/helpers/forge-replay";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// Release packages (#860): the lenient reader, package tags beside the
// workspace's own release line (never a track), the changelog a version's
// notes come from, the raw-git denial, and GitHub's Latest mark.

setDefaultTimeout(30_000);

let configHome: ConfigHome;
const roots: string[] = [];
beforeAll(() => {
  configHome = useConfigHome("wk-release-packages-core-");
});
afterAll(() => {
  configHome.restore();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

/** A git-flow checkout (main, develop) with bare version tags, in workspace `w` with `entry`. */
const repo = (entry: Record<string, unknown>, files: Record<string, string> = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "wk-release-packages-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "gitflow.prefix.versiontag", "");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "branch", "develop");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
  );
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "w", glob: `${root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );
  return root;
};

const section = (version: string, line: string) =>
  `# Changelog\n\n## [${version}] - 2026-11-13\n\n- ${line}\n\n## [0.0.1]\n\n- older\n`;

test("Given releasePackages entries good and bad, When they are read, Then good ones get their namespace (default <name>@) and each bad one is reported and ignored", () => {
  const read = readReleasePackages({
    "pkg-a": {},
    "pkg-b": { tagNamespace: "b/v", changelogPath: "projects/b/CHANGELOG.md" },
    "pkg-c": "nope",
    "pkg-d": { tagNamespace: "d1" },
    "pkg-e": { tagNamespace: "b/v" },
    "pkg-f": { changelogPath: "../out.md", extra: true },
  });
  expect(read.packages).toEqual([
    { name: "pkg-a", tagNamespace: "pkg-a@", changelogPath: null },
    { name: "pkg-b", tagNamespace: "b/v", changelogPath: "projects/b/CHANGELOG.md" },
    { name: "pkg-f", tagNamespace: "pkg-f@", changelogPath: null },
  ]);
  const issues = read.issues.join("\n");
  expect(issues).toContain('release package "pkg-c" is not an object');
  expect(issues).toContain('release package "pkg-d" tagNamespace "d1"');
  expect(issues).toContain("already pkg-b's");
  expect(issues).toContain('release package "pkg-f" changelogPath');
  expect(issues).toContain('release package "pkg-f" extra: unknown field');
  expect(readReleasePackages(["pkg-a"]).issues).toEqual([
    "releasePackages is not an object; ignored",
  ]);
});

test("Given packages pkg@ and pkg-a@, When a tag is matched, Then the longest namespace with a digit after it wins and anything else is no package", () => {
  const { packages } = readReleasePackages({ pkg: {}, "pkg-a": { tagNamespace: "pkg-a@" } });
  expect(packageOfTag("pkg-a@0.1.0", packages)).toMatchObject({
    pkg: { name: "pkg-a" },
    version: "0.1.0",
  });
  expect(packageOfTag("pkg@2.0.0", packages)).toMatchObject({
    pkg: { name: "pkg" },
    version: "2.0.0",
  });
  expect(packageOfTag("pkg-a@next", packages)).toBeNull();
  expect(packageOfTag("1.0.0", packages)).toBeNull();
});

test("Given releasePackages and no release tracks, When the release lines are read, Then there is only the workspace's own line (packages never become tracks)", () => {
  const root = repo({ releasePackages: { "pkg-a": {}, "pkg-b": {} } });
  expect(workspaceReleasePackages(root).packages.map((entry) => entry.name)).toEqual([
    "pkg-a",
    "pkg-b",
  ]);
  const lines = releaseLinesOf(root);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ track: null, production: "main", tagPrefix: "" });
});

test("Given changelogPath projects/*/CHANGELOG.md, When a version's section is read, Then every changelog is searched, an unclaimed one wins over a package's, and a package without changelogPath reads the one in its directory", () => {
  const root = repo(
    { changelogPath: "projects/*/CHANGELOG.md", releasePackages: { "a-pkg": {} } },
    {
      // a-pkg sorts first: it still loses to the unclaimed main changelog.
      "projects/a-pkg/CHANGELOG.md": section("4.6.0", "a-pkg's own 4.6.0"),
      "projects/docs/CHANGELOG.md": section("0.0.9", "docs only"),
      "projects/main/CHANGELOG.md": section("4.6.0", "the main widget"),
    },
  );
  expect(changelogSection(root, "HEAD", "4.6.0")).toBe("- the main widget");
  expect(changelogSection(root, "HEAD", "0.0.9")).toBe("- docs only");
  expect(changelogSection(root, "HEAD", "9.9.9")).toBeNull();
  const [pkg] = workspaceReleasePackages(root).packages;
  expect(packageChangelogSection(root, "HEAD", "4.6.0", pkg)).toBe("- a-pkg's own 4.6.0");
});

test("Given releasePackages configured, When an agent pushes a package tag raw, Then the hook denies it naming workit git push --release <tag> and the package's tag shape", () => {
  const root = repo({ autonomy: { release: true }, releasePackages: { "pkg-a": {} } });
  git(root, "tag", "-a", "pkg-a@0.1.0", "-m", "pkg-a 0.1.0");
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  git(root, "remote", "add", "origin", origin);
  const out = dispatchHook(claudeCodeAdapter, {
    hook_event_name: "PreToolUse",
    session_id: "s-raw-tag",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "git push origin pkg-a@0.1.0" },
  }).json as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  const reason = String(out.hookSpecificOutput?.permissionDecisionReason);
  expect(reason).toContain("workit git push --release pkg-a@0.1.0");
  expect(reason).toContain("<version>, pkg-a@<version> tags");
});

test("Given the GitHub forge, When createRelease gets latest false, true or nothing, Then the body carries make_latest false, true or no such key", () => {
  const bodies: Array<Record<string, unknown>> = [];
  const replay = replayRunner({
    "POST repos/o/r/releases": JSON.stringify({ tag_name: "pkg-a@0.1.0" }),
  });
  const runner = Object.assign(
    (...args: Parameters<typeof replay>) => {
      if (args[2].input) bodies.push(JSON.parse(args[2].input) as Record<string, unknown>);
      return replay(...args);
    },
    { calls: replay.calls },
  );
  const forge = createGitHubForge({ apiHost: "github.com", repo: "o/r", runner });
  for (const latest of [false, true, undefined])
    expect(
      forge.createRelease({ tag: "pkg-a@0.1.0", name: "pkg-a@0.1.0", body: "notes", latest }).ok,
    ).toBe(true);
  expect(bodies.map((body) => body.make_latest)).toEqual(["false", "true", undefined]);
  expect(bodies[2]).not.toHaveProperty("make_latest");
});
