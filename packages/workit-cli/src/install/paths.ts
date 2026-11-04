// Where the Workit-owned CLI install lives (#648, #423). One function per kind
// of location: every reader and writer derives its paths from these, so a
// later move of the install root is a change here only.
//
//   installRoot()   <data dir>/workit: versions/<v>/, current -> versions/<v>, bin/workit
//   launcherDir()   the directory on PATH that holds the `workit` launcher link
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLI_PACKAGE_NAME = "@brainervirus/workit-cli";
/** The first line after the shebang of every launcher Workit writes. */
export const LAUNCHER_MARKER = "workit-owned-launcher";

const homeOf = (env: NodeJS.ProcessEnv): string => env.HOME || env.USERPROFILE || os.homedir();

const localAppData = (env: NodeJS.ProcessEnv): string =>
  env.LOCALAPPDATA || path.join(homeOf(env), "AppData", "Local");

/**
 * The Workit-owned install root. `WORKIT_INSTALL_ROOT` overrides it; otherwise
 * `$XDG_DATA_HOME/workit` or `~/.local/share/workit` (macOS too, like Claude
 * Code's native installer), and `%LOCALAPPDATA%\workit\install` on Windows
 * (beside the state dir, which already uses `%LOCALAPPDATA%\workit`).
 */
export const installRoot = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (env.WORKIT_INSTALL_ROOT) return env.WORKIT_INSTALL_ROOT;
  if (platform === "win32") return path.join(localAppData(env), "workit", "install");
  return path.join(env.XDG_DATA_HOME || path.join(homeOf(env), ".local", "share"), "workit");
};

/**
 * The directory on PATH where `workit` resolves to the owned launcher:
 * `WORKIT_BIN_DIR`, else `$XDG_BIN_HOME` or `~/.local/bin`; on Windows the
 * install root's own `bin` (the user adds it to PATH once).
 */
export const launcherDir = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (env.WORKIT_BIN_DIR) return env.WORKIT_BIN_DIR;
  if (platform === "win32") return path.join(installRoot(env, platform), "bin");
  return env.XDG_BIN_HOME || path.join(homeOf(env), ".local", "bin");
};

/** Every location derived from the two roots above. */
export const ownedPaths = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) => {
  const root = installRoot(env, platform);
  const win = platform === "win32";
  const name = win ? "workit.cmd" : "workit";
  return {
    root,
    versions: path.join(root, "versions"),
    current: path.join(root, "current"),
    /** The launcher Workit writes and owns. */
    launcher: path.join(root, "bin", name),
    /** What PATH finds: a link to `launcher` (the launcher itself on Windows). */
    linked: path.join(launcherDir(env, platform), name),
  };
};

export const versionDir = (root: string, version: string): string =>
  path.join(root, "versions", version);

/** The CLI package inside one `npm install --prefix <dir>` tree. */
export const packageDirOf = (prefixDir: string): string =>
  path.join(prefixDir, "node_modules", ...CLI_PACKAGE_NAME.split("/"));

export const entryOf = (prefixDir: string): string =>
  path.join(packageDirOf(prefixDir), "dist", "index.js");

/** The `@brainervirus/workit-cli` version a package directory holds, or null. */
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
