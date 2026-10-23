// The default base for patch-ids, author trailers and review lanes. Its own
// module so the lane (core/policy/lane.ts) and the ledger can both read it
// without importing each other.
import { vcsConfig } from "../core/vcs-config";
import { originHeadRef, resolveRef } from "./rev";

const safeRef = (value: string): boolean => value.length > 0 && !value.startsWith("-");

/**
 * The PR target of the release track the checkout is on, when the workspace
 * configures tracks (as `fanout plan` and `stack plan` pick their trunk); a
 * plain workspace default does not override origin's default branch.
 */
const trackTrunk = (cwd: string): string | null => {
  try {
    const resolved = vcsConfig("resolve", cwd);
    if (resolved.ok === false || !resolved.releaseTrack || resolved.releaseTrack.blocking)
      return null;
    const target = String(resolved.defaultTargetBranch ?? "").trim();
    return target && safeRef(target) ? target : null;
  } catch {
    return null;
  }
};

/**
 * The default base for patch-ids and author trailers: the release track's PR
 * target (origin's copy, else the local one) when tracks are configured, else
 * origin's HEAD branch, else the first of origin/main, origin/master, main,
 * master, origin/develop, develop that exists.
 */
export function defaultBase(cwd: string): string | null {
  const trunk = trackTrunk(cwd);
  if (trunk)
    for (const candidate of [`origin/${trunk}`, trunk])
      if (resolveRef(cwd, candidate)) return candidate;
  const originHead = originHeadRef(cwd);
  if (originHead && resolveRef(cwd, originHead)) return originHead;
  for (const candidate of [
    "origin/main",
    "origin/master",
    "main",
    "master",
    "origin/develop",
    "develop",
  ])
    if (resolveRef(cwd, candidate)) return candidate;
  return null;
}
