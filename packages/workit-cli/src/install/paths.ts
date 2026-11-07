// Where the Workit-owned CLI install lives (#648, #423). One function per kind
// of location: every reader and writer derives its paths from these. The two
// roots live in core/cli-locate.ts (re-exported here) so the host launchers,
// which depend on core only, locate the same install.
//
//   installRoot()   <data dir>/workit: versions/<v>/, current -> versions/<v>, bin/workit
//   launcherDir()   the directory on PATH that holds the `workit` launcher link
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  installRoot,
  launcherDir,
  ownedLauncherPath,
} from "@brainervirus/workit-core/src/core/cli-locate";

export {
  LAUNCHER_MARKER,
  installRoot,
  launcherDir,
} from "@brainervirus/workit-core/src/core/cli-locate";

export const CLI_PACKAGE_NAME = "@brainervirus/workit-cli";
/** The CLI's package on the new npm scope (the 14.x bridge migrates to it). */
export const NEW_CLI_PACKAGE_NAME = "@workit-dev/cli";
/** Every name a Workit CLI package has carried. */
export const CLI_PACKAGE_NAMES = [CLI_PACKAGE_NAME, NEW_CLI_PACKAGE_NAME] as const;

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
export const packageDirOf = (prefixDir: string, name: string = CLI_PACKAGE_NAME): string =>
  path.join(prefixDir, "node_modules", ...name.split("/"));

export const entryOf = (prefixDir: string, name: string = CLI_PACKAGE_NAME): string =>
  path.join(packageDirOf(prefixDir, name), "dist", "index.js");

/** The `name` package version a package directory holds, or null. */
export const packageVersion = (
  packageDir: string,
  name: string = CLI_PACKAGE_NAME,
): string | null => {
  try {
    const found = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return found.name === name && typeof found.version === "string" ? found.version : null;
  } catch {
    return null;
  }
};

/** The Workit CLI package (either scope) one `npm install --prefix <dir>` tree holds, or null. */
export const prefixPackage = (prefixDir: string): { name: string; version: string } | null => {
  for (const name of CLI_PACKAGE_NAMES) {
    const version = packageVersion(packageDirOf(prefixDir, name), name);
    if (version) return { name, version };
  }
  return null;
};

/** The version `current` points to, or null when there is no owned install on this scope. */
export const ownedVersion = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null => packageVersion(packageDirOf(ownedPaths(env, platform).current));

/** The package and version `current` points to, on either scope, or null. */
export const ownedPackage = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { name: string; version: string } | null => prefixPackage(ownedPaths(env, platform).current);

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
