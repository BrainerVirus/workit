#!/usr/bin/env bun
// AR-16: selective publishing. Publishes only packages whose directory
// changed since the previous v* tag; logs an exact skip line per unchanged
// package so release logs answer "what shipped?" without leaving the terminal.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  latestTag,
  lockChangedPackages,
  payloadPaths,
  RELEASE_PACKAGES,
} from "./analyze-release-scope";

const git = (root: string, args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function changedPackages(root: string, fromTag: string): string[] {
  // Committed state only: <tag>..HEAD, never the working tree — unreviewed
  // local edits must not decide what ships.
  // Plus packages whose inlined third-party deps resolve differently in the
  // lockfile (BUNDLED_DEPS); a dev-tooling-only lockfile bump changes none.
  const relocked = new Set<string>(lockChangedPackages(root, fromTag, "HEAD"));
  return RELEASE_PACKAGES.filter((pkg) => {
    if (relocked.has(pkg)) return true;
    // Own directory plus any sources bundled into its dist/ (BUNDLED_SOURCES).
    const out = git(root, ["diff", "--name-only", `${fromTag}..HEAD`, "--", ...payloadPaths(pkg)]);
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
  // First-ever release: everything ships.
  const changed =
    tag === null ? new Set<string>(RELEASE_PACKAGES) : new Set(changedPackages(root, tag));
  const published: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ pkg: string; error: string }> = [];
  // Every changed package is attempted even after a failure: one package that
  // cannot publish (e.g. a first publish of a new npm name the token does not
  // cover) must not leave the others unreleased. Failures throw at the end.
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
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ pkg, error });
      console.log(`publish failed ${pkg}: ${error}`);
      continue;
    }
    published.push(pkg);
    console.log(`published ${pkg} @ ${cwd}`);
  }
  if (failed.length > 0) {
    const summary = `publish failed for ${failed.length} package(s): ${failed.map((f) => f.pkg).join(", ")}; published: ${published.join(", ") || "none"}. A first publish of a new @brainervirus package needs an npm token allowed to create packages in the scope.`;
    console.log(summary);
    throw new Error(summary);
  }
  return { published, skipped, tag };
}

// @semantic-release/exec spawns this Cmd as a shell string whose ONLY optional
// positional arg is rendered from ${lastRelease.gitTag}: present when a
// previous release exists, absent on a first-ever release. The repo root is
// always the spawn cwd (release.config.cjs paths are repo-root-relative), so
// the CLI takes no root argument.
if (import.meta.main) {
  publishChanged({
    root: process.cwd(),
    dryRun: process.env.PUBLISH_DRY_RUN === "1",
    ...(process.argv[2] !== undefined ? { fromTag: process.argv[2] } : {}),
  });
}
