#!/usr/bin/env bun
// AR-16: selective publishing. Publishes only packages whose directory
// changed since the previous v* tag; logs an exact skip line per unchanged
// package so release logs answer "what shipped?" without leaving the terminal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const changed = new Set<string>(
    RELEASE_PACKAGES.filter((pkg) => {
      if (relocked.has(pkg)) return true;
      // Own directory plus any sources bundled into its dist/ (BUNDLED_SOURCES).
      const out = git(root, [
        "diff",
        "--name-only",
        `${fromTag}..HEAD`,
        "--",
        ...payloadPaths(pkg),
      ]);
      return out !== "";
    }),
  );
  // A published package depends on its internal dependencies at ^<released
  // version> (rewrite-workspace-deps), so each must ship that version too or
  // the package cannot install (#386: workit-cli 8.21.1 required an
  // unpublished workit-cursor 8.21.1).
  const queue = [...changed];
  for (let pkg = queue.pop(); pkg !== undefined; pkg = queue.pop())
    for (const dep of internalDependencies(root, pkg))
      if (!changed.has(dep)) {
        changed.add(dep);
        queue.push(dep);
      }
  return RELEASE_PACKAGES.filter((pkg) => changed.has(pkg));
}

/** The release packages `pkg` declares as runtime dependencies at HEAD. */
const internalDependencies = (root: string, pkg: string): string[] => {
  const manifest = JSON.parse(git(root, ["show", `HEAD:packages/${pkg}/package.json`])) as {
    dependencies?: Record<string, string>;
  };
  return RELEASE_PACKAGES.filter(
    (other) => manifest.dependencies?.[`@brainervirus/${other}`] !== undefined,
  );
};

type Run = (cmd: string, args: string[], o: { cwd: string }) => unknown;

const RETRY_PAUSE_MS = 10_000;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// npm view prints the version only when that exact version is on the registry.
const onRegistry = (run: Run, cwd: string, spec: string, version: string): boolean => {
  try {
    return String(run("npm", ["view", spec, "version"], { cwd }) ?? "").trim() === version;
  } catch {
    return false;
  }
};

/**
 * Publishes one package. A failed `npm publish` is checked against the
 * registry first (a publish can land and still report an error), then retried
 * once in a fresh process: v8.41.0 lost workit-core to a transient sigstore
 * `TLOG_CREATE_ENTRY_ERROR` (409, "an equivalent entry already exists").
 * Returns how it ended up on the registry; throws the last error otherwise.
 */
function publishOne(run: Run, cwd: string, pause: (ms: number) => void): "published" | "present" {
  const manifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const spec = `${manifest.name}@${manifest.version}`;
  const publish = () => run("npm", ["publish", "--access", "public"], { cwd });
  try {
    publish();
    return "published";
  } catch (first) {
    console.log(`publish of ${spec} failed: ${message(first)}; checking the registry`);
    if (onRegistry(run, cwd, spec, manifest.version)) return "present";
    console.log(`${spec} is not on the registry; retrying the publish once`);
    pause(RETRY_PAUSE_MS);
    try {
      publish();
      return "published";
    } catch (second) {
      if (onRegistry(run, cwd, spec, manifest.version)) return "present";
      throw second;
    }
  }
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
  run?: Run;
  /** Wait before the single publish retry. Default: a blocking sleep. */
  pause?: (ms: number) => void;
}): { published: string[]; skipped: string[]; tag: string | null } {
  const { root, dryRun = false } = opts;
  // stdout is captured so `npm view` can be read; stderr (npm's progress and
  // errors) stays on the release log.
  const run =
    opts.run ??
    ((cmd: string, args: string[], o: { cwd: string }) => {
      const out = execFileSync(cmd, args, {
        cwd: o.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      if (args[0] !== "view") process.stdout.write(out);
      return out;
    });
  const pause = opts.pause ?? ((ms: number) => Bun.sleepSync(ms));
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
    let outcome: "published" | "present" = "published";
    try {
      if (!dryRun) outcome = publishOne(run, cwd, pause);
    } catch (e) {
      const error = message(e);
      failed.push({ pkg, error });
      console.log(`publish failed ${pkg}: ${error}`);
      continue;
    }
    published.push(pkg);
    console.log(
      outcome === "present"
        ? `published ${pkg} @ ${cwd} (already on the registry)`
        : `published ${pkg} @ ${cwd}`,
    );
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
