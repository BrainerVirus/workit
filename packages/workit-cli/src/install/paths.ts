// Where the Workit-owned CLI install lives (#648, #423). One function per kind
// of location: every reader and writer derives its paths from these. The two
// roots live in core/cli-locate.ts (re-exported here) so the host launchers,
// which depend on core only, locate the same install.
//
//   installRoot()   <data dir>/workit: versions/<v>/, current -> versions/<v>, bin/workit
//   launcherDir()   the directory on PATH that holds the `workit` launcher link
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { installRoot, launcherDir, ownedLauncherPath } from "@workit-dev/core/src/core/cli-locate";

export { LAUNCHER_MARKER, installRoot, launcherDir } from "@workit-dev/core/src/core/cli-locate";

export const CLI_PACKAGE_NAME = "@workit-dev/cli";

/** Every location derived from the two roots above. */
export const ownedPaths = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) => {
  const root = installRoot(env, platform);
  const launcher = ownedLauncherPath(env, platform);
  return {
    root,
    versions: path.join(root, "versions"),
    current: path.join(root, "current"),
    /** The launcher Workit writes and owns. */
    launcher,
    /** What PATH finds: a link to `launcher` (the launcher itself on Windows). */
    linked: path.join(launcherDir(env, platform), path.basename(launcher)),
  };
};

export const versionDir = (root: string, version: string): string =>
  path.join(root, "versions", version);

/** The CLI package inside one `npm install --prefix <dir>` tree. */
export const packageDirOf = (prefixDir: string): string =>
  path.join(prefixDir, "node_modules", ...CLI_PACKAGE_NAME.split("/"));

export const entryOf = (prefixDir: string): string =>
  path.join(packageDirOf(prefixDir), "dist", "index.js");

/** The `@workit-dev/cli` version a package directory holds, or null. */
export const packageVersion = (packageDir: string): string | null => {
  try {
    const found = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return found.name === CLI_PACKAGE_NAME && typeof found.version === "string"
      ? found.version
      : null;
  } catch {
    return null;
  }
};

/** The version `current` points to, or null when there is no owned install. */
export const ownedVersion = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null => packageVersion(packageDirOf(ownedPaths(env, platform).current));

export const realpathOr = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** Single-quote for a POSIX shell (the commands Workit prints). */
export const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
