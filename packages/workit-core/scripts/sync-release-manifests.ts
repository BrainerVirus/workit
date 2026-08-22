#!/usr/bin/env bun
// Post-release manifest sync (AR-15): semantic-release bumps package versions
// only inside the ephemeral CI checkout, so the committed manifests stay frozen
// while tags march on. This script aligns every tracked manifest with the
// latest released tag and is safe to re-run — a fully synced tree changes
// nothing. The workflow step wraps it with a `[skip ci]` commit so main always
// carries the released version after a release.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const SYNC_MANIFEST_PATHS = [
  "package.json",
  "packages/workit-core/package.json",
  "packages/workit-opencode/package.json",
  "packages/workit-cursor/package.json",
  "packages/workit-cli/package.json",
  // Kept in lockstep with packages/workit-core/package.json by contract test.
  "packages/workit-cursor/.cursor-plugin/plugin.json",
];

export type ManifestSyncResult = { version: string; changed: string[] };

/**
 * Write `version` (a bare semver or a leading-v git tag) into every tracked
 * manifest under `root`. Idempotent: manifests already at the target version
 * are left byte-untouched and omitted from `changed`. Throws on a value that
 * is not a plain release version (`latest`, branches, ranges).
 */
export function syncManifests(root: string, tagOrVersion: string): ManifestSyncResult {
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(tagOrVersion.trim());
  if (!match) throw new Error(`invalid version tag: ${JSON.stringify(tagOrVersion)}`);
  const version = match[1];
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

/** The newest `v*` tag by descending semver refname order (empty repo throws). */
export function latestReleaseTag(cwd?: string): string {
  const out = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tag = out[0];
  if (!tag) throw new Error("no v* release tag found — run after the first semantic-release");
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
