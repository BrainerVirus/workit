// The default base for patch-ids, author trailers and review lanes. Its own
// module so the lane (core/policy/lane.ts) and the ledger can both read it
// without importing each other.
import { spawnSync } from "node:child_process";
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

/** Every ref by full name: true when it peels to a commit. */
type RefTable = { refs: Map<string, boolean>; originHead: string | null };

// gitrevisions(7): where a short name is looked up, in order.
const RULES = [
  (n: string) => `refs/${n}`,
  (n: string) => `refs/tags/${n}`,
  (n: string) => `refs/heads/${n}`,
  (n: string) => `refs/remotes/${n}`,
  (n: string) => `refs/remotes/${n}/HEAD`,
];

/**
 * `<name>^{commit}` resolves: git takes the FIRST existing ref in rule order
 * (whatever it points at) and then needs a commit, so a tag `main` on a tree
 * hides the branch `main`.
 */
const resolves = (table: RefTable, name: string): boolean => {
  if (!safeRef(name)) return false;
  for (const rule of RULES) {
    const isCommit = table.refs.get(rule(name));
    if (isCommit !== undefined) return isCommit;
  }
  return false;
};

/**
 * `git symbolic-ref --short`'s name for a full ref: the shortest form that no
 * earlier rule resolves to another ref (git's shorten_unambiguous_ref), so an
 * `origin/main` branch or tag makes origin's HEAD `remotes/origin/main`.
 */
const shorten = (table: RefTable, full: string): string => {
  const patterns = ["refs/", "refs/tags/", "refs/heads/", "refs/remotes/"];
  for (let rule = RULES.length - 1; rule >= 0; rule -= 1) {
    let short: string | null = null;
    if (rule === 4) {
      const match = /^refs\/remotes\/(.+)\/HEAD$/u.exec(full);
      short = match ? match[1] : null;
    } else if (full.startsWith(patterns[rule])) short = full.slice(patterns[rule].length);
    if (!short) continue;
    let clash = false;
    for (let earlier = 0; earlier < rule && !clash; earlier += 1)
      clash = table.refs.has(RULES[earlier](short));
    if (!clash) return short;
  }
  return full;
};

/**
 * Every ref and origin's HEAD target from one `git for-each-ref` (the
 * candidates were probed one spawn each: #284 N6). Read fresh on every call:
 * refs move during a workit call. Null when git refuses (a ref naming a
 * missing object makes for-each-ref fatal), so the caller probes instead.
 */
function refTable(cwd: string): RefTable | null {
  const run = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(*objecttype)%00%(symref)"],
    { cwd, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", windowsHide: true },
  );
  if (run.status !== 0) return null;
  const refs = new Map<string, boolean>();
  let target: string | null = null;
  for (const row of (run.stdout ?? "").split(/\r?\n/u)) {
    const [name, type, peeled, symref] = row.split("\0");
    if (!name) continue;
    refs.set(name, type === "commit" || peeled === "commit");
    if (name === "refs/remotes/origin/HEAD" && symref) target = symref;
  }
  const table: RefTable = { refs, originHead: null };
  if (target) table.originHead = shorten(table, target);
  return table;
}

const CANDIDATES = ["origin/main", "origin/master", "main", "master", "origin/develop", "develop"];

/** The base from probing each candidate with its own git call (the old way, kept for a repo for-each-ref refuses). */
function probedBase(cwd: string, trunk: string | null): string | null {
  if (trunk)
    for (const candidate of [`origin/${trunk}`, trunk])
      if (resolveRef(cwd, candidate)) return candidate;
  const originHead = originHeadRef(cwd);
  if (originHead && resolveRef(cwd, originHead)) return originHead;
  for (const candidate of CANDIDATES) if (resolveRef(cwd, candidate)) return candidate;
  return null;
}

/**
 * The default base for patch-ids and author trailers: the release track's PR
 * target (origin's copy, else the local one) when tracks are configured, else
 * origin's HEAD branch, else the first of origin/main, origin/master, main,
 * master, origin/develop, develop that exists.
 */
export function defaultBase(cwd: string): string | null {
  const trunk = trackTrunk(cwd);
  const table = refTable(cwd);
  if (!table) return probedBase(cwd, trunk);
  if (trunk)
    for (const candidate of [`origin/${trunk}`, trunk])
      if (resolves(table, candidate)) return candidate;
  if (table.originHead && resolves(table, table.originHead)) return table.originHead;
  for (const candidate of CANDIDATES) if (resolves(table, candidate)) return candidate;
  return null;
}
