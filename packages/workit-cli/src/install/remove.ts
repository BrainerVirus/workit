// Removing the Workit-owned CLI install (W2.32): the launcher link on PATH,
// the owned launcher and its bin/, the `current` link and versions/. Only the
// exact paths ownedPaths() derives are ever touched; a file at the launcher's
// place that does not point into the owned install is foreign and stays.
import { lstatSync, readdirSync, readlinkSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isOwnedLauncher } from "./owned";
import { ownedPaths, packageDirOf, packageVersion, realpathOr } from "./paths";

/** One part of the owned install, removed in this order. */
export type OwnedPart = "link" | "launcher" | "current" | "versions";

export type OwnedRemoval =
  | { kind: "remove"; part: OwnedPart; path: string; detail: string }
  | { kind: "foreign"; path: string; detail: string };

const FOREIGN_LAUNCHER_NOTE =
  "foreign file at the launcher path, left untouched; move it to let the launcher link there";

const lstatOr = (file: string) => {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
};

const inside = (file: string, root: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * What sits at the PATH launcher place: nothing, a link (or a launcher Workit
 * wrote) into the owned install, or anything else (foreign).
 */
const launcherPlace = (linked: string, root: string): "none" | "owned" | "foreign" => {
  const stat = lstatOr(linked);
  if (!stat) return "none";
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = path.resolve(path.dirname(linked), readlinkSync(linked));
    } catch {
      return "foreign";
    }
    return inside(target, root) || inside(realpathOr(linked), realpathOr(root))
      ? "owned"
      : "foreign";
  }
  return stat.isFile() && isOwnedLauncher(linked) ? "owned" : "foreign";
};

/**
 * Why `root` must never be removed from: a filesystem root, the home dir or
 * an ancestor of it (WORKIT_INSTALL_ROOT is taken verbatim); null when safe.
 */
const unsafeRoot = (root: string, env: NodeJS.ProcessEnv): string | null => {
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved) return "a filesystem root";
  const home = env.HOME || env.USERPROFILE;
  if (!home) return null;
  for (const [mine, theirs] of [
    [resolved, path.resolve(home)],
    [realpathOr(resolved), realpathOr(home)],
  ]) {
    const relative = path.relative(mine, theirs);
    if (relative === "") return "your home directory";
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      return "an ancestor of your home directory";
  }
  return null;
};

const linkOnly = (dir: string) => `${dir} is a link; remove the link only, never what it points to`;

const rootRefusal = (root: string, why: string) =>
  `install root ${root} is ${why}; nothing under it is removed (check WORKIT_INSTALL_ROOT)`;

/** The launcher's own temp files: `<launcher>.<pid>.tmp` (owned.ts writeAtomic). */
const isLauncherTemp = (name: string, base: string): boolean =>
  name.startsWith(`${base}.`) && /^\.\d+\.tmp$/.test(name.slice(base.length));

/** A versions/ entry Workit installed: it holds the workit-cli package. */
const isWorkitVersion = (dir: string): boolean => packageVersion(packageDirOf(dir)) !== null;

const listOr = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** bin/'s entries other than the launcher and its own temp files: they keep the directory. */
const binOthers = (bin: string, launcher: string): string[] => {
  const base = path.basename(launcher);
  return listOr(bin).filter(
    (name) =>
      name !== base && !(isLauncherTemp(name, base) && lstatOr(path.join(bin, name))?.isFile()),
  );
};

/** versions/ entries that are not a Workit install: they keep the directory. */
const foreignVersions = (versions: string): string[] =>
  listOr(versions).filter((name) => {
    const entry = path.join(versions, name);
    return !lstatOr(entry)?.isDirectory() || !isWorkitVersion(entry);
  });

// One wording for what stays, shared by the plan row and the apply line.
const binKept = (bin: string, others: string[]) => `${bin} kept (holds ${others.join(", ")})`;
const versionsKept = (versions: string, kept: string[]) =>
  `${versions} kept (not Workit installs: ${kept.join(", ")})`;
const noLauncher = (bin: string, others: string[]) =>
  `no Workit launcher in it; ${binKept(bin, others)}`;
const noVersion = (versions: string, kept: string[]) =>
  `no Workit version in it; ${versionsKept(versions, kept)}`;

/** The removal steps for the owned install under `env`; empty when there is none. */
export const planOwnedRemoval = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): OwnedRemoval[] => {
  const paths = ownedPaths(env, platform);
  const steps: OwnedRemoval[] = [];
  const unsafe = unsafeRoot(paths.root, env);
  if (unsafe) {
    const present = [paths.current, paths.versions, path.dirname(paths.launcher)].some(lstatOr);
    return present
      ? [{ kind: "foreign", path: paths.root, detail: rootRefusal(paths.root, unsafe) }]
      : [];
  }
  if (paths.linked !== paths.launcher) {
    const place = launcherPlace(paths.linked, paths.root);
    if (place === "owned")
      steps.push({
        kind: "remove",
        part: "link",
        path: paths.linked,
        detail: "remove the workit launcher link on PATH",
      });
    else if (place === "foreign")
      steps.push({ kind: "foreign", path: paths.linked, detail: FOREIGN_LAUNCHER_NOTE });
  }
  const bin = path.dirname(paths.launcher);
  const binStat = lstatOr(bin);
  const launcherStat = binStat && !binStat.isSymbolicLink() ? lstatOr(paths.launcher) : null;
  if (launcherStat && !(launcherStat.isFile() && isOwnedLauncher(paths.launcher)))
    steps.push({
      kind: "foreign",
      path: paths.launcher,
      detail: "not a launcher Workit wrote, left untouched",
    });
  else if (binStat?.isSymbolicLink())
    steps.push({
      kind: "remove",
      part: "launcher",
      path: bin,
      detail: linkOnly(bin),
    });
  else if (binStat) {
    const others = binOthers(bin, paths.launcher);
    const launcher =
      platform === "win32"
        ? "remove the Workit launcher (bin\\workit.cmd); drop its directory from your PATH"
        : "remove the Workit launcher (bin/workit)";
    if (!launcherStat && others.length > 0)
      steps.push({
        kind: "foreign",
        path: bin,
        detail: noLauncher(bin, others),
      });
    else
      steps.push({
        kind: "remove",
        part: "launcher",
        path: bin,
        detail: others.length > 0 ? `${launcher}; ${binKept(bin, others)}` : launcher,
      });
  }
  if (lstatOr(paths.current))
    steps.push({
      kind: "remove",
      part: "current",
      path: paths.current,
      detail: "remove the current-version link",
    });
  const versionsStat = lstatOr(paths.versions);
  if (versionsStat?.isSymbolicLink())
    steps.push({
      kind: "remove",
      part: "versions",
      path: paths.versions,
      detail: linkOnly(paths.versions),
    });
  else if (versionsStat) {
    const kept = foreignVersions(paths.versions);
    const all = listOr(paths.versions);
    const versions =
      "remove the installed CLI versions (only entries holding the workit-cli package)";
    if (kept.length > 0 && kept.length === all.length)
      steps.push({
        kind: "foreign",
        path: paths.versions,
        detail: noVersion(paths.versions, kept),
      });
    else
      steps.push({
        kind: "remove",
        part: "versions",
        path: paths.versions,
        detail: kept.length > 0 ? `${versions}; ${versionsKept(paths.versions, kept)}` : versions,
      });
  }
  return steps;
};

export type OwnedRemovalOutcome = { status: "removed" | "skipped" | "failed"; detail?: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Remove one planned part, after checking its path is still the one
 * ownedPaths() derives (a tampered plan removes nothing) and, for the link,
 * that it still points into the owned install.
 */
export const applyOwnedRemoval = (
  step: { part: OwnedPart; path: string },
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): OwnedRemovalOutcome => {
  const paths = ownedPaths(env, platform);
  const expected: Record<OwnedPart, string> = {
    link: paths.linked,
    launcher: path.dirname(paths.launcher),
    current: paths.current,
    versions: paths.versions,
  };
  if (path.resolve(step.path) !== path.resolve(expected[step.part]))
    return { status: "failed", detail: `refusing to remove ${step.path}: not the owned install` };
  const unsafe = unsafeRoot(paths.root, env);
  if (unsafe) return { status: "failed", detail: rootRefusal(paths.root, unsafe) };
  const stat = lstatOr(step.path);
  if (!stat) return { status: "skipped", detail: "already absent" };
  // bin/ or versions/ as a link (or junction): remove the link, never what it points to.
  if ((step.part === "launcher" || step.part === "versions") && stat.isSymbolicLink()) {
    try {
      unlinkSync(step.path);
    } catch (error) {
      return { status: "failed", detail: errorText(error) };
    }
    return { status: "removed", detail: `${step.path} was a link; removed the link only` };
  }
  try {
    switch (step.part) {
      case "link": {
        if (paths.linked === paths.launcher || launcherPlace(paths.linked, paths.root) !== "owned")
          return { status: "skipped", detail: FOREIGN_LAUNCHER_NOTE };
        unlinkSync(paths.linked);
        break;
      }
      case "launcher": {
        // Only the launcher Workit wrote and its own temp files; anything else keeps the dir.
        const base = path.basename(paths.launcher);
        const launcher = lstatOr(paths.launcher);
        const ours = launcher?.isFile() && isOwnedLauncher(paths.launcher);
        if (launcher && !ours)
          return {
            status: "skipped",
            detail: `${paths.launcher} is not a launcher Workit wrote, left untouched`,
          };
        const others = binOthers(step.path, paths.launcher);
        if (!launcher && others.length > 0)
          return { status: "skipped", detail: noLauncher(step.path, others) };
        if (ours) unlinkSync(paths.launcher);
        for (const name of readdirSync(step.path))
          if (isLauncherTemp(name, base) && lstatOr(path.join(step.path, name))?.isFile())
            unlinkSync(path.join(step.path, name));
        if (others.length)
          return {
            status: "removed",
            detail: `launcher removed; ${binKept(step.path, others)}`,
          };
        rmdirSync(step.path);
        break;
      }
      case "current": {
        // A symlink on POSIX, a junction on Windows: remove the link, never its target.
        try {
          unlinkSync(step.path);
        } catch {
          rmdirSync(step.path);
        }
        break;
      }
      case "versions": {
        const kept = foreignVersions(step.path);
        const foreign = new Set(kept);
        const ours = readdirSync(step.path).filter((name) => !foreign.has(name));
        if (kept.length > 0 && ours.length === 0)
          return { status: "skipped", detail: noVersion(step.path, kept) };
        for (const name of ours)
          rmSync(path.join(step.path, name), { recursive: true, force: true });
        if (kept.length)
          return {
            status: "removed",
            detail: `Workit versions removed; ${versionsKept(step.path, kept)}`,
          };
        rmdirSync(step.path);
        break;
      }
    }
  } catch (error) {
    return { status: "failed", detail: errorText(error) };
  }
  return { status: "removed" };
};
