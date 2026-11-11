// A bench world's workspace (#792 item 27). The runner sets WORKIT_EVAL_WORLD to
// the world it made (scaffold.ts); resolveAutonomy loads this file from a
// source checkout only (see benchWorld in packages/workit-core/src/autonomy.ts),
// so no hook bundle or installed package carries it. Any shell can set the
// variable, and TMPDIR, so the world counts only where no real workspace entry
// matches (resolveAutonomy: the D4 defaults apply there anyway), and only its
// endpoint and the grants it lowers: never a raised grant, a verification mode
// or a vcs (a forge account).
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configuredGrants,
  DEFAULT_GRANTS,
  GRANT_KINDS,
  raises,
  type Grants,
} from "../../packages/workit-core/src/autonomy";
import {
  loadWorkspacesFrom,
  type WorkspaceConfig,
} from "../../packages/workit-core/src/core/workspaces";

export const EVAL_WORLD_ENV = "WORKIT_EVAL_WORLD";
/** The file that marks a directory as a bench world. */
export const EVAL_WORLD_MARKER = ".workit-eval-world";

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * The world's `eval` entry, cut down to what may apply, when `cwd` is in a
 * marked world under the temp dir. autonomy.ts requires it by path.
 * @public
 */
export const worldEntry = (cwd: string): WorkspaceConfig | null => {
  const raw = process.env[EVAL_WORLD_ENV];
  if (!raw || !path.isAbsolute(raw)) return null;
  const world = realpathSync(raw);
  if (
    !inside(realpathSync(os.tmpdir()), world) ||
    !inside(world, realpathSync(cwd)) ||
    !existsSync(path.join(world, EVAL_WORLD_MARKER))
  )
    return null;
  const [entry] = loadWorkspacesFrom(path.join(world, "config"));
  if (!entry) return null;
  const { grants } = configuredGrants(entry);
  const lowered: Partial<Grants> = {};
  for (const kind of GRANT_KINDS) {
    const value = grants[kind];
    if (value !== undefined && raises(kind, value, DEFAULT_GRANTS[kind])) lowered[kind] = value;
  }
  return {
    name: entry.name,
    glob: entry.glob,
    ...(entry.defaultEndpoint ? { defaultEndpoint: entry.defaultEndpoint } : {}),
    autonomy: lowered,
  };
};
