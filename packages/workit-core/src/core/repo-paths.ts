// Where a clone keeps its per-clone working files (docs/agents/file-locations.md).
// A repo's `.workit/` holds only committed team config (checks.json,
// risk-paths); plans, retro reports, handoffs and notes an agent writes live
// in the store, `<git-common-dir>/workit/` (shared by every worktree of the clone,
// beside the ledger and check logs), or `<dir>/.workit` outside git.
// User-level locations (config, state, data, cache, runtime) are
// workit-paths.mjs's.
import fs from "node:fs";
import path from "node:path";
import { resolveStore } from "../store/paths";

/** The per-clone directories `workit dir <kind>` names and creates. */
export const REPO_DIR_KINDS = ["plans", "retros", "handoffs", "notes"] as const;
export type RepoDirKind = (typeof REPO_DIR_KINDS)[number];

export const isRepoDirKind = (kind: string): kind is RepoDirKind =>
  (REPO_DIR_KINDS as readonly string[]).includes(kind);

/**
 * The absolute per-clone directory of `kind` for `cwd`, created when missing,
 * or an Error when git cannot say where the store is.
 */
export function repoDir(kind: RepoDirKind, cwd: string): string | Error {
  const location = resolveStore(path.resolve(cwd));
  if (location instanceof Error) return location;
  const dir = path.join(location.dir, kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
