import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_PACKAGES, TAG_PREFIX } from "@/packages/workit-core/scripts/analyze-release-scope";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// Task 24 release-orchestration gate (AR-01/AR-02, CA-33/CA-44): the real
// release job must build every adapter and pass the pack-only candidate gate
// BEFORE semantic-release can publish. A clean checkout carries no generated
// dist/ into CI, and no dependency/protocol check may run only after a package
// could already have been published.

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- caller-typed JSON fixture reader
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

const ADAPTERS = [
  "workit-mcp",
  "workit-opencode",
  "workit-cursor",
  "workit-codex",
  "workit-pi",
  "workit-cli",
  "workit-claude-code",
] as const;

test(
  "a clean checkout tracks no generated adapter dist/ files (CA-33)",
  () => {
    const tracked = spawnSync("git", ["ls-files", ...ADAPTERS.map((a) => `packages/${a}/dist`)], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim(), tracked.stderr).toBe("");
  },
  { timeout: 60_000 },
);

test(
  "root scripts build the three adapters and run the pack-only gate (AR-02)",
  () => {
    const scripts = json<{ scripts: Record<string, string> }>("package.json").scripts;
    expect(scripts.build).toBeTruthy();
    for (const adapter of ADAPTERS) {
      expect(scripts.build).toContain(`packages/${adapter}/scripts/build.ts`);
    }
    expect(scripts["verify:release-candidate"]).toBeTruthy();
    expect(scripts["verify:release-candidate"]).toContain("scripts/verify-release-candidate.ts");

    // The gate script itself is pack-only: it runs the candidate pack and never
    // invokes a publication command (RL-08/CA-30).
    const gate = read("scripts/verify-release-candidate.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(gate).toContain("packReleaseCandidate");
    expect(gate).not.toMatch(
      /\b(?:npm|npx|bun)\s+(?:publish|login|adduser)\b|\bgit\s+(?:push|tag)\b/,
    );
  },
  { timeout: 60_000 },
);

test(
  "release job order is install → build → candidate gate → semantic-release, and Release is last (AR-01/CA-33)",
  () => {
    const wf = Bun.YAML.parse(read(".github/workflows/release.yml")) as {
      jobs: {
        release: {
          steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
        };
      };
    };
    const steps = wf.jobs.release.steps.map((s) => s.name ?? s.run ?? "");
    const order = ["Install dependencies", "Build adapters", "Verify release candidate", "Release"];
    const idx = order.map((name) => steps.indexOf(name));
    expect(idx[0], steps.join(" | ")).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i], steps.join(" | ")).toBeGreaterThan(idx[i - 1]);
    }
    // No dependency/protocol check may appear only after a package could
    // already have been published (AR-01), and nothing follows the release.
    expect(idx[3], steps.join(" | ")).toBe(steps.length - 1);
    expect(wf.jobs.release.steps[idx[1]].run).toContain("bun run build");
    expect(wf.jobs.release.steps[idx[2]].run).toContain("bun run verify:release-candidate");
    // `npm version` must not reinstall the workspace: on a major bump it would
    // install the previous release under packages/*/node_modules and the
    // prepare-time build would bundle it (8.0.0).
    expect(wf.jobs.release.steps[idx[3]].env?.NPM_CONFIG_WORKSPACES_UPDATE).toBe("false");
  },
  { timeout: 60_000 },
);

// AR-15 after W2.34: the released version lives in the release job's own
// checkout, never in a commit back to main. Before, every release opened and
// auto-merged a `chore(release): sync manifests` PR; strict branch protection
// then left every open PR BEHIND (one rebase and ~25 min of CI per PR per
// release). test/workit-core/release-versions.test.ts proves the published
// manifests still carry the tag's version.
test(
  "a release writes nothing back to main: no sync commit, branch or PR (AR-15)",
  () => {
    const release = read(".github/workflows/release.yml");
    const wf = Bun.YAML.parse(release) as {
      on: { workflow_call: { secrets?: Record<string, unknown> } | null };
      jobs: { release: { steps: Array<{ run?: string }> } };
    };
    const runs = wf.jobs.release.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/\bgit\s+(?:commit|push|checkout\s+-b)\b|\bgh\s+pr\b/);
    expect(release).not.toContain("sync-release-manifests");
    expect(release).not.toContain("manifest-sync");
    // The PAT existed only to open the sync PR with CI-triggering events, and
    // npm auth is trusted publishing: the release takes no secret at all.
    expect(wf.on.workflow_call?.secrets ?? {}).toEqual({});
    expect(read(".github/workflows/ci.yml")).not.toContain("RELEASE_SYNC_TOKEN");
    expect(
      existsSync(path.join(REPO_ROOT, ".github/workflows/cleanup-manifest-sync-branch.yml")),
    ).toBe(false);

    // Who sets the version: one @semantic-release/npm bumper per published
    // package (never publishing, never committing), no @semantic-release/git.
    const cfg = require(path.resolve(REPO_ROOT, "release.config.cjs")) as { plugins: unknown[] };
    const names = cfg.plugins.map((p) => (Array.isArray(p) ? String(p[0]) : String(p)));
    expect(names).not.toContain("@semantic-release/git");
    const bumped = cfg.plugins
      .filter((p) => Array.isArray(p) && p[0] === "@semantic-release/npm")
      .map((p) => (p as [string, { pkgRoot: string }])[1].pkgRoot);
    expect(bumped.toSorted()).toEqual(RELEASE_PACKAGES.map((pkg) => `packages/${pkg}`).toSorted());

    // The publish entry point checks every manifest against the tag on HEAD
    // before it publishes anything.
    const publish = read("packages/workit-core/scripts/publish-changed-packages.ts");
    const main = publish.slice(publish.indexOf("if (import.meta.main)"));
    expect(main.indexOf("releaseVersionProblems(")).toBeGreaterThan(0);
    expect(main.indexOf("releaseVersionProblems(")).toBeLessThan(main.indexOf("publishChanged("));
  },
  { timeout: 60_000 },
);

// npm trusted publishing (2026-11-07: the NPMJS token was rejected with a 404
// on PUT and npm drops bypass-2FA tokens for direct publish). npm
// authenticates the publish through the job's OIDC token; npmjs.com trusts the
// CALLING workflow (ci.yml), so both it and release.yml grant id-token.
test(
  "releases publish through npm trusted publishing: OIDC, no npm token, npm >= 11.21",
  () => {
    type Job = {
      permissions?: Record<string, string>;
      secrets?: unknown;
      steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
    };
    const releaseText = read(".github/workflows/release.yml");
    const release = Bun.YAML.parse(releaseText) as { jobs: { release: Job } };
    const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as { jobs: { release: Job } };

    // No step, env or input carries an npm token into the publish path.
    const code = releaseText
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/NPMJS|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
    expect(ci.jobs.release.secrets).toBeUndefined();
    expect(read(".github/workflows/ci.yml")).not.toContain("secrets.NPMJS");

    expect(release.jobs.release.permissions?.["id-token"]).toBe("write");
    expect(ci.jobs.release.permissions?.["id-token"]).toBe("write");

    // setup-node's registry-url writes an `_authToken=${NODE_AUTH_TOKEN}` line
    // that would stand in for OIDC.
    const steps = release.jobs.release.steps ?? [];
    for (const step of steps) expect(step.with?.["registry-url"]).toBeUndefined();

    // Node 24.20.0 bundles npm 11.19.0; OIDC dist-tag needs 11.21.0. The npm
    // upgrade and the printed version check both run before the release.
    const names = steps.map((s) => s.name ?? "");
    const install = names.indexOf("Install npm with trusted publishing");
    const check = names.indexOf("Check npm version");
    expect(install, names.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(install);
    expect(check).toBeLessThan(names.indexOf("Release"));
    const pinned = /npm@(\d+)\.(\d+)\.(\d+)/.exec(steps[install].run ?? "");
    expect(pinned).not.toBeNull();
    const [major, minor] = [Number(pinned?.[1]), Number(pinned?.[2])];
    expect(major > 11 || (major === 11 && minor >= 21)).toBe(true);
    expect(steps[check].run).toContain("npm --version");
    expect(steps[check].run).toContain("11.21.0");
  },
  { timeout: 60_000 },
);

// Trusted publishing (and provenance) checks that each package's
// repository.url names the repo the workflow runs in.
test("every released package names this repo and its directory as repository", () => {
  for (const pkg of RELEASE_PACKAGES) {
    const manifest = json<{ repository?: unknown }>(`packages/${pkg}/package.json`);
    expect(manifest.repository, pkg).toEqual({
      type: "git",
      url: "git+https://github.com/BrainerVirus/workit.git",
      directory: `packages/${pkg}`,
    });
  }
});

test(
  "rewrite runs before npm package verification and after version assignment (AR-02)",
  () => {
    const config = read("release.config.cjs");
    const npmFirst = config.indexOf("@semantic-release/npm");
    const npmLast = config.lastIndexOf("@semantic-release/npm");
    const verify = config.indexOf("verifyConditionsCmd");
    const prepare = config.indexOf("prepareCmd");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThanOrEqual(0);
    // verify-time rewrite is listed BEFORE the first npm plugin, so package
    // verification never sees a workspace:* manifest.
    expect(verify).toBeLessThan(npmFirst);
    // prepare-time rewrite is listed AFTER the last npm plugin, so it runs after
    // the semantic-release version bumps and rewrites to the released version.
    expect(prepare).toBeGreaterThan(npmLast);
    expect(config.match(/rewrite-workspace-deps\.ts/g) ?? []).toHaveLength(2);
    // Bundles embed the package version, so they are rebuilt AFTER the bump;
    // otherwise `workit --version` and npx hints report the previous release.
    // ...and the rebuilt bundles must inline the tagged workspace sources.
    expect(config).toMatch(
      /prepareCmd:\s*"[^"]*rewrite-workspace-deps\.ts && bun packages\/workit-core\/scripts\/verify-bundle-sources\.ts --installs-only && bun run build && bun packages\/workit-core\/scripts\/verify-bundle-sources\.ts"/,
    );

    // CA-08 selective-publish pins are STRUCTURAL: load the pure-object config
    // instead of matching raw bytes, so a comment reflow can't break them.
    const cfg = require(path.resolve(REPO_ROOT, "release.config.cjs")) as {
      plugins: unknown[];
      tagFormat?: string;
    };
    const opts = (p: unknown): Record<string, unknown> =>
      Array.isArray(p) && p.length > 1 && typeof p[1] === "object" && p[1] !== null
        ? (p[1] as Record<string, unknown>)
        : {};
    const nameOf = (p: unknown): string =>
      typeof p === "string" ? p : Array.isArray(p) ? String(p[0]) : "";
    const isNpm = (p: unknown) => nameOf(p) === "@semantic-release/npm";

    // analyze gate runs first: the leading plugin is the exec entry carrying
    // analyzeCommitsCmd (AR-16). @semantic-release/exec v7 renamed analyzeCmd →
    // analyzeCommitsCmd; a stale key is silently ignored by the plugin, so the
    // pins below also reject any option name the installed plugin does not know.
    expect(nameOf(cfg.plugins[0])).toBe("@semantic-release/exec");
    expect(opts(cfg.plugins[0]).analyzeCommitsCmd).toBe(
      "bun packages/workit-core/scripts/analyze-release-scope.ts",
    );
    const execKeys = new Set([
      "cmd",
      "verifyConditionsCmd",
      "analyzeCommitsCmd",
      "verifyReleaseCmd",
      "generateNotesCmd",
      "prepareCmd",
      "addChannelCmd",
      "publishCmd",
      "successCmd",
      "failCmd",
    ]);
    for (const p of cfg.plugins) {
      if (nameOf(p) !== "@semantic-release/exec") continue;
      for (const key of Object.keys(opts(p))) expect(execKeys.has(key)).toBe(true);
    }
    // bumpers only: exactly four @semantic-release/npm entries, none publishing.
    const npmEntries = cfg.plugins.filter(isNpm);
    expect(npmEntries).toHaveLength(8);
    for (const entry of npmEntries) expect(opts(entry).npmPublish).toBe(false);
    // selective publish lands after the bumpers (AR-16). The GitHub release
    // plugin is listed before it: a partial npm failure must still leave a
    // GitHub release with notes (v8.41.0 had a tag and packages but none).
    const lastNpmIdx = cfg.plugins.reduce<number>((acc, p, i) => (isNpm(p) ? i : acc), -1);
    const publishIdx = cfg.plugins.findIndex((p) => typeof opts(p).publishCmd === "string");
    // The publisher must diff against the PREVIOUS tag: semantic-release creates
    // the new release tag before publish plugins run, so latestTag() inside the
    // script would see the release being cut and skip every package.
    expect(opts(cfg.plugins[publishIdx]).publishCmd).toContain("${lastRelease.gitTag}");
    // Releases are tagged workit-dev-v<version>: the old @brainervirus v* tags
    // never seed a version, so the first @workit-dev release is 1.0.0, and
    // the scripts read the same prefix.
    expect(cfg.tagFormat).toBe(`${TAG_PREFIX}\${version}`);
    const githubIdx = cfg.plugins.findIndex((p) => nameOf(p) === "@semantic-release/github");
    expect(publishIdx).toBeGreaterThan(lastNpmIdx);
    expect(githubIdx).toBeGreaterThan(lastNpmIdx);
    expect(githubIdx).toBeLessThan(publishIdx);
    expect(cfg.plugins.filter((p) => nameOf(p) === "@semantic-release/github")).toHaveLength(1);
  },
  { timeout: 60_000 },
);
