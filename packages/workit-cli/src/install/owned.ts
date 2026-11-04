// The Workit-owned CLI install: `npm install --prefix <staging>` with a
// resolved Node >= 24's own npm, a rename into versions/<v>, then an atomic
// swap of the `current` link. A run killed at any point before the swap
// leaves `current` (and so the launcher) on the previous version.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { launcherCmd, launcherScript } from "./launcher";
import { type InstallNode } from "./node";
import {
  CLI_PACKAGE_NAME,
  LAUNCHER_MARKER,
  ownedPaths,
  packageDirOf,
  packageVersion,
  realpathOr,
  versionDir,
} from "./paths";

export type InstallRun = (
  command: string,
  args: string[],
) => Promise<{ status: number | null; stdout: string; stderr?: string }>;

export type InstallContext = {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  node: InstallNode;
  run: InstallRun;
};

/** Staging directories start with this; anything left by a killed run is removed next time. */
const STAGING = ".staging-";
/** Versions kept besides `current`: the previous one, for a hand rollback. */
const KEEP_PREVIOUS = 1;

/** Write `file` through a temp file and a rename, so a reader never sees half a launcher. */
const writeAtomic = (file: string, content: string, mode: number): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, file);
};

/** True when `file` is a launcher Workit wrote (its marker line). */
export const isOwnedLauncher = (file: string): boolean => {
  try {
    return readFileSync(file, "utf8").slice(0, 400).includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
};

/**
 * Point `current` at versions/<version>: a new link beside it renamed over it
 * (atomic on POSIX). Windows uses a junction; rename cannot replace one, so it
 * is removed first (the only non-atomic moment, recorded in install.md).
 */
const swapCurrent = (
  env: NodeJS.ProcessEnv,
  version: string,
  platform: NodeJS.Platform = process.platform,
): void => {
  const paths = ownedPaths(env, platform);
  const temp = path.join(paths.root, `.current-${process.pid}`);
  rmSync(temp, { force: true, recursive: true });
  if (platform === "win32") {
    symlinkSync(versionDir(paths.root, version), temp, "junction");
    try {
      unlinkSync(paths.current);
    } catch {
      rmSync(paths.current, { force: true, recursive: false });
    }
  } else symlinkSync(path.join("versions", version), temp, "dir");
  renameSync(temp, paths.current);
};

/**
 * Write the owned launcher and, on POSIX, link the PATH launcher to it. A
 * foreign file already at the PATH location (a hand-written wrapper) is left
 * alone and returned: migration backs it up first.
 */
export const writeLaunchers = (context: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  installNode: string;
}): { launcher: string; linked: string; foreign: string | null } => {
  const platform = context.platform ?? process.platform;
  const paths = ownedPaths(context.env, platform);
  const content =
    platform === "win32"
      ? launcherCmd({ root: paths.root, installNode: context.installNode })
      : launcherScript({ root: paths.root, installNode: context.installNode, platform });
  writeAtomic(paths.launcher, content, 0o755);
  if (paths.linked === paths.launcher) return { ...paths, foreign: null };
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(paths.linked);
  } catch {
    existing = null;
  }
  if (existing && !existing.isSymbolicLink() && !isOwnedLauncher(paths.linked))
    return { launcher: paths.launcher, linked: paths.linked, foreign: paths.linked };
  if (existing?.isSymbolicLink() && readlinkSync(paths.linked) === paths.launcher)
    return { launcher: paths.launcher, linked: paths.linked, foreign: null };
  if (existing?.isSymbolicLink() && realpathOr(paths.linked) !== realpathOr(paths.launcher))
    // A link to another workit (an npm global bin): a copy for migration to record.
    return { launcher: paths.launcher, linked: paths.linked, foreign: paths.linked };
  linkLauncher(paths.launcher, paths.linked);
  return { launcher: paths.launcher, linked: paths.linked, foreign: null };
};

/** Replace `linked` with a link to `launcher` (a temp link renamed over it). */
export const linkLauncher = (launcher: string, linked: string): void => {
  mkdirSync(path.dirname(linked), { recursive: true });
  const temp = `${linked}.${process.pid}.link`;
  rmSync(temp, { force: true });
  symlinkSync(launcher, temp);
  renameSync(temp, linked);
};

const removeStaleStaging = (versions: string): void => {
  let names: string[] = [];
  try {
    names = readdirSync(versions);
  } catch {
    return;
  }
  for (const name of names)
    if (name.startsWith(STAGING) || name.startsWith(".old-"))
      rmSync(path.join(versions, name), { recursive: true, force: true });
};

/** Old versions beyond `current` and the one before it. */
const pruneVersions = (versions: string, keep: string[]): void => {
  let names: string[] = [];
  try {
    names = readdirSync(versions).filter((name) => /^\d+\.\d+\.\d+/.test(name));
  } catch {
    return;
  }
  for (const name of names)
    if (!keep.includes(name)) rmSync(path.join(versions, name), { recursive: true, force: true });
};

export type InstallResult =
  | { ok: true; dir: string; previous: string | null }
  | { ok: false; reason: string; previous: string | null };

/**
 * Install `version` under the owned root and make it current. Fails without
 * touching `current` when npm fails or the staged package is not `version`.
 */
export const installOwned = async (
  version: string,
  context: InstallContext,
): Promise<InstallResult> => {
  const platform = context.platform ?? process.platform;
  const paths = ownedPaths(context.env, platform);
  const previous = packageVersion(packageDirOf(paths.current));
  mkdirSync(paths.versions, { recursive: true });
  removeStaleStaging(paths.versions);
  const staging = path.join(paths.versions, `${STAGING}${version}-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  const install = await context.run(context.node.node, [
    context.node.npmCli,
    "install",
    "--prefix",
    staging,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    `${CLI_PACKAGE_NAME}@${version}`,
  ]);
  const staged = packageVersion(packageDirOf(staging));
  if (install.status !== 0 || staged !== version) {
    rmSync(staging, { recursive: true, force: true });
    const tail = (install.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
    return {
      ok: false,
      previous,
      reason:
        install.status !== 0
          ? `npm install of ${CLI_PACKAGE_NAME}@${version} failed${tail ? ` (${tail})` : ""}`
          : `npm installed ${staged ?? "no package"}, not ${version}`,
    };
  }
  const dir = versionDir(paths.root, version);
  if (existsSync(dir)) renameSync(dir, path.join(paths.versions, `.old-${version}-${process.pid}`));
  renameSync(staging, dir);
  swapCurrent(context.env, version, platform);
  removeStaleStaging(paths.versions);
  pruneVersions(
    paths.versions,
    [version, previous].filter((one): one is string => Boolean(one)).slice(0, 1 + KEEP_PREVIOUS),
  );
  return { ok: true, dir, previous };
};

/** Remove a file or link, never a directory (the wrapper Workit replaces). */
export const removeFile = (file: string): void => {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
};
