// A bench world (#792 item 27): the local bench (scripts/eval) makes a
// throwaway world under the OS temp dir, marks it and sets WORKIT_EVAL_WORLD to
// it, so a case can give the world a workspace entry. Any shell can set the
// variable (and TMPDIR), so this only finds the entry; resolveAutonomy uses it
// only where no real entry matches and keeps only its endpoint and the grants
// it lowers (autonomy.ts, benchWorld). Grants are shown from and written to
// the world's config dir (autonomy.ts grantsDir), never read from it as given.
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkspacesFrom, type WorkspaceConfig } from "./workspaces";

export const EVAL_WORLD_ENV = "WORKIT_EVAL_WORLD";
/** The file that marks a directory as a bench world. */
export const EVAL_WORLD_MARKER = ".workit-eval-world";

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** The marked world under the temp dir that WORKIT_EVAL_WORLD names and `cwd` is in, else null. */
export const evalWorld = (cwd: string): string | null => {
  const raw = process.env[EVAL_WORLD_ENV];
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    const world = realpathSync(raw);
    return inside(realpathSync(os.tmpdir()), world) &&
      inside(world, realpathSync(cwd)) &&
      existsSync(path.join(world, EVAL_WORLD_MARKER))
      ? world
      : null;
  } catch {
    return null;
  }
};

/** The first entry of the world's `config/workspaces.json` (see evalWorld), else null. */
export const evalWorldEntry = (cwd: string): WorkspaceConfig | null => {
  const world = evalWorld(cwd);
  try {
    return world ? (loadWorkspacesFrom(path.join(world, "config"))[0] ?? null) : null;
  } catch {
    return null;
  }
};
