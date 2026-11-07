#!/usr/bin/env bun
// Optional manual manifest sync. The release never runs it: since #704
// semantic-release and rewrite-workspace-deps.ts stamp the version into the
// manifests of the CI checkout at publish time, and main is not synced, so the
// committed manifests keep the version of the last manual sync. Run it in any
// PR to align every tracked manifest with the latest `workit-dev-v*` tag (or a version
// given as argv[2]); it is idempotent. plugin.test.ts reads
// SYNC_MANIFEST_PATHS to keep every plugin manifest on this list.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_TAG, TAG_GLOB } from "./analyze-release-scope";

export const SYNC_MANIFEST_PATHS = [
  "package.json",
  "packages/workit-core/package.json",
  "packages/workit-mcp/package.json",
  "packages/workit-cli/package.json",
  "packages/workit-opencode/package.json",
  "packages/workit-cursor/package.json",
  "packages/workit-codex/package.json",
  "packages/workit-pi/package.json",
  "packages/workit-claude-code/package.json",
  // Kept in lockstep with packages/workit-core/package.json by contract test.
  "packages/workit-cursor/.cursor-plugin/plugin.json",
  "packages/workit-codex/.codex-plugin/plugin.json",
  // Claude Code reads the plugin version from here (the marketplace entry
  // carries none), so it must track the published npm version.
  "packages/workit-claude-code/.claude-plugin/plugin.json",
];

export type ManifestSyncResult = { version: string; changed: string[] };

/**
 * Write `version` (a bare semver or a `workit-dev-v` release tag) into every tracked
 * manifest under `root`. Idempotent: manifests already at the target version
 * are left byte-untouched and omitted from `changed`. Throws on a value that
 * is not a plain release version (`latest`, branches, ranges).
 */
export function syncManifests(root: string, tagOrVersion: string): ManifestSyncResult {
  const value = tagOrVersion.trim();
  const version = RELEASE_TAG.exec(value)?.[1] ?? RELEASE_TAG.exec(`workit-dev-v${value}`)?.[1];
  if (!version) throw new Error(`invalid version tag: ${JSON.stringify(tagOrVersion)}`);
  const changed: string[] = [];
  for (const rel of SYNC_MANIFEST_PATHS) {
    const file = resolve(root, ...rel.split("/"));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed.version === version) continue;
    parsed.version = version;
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    changed.push(rel);
  }
  return { version, changed };
}

/** The newest release tag by descending semver refname order (none throws). */
function latestReleaseTag(cwd?: string): string {
  const tag = execFileSync("git", ["tag", "--list", TAG_GLOB, "--sort=-v:refname"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => line.trim())
    .find((line) => RELEASE_TAG.test(line));
  if (!tag)
    throw new Error(`no ${TAG_GLOB} release tag found — run after the first semantic-release`);
  return tag;
}

if (import.meta.main) {
  const root = process.argv[3]
    ? resolve(process.argv[3])
    : resolve(import.meta.dir, "..", "..", "..");
  const tag = process.argv[2] ?? latestReleaseTag(root);
  const { version, changed } = syncManifests(root, tag);
  console.log(
    changed.length > 0
      ? `synced ${changed.length} manifest(s) to ${version}: ${changed.join(", ")}`
      : `manifests already at ${version}`,
  );
}
