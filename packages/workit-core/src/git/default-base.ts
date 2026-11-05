// The default base for patch-ids, author trailers and review lanes. Its own
// module so the lane (core/policy/lane.ts) and the ledger can both read it
// without importing each other.
import { spawnSync } from "node:child_process";
import { vcsConfig } from "../core/vcs-config";

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

type RefTable = { names: Set<string>; originHead: string | null };

/**
 * Every head, remote-tracking ref and commit tag, plus origin's HEAD target,
 * from one `git for-each-ref` (the candidates were probed one spawn each:
 * #284 N6). Read fresh on every call: refs move during a workit call.
 */
function refTable(cwd: string): RefTable | null {
  const run = spawnSync(
    "git",
    [
      "for-each-ref",
      "--format=%(refname)%00%(objecttype)%00%(*objecttype)%00%(symref)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    { cwd, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", windowsHide: true },
  );
  if (run.status !== 0) return null;
  const names = new Set<string>();
  let originHead: string | null = null;
  for (const row of (run.stdout ?? "").split(/\r?\n/u)) {
    const [name, type, peeled, symref] = row.split("\0");
    if (!name) continue;
    if (name === "refs/remotes/origin/HEAD") {
      if (symref?.startsWith("refs/remotes/")) originHead = symref.slice("refs/remotes/".length);
      continue;
    }
    // `<ref>^{commit}`: a tag counts only when it peels to a commit.
    if (type === "commit" || peeled === "commit") names.add(name);
  }
  return { names, originHead };
}

/** Whether `name` resolves to a commit, in git's own lookup order (gitrevisions(7)). */
const resolves = (table: RefTable, name: string): boolean =>
  safeRef(name) &&
  [
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ].some((ref) => table.names.has(ref));

/**
 * The default base for patch-ids and author trailers: the release track's PR
 * target (origin's copy, else the local one) when tracks are configured, else
 * origin's HEAD branch, else the first of origin/main, origin/master, main,
 * master, origin/develop, develop that exists.
 */
export function defaultBase(cwd: string): string | null {
  const table = refTable(cwd);
  if (!table) return null;
  const trunk = trackTrunk(cwd);
  if (trunk)
    for (const candidate of [`origin/${trunk}`, trunk])
      if (resolves(table, candidate)) return candidate;
  if (table.originHead && resolves(table, table.originHead)) return table.originHead;
  for (const candidate of [
    "origin/main",
    "origin/master",
    "main",
    "master",
    "origin/develop",
    "develop",
  ])
    if (resolves(table, candidate)) return candidate;
  return null;
}
