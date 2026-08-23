#!/usr/bin/env bun
// AR-16: selective publishing. Publishes only packages whose directory
// changed since the previous v* tag; logs an exact skip line per unchanged
// package so release logs answer "what shipped?" without leaving the terminal.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { latestTag, RELEASE_PACKAGES } from "./analyze-release-scope";

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function changedPackages(root: string, fromTag: string): string[] {
  // Committed state only: <tag>..HEAD, never the working tree — unreviewed
  // local edits must not decide what ships.
  return RELEASE_PACKAGES.filter((pkg) => {
    const out = git(root, ["diff", "--name-only", `${fromTag}..HEAD`, "--", `packages/${pkg}`]);
    return out !== "";
  });
}

export function publishChanged(opts: {
  root: string;
  dryRun?: boolean;
  /**
   * Base tag to diff against. Empty string means first-ever release (ship
   * all). Default: latestTag(root). semantic-release creates the NEW release
   * tag before publish plugins run, so production passes the PREVIOUS tag via
   * `${lastRelease.gitTag}` — diffing against latestTag() there is always
   * empty and would skip every package.
   */
  fromTag?: string;
  run?: (cmd: string, args: string[], o: { cwd: string }) => unknown;
}): { published: string[]; skipped: string[]; tag: string | null } {
  const { root, dryRun = false } = opts;
  const run =
    opts.run ??
    ((cmd: string, args: string[], o: { cwd: string }) =>
      execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8", stdio: "inherit" }));
  const tag =
    opts.fromTag !== undefined ? (opts.fromTag === "" ? null : opts.fromTag) : latestTag(root);
  if (tag === null) {
    // First-ever release: everything ships.
    const published: string[] = [];
    for (const pkg of RELEASE_PACKAGES) {
      const cwd = resolve(root, "packages", pkg);
      if (!dryRun) run("npm", ["publish", "--access", "public"], { cwd });
      published.push(pkg);
      console.log(`published ${pkg} @ ${cwd}`);
    }
    return { published, skipped: [], tag: null };
  }
  const changed = new Set(changedPackages(root, tag));
  const published: string[] = [];
  const skipped: string[] = [];
  for (const pkg of RELEASE_PACKAGES) {
    if (!changed.has(pkg)) {
      skipped.push(pkg);
      console.log(`skip ${pkg} (no payload change since ${tag})`);
      continue;
    }
    const cwd = resolve(root, "packages", pkg);
    try {
      if (!dryRun) run("npm", ["publish", "--access", "public"], { cwd });
    } catch (e) {
      console.log(`publish failed ${pkg}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    published.push(pkg);
    console.log(`published ${pkg} @ ${cwd}`);
  }
  return { published, skipped, tag };
}

if (import.meta.main) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const fromTag = process.argv[3];
  publishChanged({
    root,
    dryRun: process.env.PUBLISH_DRY_RUN === "1",
    ...(fromTag !== undefined ? { fromTag } : {}),
  });
}
