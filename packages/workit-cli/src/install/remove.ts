// Removing the Workit-owned CLI install (W2.32): the launcher link on PATH,
// the owned launcher and its bin/, the `current` link and versions/. Only the
// exact paths ownedPaths() derives are ever touched; a file at the launcher's
// place that does not point into the owned install is foreign and stays.
import { lstatSync, readdirSync, readlinkSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isOwnedLauncher } from "./owned";
import { ownedPaths, realpathOr } from "./paths";

/** One part of the owned install, removed in this order. */
export type OwnedPart = "link" | "launcher" | "current" | "versions";

export type OwnedRemoval =
  | { kind: "remove"; part: OwnedPart; path: string; detail: string }
  | { kind: "foreign"; path: string; detail: string };

export const FOREIGN_LAUNCHER_NOTE =
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

/** The removal steps for the owned install under `env`; empty when there is none. */
export const planOwnedRemoval = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): OwnedRemoval[] => {
  const paths = ownedPaths(env, platform);
  const steps: OwnedRemoval[] = [];
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
  if (lstatOr(bin))
    steps.push({
      kind: "remove",
      part: "launcher",
      path: bin,
      detail:
        platform === "win32"
          ? "remove the Workit launcher (bin\\workit.cmd); drop its directory from your PATH"
          : "remove the Workit launcher (bin/workit)",
    });
  if (lstatOr(paths.current))
    steps.push({
      kind: "remove",
      part: "current",
      path: paths.current,
      detail: "remove the current-version link",
    });
  if (lstatOr(paths.versions))
    steps.push({
      kind: "remove",
      part: "versions",
      path: paths.versions,
      detail: "remove the installed CLI versions",
    });
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
  if (!lstatOr(step.path)) return { status: "skipped", detail: "already absent" };
  try {
    switch (step.part) {
      case "link": {
        if (paths.linked === paths.launcher || launcherPlace(paths.linked, paths.root) !== "owned")
          return { status: "skipped", detail: FOREIGN_LAUNCHER_NOTE };
        unlinkSync(paths.linked);
        break;
      }
      case "launcher": {
        // bin/ holds the launcher and its own temp files; anything else keeps the dir.
        const base = path.basename(paths.launcher);
        const others = readdirSync(step.path).filter((name) => !name.startsWith(base));
        for (const name of readdirSync(step.path))
          if (name.startsWith(base)) rmSync(path.join(step.path, name), { force: true });
        if (others.length)
          return {
            status: "removed",
            detail: `launcher removed; ${step.path} kept (holds ${others.join(", ")})`,
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
      case "versions":
        rmSync(step.path, { recursive: true, force: true });
        break;
    }
  } catch (error) {
    return { status: "failed", detail: errorText(error) };
  }
  return { status: "removed" };
};
