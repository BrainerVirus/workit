import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../shared/helpers/packages";

// Task 24 release-orchestration gate (AR-01/AR-02, CA-33/CA-44): the real
// release job must build every adapter and pass the pack-only candidate gate
// BEFORE semantic-release can publish. A clean checkout carries no generated
// dist/ into CI, and no dependency/protocol check may run only after a package
// could already have been published.

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

const ADAPTERS = ["workit-opencode", "workit-cursor", "workit-cli"] as const;

test("a clean checkout tracks no generated adapter dist/ files (CA-33)", () => {
  const tracked = spawnSync("git", ["ls-files", ...ADAPTERS.map((a) => `packages/${a}/dist`)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(tracked.status).toBe(0);
  expect(tracked.stdout.trim(), tracked.stderr).toBe("");
});

test("root scripts build the three adapters and run the pack-only gate (AR-02)", () => {
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
});

test("release job order is install → build → candidate gate → semantic-release → manifest sync (AR-01/CA-33/AR-15)", () => {
  const wf = Bun.YAML.parse(read(".github/workflows/release.yml")) as {
    jobs: {
      release: {
        steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      };
    };
  };
  const steps = wf.jobs.release.steps.map((s) => s.name ?? s.run ?? "");
  const order = [
    "Install dependencies",
    "Build adapters",
    "Verify release candidate",
    "Release",
    "Sync release manifests to main",
  ];
  const idx = order.map((name) => steps.indexOf(name));
  expect(idx[0], steps.join(" | ")).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < idx.length; i++) {
    expect(idx[i], steps.join(" | ")).toBeGreaterThan(idx[i - 1]);
  }
  // The manifest sync is the only step allowed AFTER semantic-release
  // (AR-15): it is post-publish bookkeeping that gates nothing. No
  // dependency/protocol check may appear only after a package could already
  // have been published (AR-01).
  expect(idx[4], steps.join(" | ")).toBe(steps.length - 1);
  const afterRelease = steps.slice(idx[3] + 1, idx[4]).join(" | ");
  expect(afterRelease, "no gate may run between Release and the manifest sync").toBe("");
  expect(wf.jobs.release.steps[idx[1]].run).toContain("bun run build");
  expect(wf.jobs.release.steps[idx[2]].run).toContain("bun run verify:release-candidate");
  // AR-15: main is protected — the sync lands via an auto-merged PR opened
  // with the RELEASE_SYNC_TOKEN PAT (GITHUB_TOKEN-opened PRs never trigger
  // the required checks, so auto-merge would hang); any pre-sync dirtiness
  // (the transient workspace-dep rewrite) is discarded first.
  const syncStep = wf.jobs.release.steps[idx[4]]!;
  const syncRun = syncStep.run ?? "";
  expect(syncRun).toContain("git checkout --");
  expect(syncRun).toContain("gh pr create");
  expect(syncRun).toContain("--auto --squash");
  expect(syncStep.env?.GH_TOKEN ?? "").toContain("RELEASE_SYNC_TOKEN");
});

test("rewrite runs before npm package verification and after version assignment (AR-02)", () => {
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

  // CA-08 selective-publish pins are STRUCTURAL: load the pure-object config
  // instead of matching raw bytes, so a comment reflow can't break them.
  const cfg = require(path.resolve(REPO_ROOT, "release.config.cjs")) as { plugins: unknown[] };
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
  expect(npmEntries).toHaveLength(4);
  for (const entry of npmEntries) expect(opts(entry).npmPublish).toBe(false);
  // selective publish lands after the bumpers and before the GitHub
  // release/tag plugin (AR-16).
  const lastNpmIdx = cfg.plugins.reduce<number>((acc, p, i) => (isNpm(p) ? i : acc), -1);
  const publishIdx = cfg.plugins.findIndex((p) => typeof opts(p).publishCmd === "string");
  // The publisher must diff against the PREVIOUS tag: semantic-release creates
  // the new release tag before publish plugins run, so latestTag() inside the
  // script would see the release being cut and skip every package.
  expect(opts(cfg.plugins[publishIdx]).publishCmd).toContain("${lastRelease.gitTag}");
  const githubIdx = cfg.plugins.findIndex((p) => nameOf(p) === "@semantic-release/github");
  expect(publishIdx).toBeGreaterThan(lastNpmIdx);
  expect(githubIdx).toBeGreaterThan(publishIdx);
});
