import { realpathSync } from "node:fs";
import path from "node:path";

/** Host-neutral checkout identity: a session only observes plugin state when
 * its directory resolves to the plugin checkout, symlinks included. */
export const sameWorkspace = (expected: string, observed: unknown): boolean => {
  if (typeof observed !== "string" || !observed) return false;
  try {
    return realpathSync(expected) === realpathSync(observed);
  } catch {
    return path.resolve(expected) === path.resolve(observed);
  }
};
