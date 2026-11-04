// Which `workit` CLI a host launcher hands its agent (#648). The host
// launchers (Codex hooks and MCP, Cursor hooks, the OpenCode plugin, the Pi
// extension) run bundled code, but the agent's shell runs `workit` from PATH,
// where a stale global install can sit ahead of the Workit-owned launcher.
// Order: the owned launcher (<install root>/bin/workit), else the owned
// `current` entry, else a bundled CLI the caller names, else plain `workit`
// from PATH (setups older than the owned install; `workit doctor` row
// cli_installs names the fix).
//
// Dependency-light on purpose (node: builtins only): the Codex hook launcher
// loads it on every tool call before the runtime. installRoot/launcherDir are
// the one copy: packages/workit-cli/src/install/paths.ts (the writer) re-exports them.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { dataDir, userHome } from "./workit-paths.mjs";

/** The first line after the shebang of every launcher Workit writes. */
export const LAUNCHER_MARKER = "workit-owned-launcher";
const CLI_PACKAGE_PATH = ["node_modules", "@brainervirus", "workit-cli"];

/**
 * The Workit-owned install root: `WORKIT_INSTALL_ROOT`, else the data dir
 * (core/workit-paths.mjs: `$XDG_DATA_HOME/workit` or `~/.local/share/workit`),
 * and `<data dir>\\install` on Windows (`%LOCALAPPDATA%\\workit\\install`).
 */
export const installRoot = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (env.WORKIT_INSTALL_ROOT) return env.WORKIT_INSTALL_ROOT;
  const data = dataDir(env, platform);
  return platform === "win32" ? path.join(data, "install") : data;
};

/** The directory on PATH that holds the `workit` link to the owned launcher. */
export const launcherDir = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (env.WORKIT_BIN_DIR) return env.WORKIT_BIN_DIR;
  if (platform === "win32") return path.join(installRoot(env, platform), "bin");
  return env.XDG_BIN_HOME || path.join(userHome(env), ".local", "bin");
};

/** The launcher Workit writes and owns: <install root>/bin/workit (workit.cmd on Windows). */
export const ownedLauncherPath = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string =>
  path.join(installRoot(env, platform), "bin", platform === "win32" ? "workit.cmd" : "workit");

/** The CLI entry inside the owned `current` install. */
export const ownedCurrentEntry = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string =>
  path.join(installRoot(env, platform), "current", ...CLI_PACKAGE_PATH, "dist", "index.js");

/** The first bytes of a file, or "" when it cannot be read. */
const head = (file: string): string => {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

export type CliSource = "owned-launcher" | "owned-current" | "bundled" | "path";

export interface LocatedCli {
  source: CliSource;
  /** What to spawn. */
  command: string;
  /** Arguments before the workit verb (the entry script when command is a node). */
  args: string[];
  /** A directory whose `workit` is this CLI, to put first on PATH; null when none. */
  binDir: string | null;
}

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** A CLI entry script the host package ships, tried after the owned install. */
  bundled?: string | null;
  /** The node that runs an entry script (default: this process's). */
  node?: string;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
}

/** The workit CLI a host launcher should hand its agent; never a PATH lookup unless nothing owned or bundled exists. */
export const locateWorkitCli = (options: LocateOptions = {}): LocatedCli => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const read = options.read ?? head;
  const node = options.node ?? process.execPath;
  const launcher = ownedLauncherPath(env, platform);
  if (exists(launcher) && read(launcher).includes(LAUNCHER_MARKER))
    return {
      source: "owned-launcher",
      command: launcher,
      args: [],
      binDir: path.dirname(launcher),
    };
  const current = ownedCurrentEntry(env, platform);
  if (exists(current))
    return {
      source: "owned-current",
      command: node,
      args: [current],
      binDir: null,
    };
  if (options.bundled && exists(options.bundled))
    return {
      source: "bundled",
      command: node,
      args: [options.bundled],
      binDir: null,
    };
  return { source: "path", command: "workit", args: [], binDir: null };
};

/** The env key that holds PATH (Windows keeps `Path`). */
const pathKey = (env: NodeJS.ProcessEnv): string =>
  Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

/**
 * The env changes that make a shell started from `env` run the located CLI
 * as `workit`: its bin dir first on PATH (moved there when already present)
 * and WORKIT_CLI naming it. Empty when the CLI comes from PATH anyway.
 */
export const workitCliEnv = (
  located: LocatedCli,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> => {
  if (located.source === "path") return {};
  const patch: Record<string, string> = {
    WORKIT_CLI: [located.command, ...located.args].join(" "),
  };
  if (located.binDir) {
    const key = pathKey(env);
    const delimiter = platform === "win32" ? ";" : ":";
    const same = (dir: string) =>
      platform === "win32"
        ? path.win32.normalize(dir).toLowerCase() ===
          path.win32.normalize(located.binDir!).toLowerCase()
        : path.posix.normalize(dir) === path.posix.normalize(located.binDir!);
    const rest = (env[key] ?? "").split(delimiter).filter((dir) => dir && !same(dir));
    patch[key] = [located.binDir, ...rest].join(delimiter);
  }
  return patch;
};

/**
 * Locate the CLI and apply its env changes to `env` (process.env by default),
 * so this process and every shell it starts runs the owned `workit`.
 */
export const useOwnedWorkitCli = (
  options: LocateOptions & { env?: NodeJS.ProcessEnv } = {},
): LocatedCli => {
  const env = options.env ?? process.env;
  const located = locateWorkitCli({ ...options, env });
  Object.assign(env, workitCliEnv(located, env, options.platform));
  return located;
};
