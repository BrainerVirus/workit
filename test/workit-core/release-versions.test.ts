import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASE_PACKAGES } from "@/packages/workit-core/scripts/analyze-release-scope";
import {
  releaseTagAtHead,
  releaseVersionProblems,
} from "@/packages/workit-core/scripts/publish-changed-packages";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// AR-15 contract after W2.34: the version a release ships lives only in the
// release job's checkout. main keeps its last-synced manifests (no sync PR
// moves it); the @semantic-release/npm bumpers write vX into each
// package.json, the prepare-time rewrite-workspace-deps.ts mirrors it into the
// host plugin.json files and the internal ^ranges, and the publish step
// refuses to run unless all of them equal the tag on HEAD.

if (process.platform === "win32") setDefaultTimeout(60_000);

const SCRIPTS = path.join(REPO_ROOT, "packages", "workit-core", "scripts");
const PLUGINS = [
  "packages/workit-cursor/.cursor-plugin/plugin.json",
  "packages/workit-codex/.codex-plugin/plugin.json",
  "packages/workit-claude-code/.claude-plugin/plugin.json",
];
const MANIFESTS = [...RELEASE_PACKAGES.map((pkg) => `packages/${pkg}/package.json`), ...PLUGINS];
const RELEASED = "99.1.0";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repo holding the real committed manifests, as main has them. */
function mainCheckout(): { root: string; git: (args: string[]) => string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-release-versions-"));
  roots.push(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "t"]);
  git(["config", "user.email", "t@t"]);
  for (const rel of MANIFESTS) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "feat: a change that releases"]);
  return { root, git };
}

/** What @semantic-release/npm's `npm version` does in each pkgRoot. */
function bumpLikeSemanticRelease(root: string, version: string) {
  for (const pkg of RELEASE_PACKAGES) {
    const file = path.join(root, "packages", pkg, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { version: string };
    manifest.version = version;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const rewrite = (root: string) =>
  execFileSync("bun", [path.join(SCRIPTS, "rewrite-workspace-deps.ts"), root], {
    encoding: "utf8",
  });

const committedVersion = (git: (args: string[]) => string, rel: string) =>
  (JSON.parse(git(["show", `HEAD:${rel}`])) as { version: string }).version;

test("the release checkout carries vX in every published manifest while main keeps its own", () => {
  const { root, git } = mainCheckout();
  const lastSynced = committedVersion(git, "packages/workit-core/package.json");
  expect(lastSynced).not.toBe(RELEASED);
  bumpLikeSemanticRelease(root, RELEASED);
  rewrite(root);
  git(["tag", `workit-dev-v${RELEASED}`]);

  expect(releaseTagAtHead(root)).toBe(`workit-dev-v${RELEASED}`);
  expect(releaseVersionProblems(root, `workit-dev-v${RELEASED}`)).toEqual([]);
  for (const rel of PLUGINS)
    expect(
      (JSON.parse(readFileSync(path.join(root, rel), "utf8")) as { version: string }).version,
    ).toBe(RELEASED);
  // The release never commits: HEAD (main) still holds the last-synced value.
  for (const rel of MANIFESTS) expect(committedVersion(git, rel), rel).toBe(lastSynced);
  expect(git(["status", "--porcelain"]).trim()).not.toBe("");
});

test("without the prepare-time rewrite the guard names every manifest that disagrees", () => {
  const { root, git } = mainCheckout();
  bumpLikeSemanticRelease(root, RELEASED);
  git(["tag", `workit-dev-v${RELEASED}`]);
  const problems = releaseVersionProblems(root, `workit-dev-v${RELEASED}`);
  for (const rel of PLUGINS)
    expect(problems.some((p) => p.startsWith(`${rel} version`))).toBe(true);
  expect(problems).toContain(
    `packages/workit-cli/package.json dependencies.@workit-dev/cursor is workspace:*, not ^${RELEASED}`,
  );
  // A tag that is not a release version is refused outright.
  expect(releaseVersionProblems(root, "latest")).toEqual([
    "latest is not a workit-dev-v<semver> release tag",
  ]);
});

test("no workit-dev-v* tag on HEAD reads as null (publishing before semantic-release tagged)", () => {
  const { root, git } = mainCheckout();
  expect(releaseTagAtHead(root)).toBeNull();
  git(["tag", "not-a-release"]);
  expect(releaseTagAtHead(root)).toBeNull();
});

// The publish entry point as semantic-release calls it, in dry-run mode only:
// npm is pointed at a closed port and its own dry run so nothing can publish.
function publishDryRun(root: string) {
  return spawnSync("bun", [path.join(SCRIPTS, "publish-changed-packages.ts"), ""], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLISH_DRY_RUN: "1",
      npm_config_dry_run: "true",
      npm_config_registry: "http://127.0.0.1:9/",
    },
  });
}

test("the publish step checks the tag before publishing, in dependency order", () => {
  const { root, git } = mainCheckout();
  bumpLikeSemanticRelease(root, RELEASED);
  rewrite(root);
  git(["tag", `workit-dev-v${RELEASED}`]);
  const ok = publishDryRun(root);
  expect(ok.status, ok.stderr).toBe(0);
  const lines = ok.stdout.split("\n");
  const guard = lines.indexOf(`every published manifest carries workit-dev-v${RELEASED}`);
  const published = lines
    .filter((line) => line.startsWith("published "))
    .map((line) => line.split(" ")[1]);
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(lines.findIndex((line) => line.startsWith("published "))).toBeGreaterThan(guard);
  expect(published.toSorted()).toEqual([...RELEASE_PACKAGES].toSorted());
  expect(published.indexOf("workit-core")).toBe(0);
  expect(published.indexOf("workit-cursor")).toBeLessThan(published.indexOf("workit-cli"));
  expect(published.at(-1)).toBe("workit-cli");

  // A tag the manifests do not carry stops the step before any package.
  git(["tag", "workit-dev-v99.2.0"]);
  const bad = publishDryRun(root);
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("release workit-dev-v99.2.0 manifests disagree");
  expect(bad.stdout).not.toContain("published ");
});
