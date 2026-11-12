// ytrack's folder-to-host map (youtrack-cli `ytrack auth paths`, hosts.yml):
// ytrack picks its host from --host, a URL, YTRACK_HOST, then the cwd's path
// glob, then its default. Workit sets YTRACK_HOST only for its own ytrack
// calls, so an agent's raw `ytrack` in a workspace reaches the right instance
// only when that workspace's glob is mapped to its YouTrack host. `workit
// doctor` reports drift read-only; `workit setup` plans the `--add` calls.
import {
  ytrackAuthPaths,
  ytrackAuthPathsCommand,
  ytrackHostName,
  type YtrackRun,
} from "./youtrack-ytrack";

/** One workspace glob that should resolve to its YouTrack host. */
type PathWant = { workspace: string; host: string; glob: string };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Each workspace entry with a `youtrack.baseUrl` and a glob, as host and glob. */
export const pathWants = (entries: readonly unknown[]): PathWant[] =>
  entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    const youtrack = raw.youtrack as Record<string, unknown> | undefined;
    const base = text(youtrack?.baseUrl);
    const glob = text(raw.glob);
    const name = text(raw.name);
    return base && glob ? [{ workspace: name ?? glob, host: ytrackHostName(base), glob }] : [];
  });

/** One host's change: the globs to add and remove, and the command that makes it. */
export type PathFix = {
  host: string;
  add: string[];
  remove: string[];
  command: string;
};

type PathsReview =
  | { state: "ok"; drift: string[]; fixes: PathFix[] }
  | { state: "missing" | "old" | "failed"; error: string };

/**
 * Compare each wanted glob with ytrack's map: missing on its host, or mapped
 * to another host (`others`: hosts ytrack knows, from `ytrack auth status`).
 * Read-only: only `ytrack auth paths --host <h> --json host,paths` runs.
 */
export function reviewYtrackPaths(
  run: YtrackRun,
  wants: readonly PathWant[],
  others: readonly string[] = [],
): PathsReview {
  const hosts = [...new Set([...wants.map((want) => want.host), ...others.map(ytrackHostName)])];
  const mapped = new Map<string, Set<string>>();
  for (const host of hosts) {
    const read = ytrackAuthPaths(run, host);
    if (!read.ok) return { state: read.reason, error: read.error };
    mapped.set(host, new Set(read.paths));
  }
  const drift: string[] = [];
  const add = new Map<string, string[]>();
  const remove = new Map<string, string[]>();
  const push = (into: Map<string, string[]>, host: string, glob: string) => {
    const list = into.get(host) ?? [];
    if (!list.includes(glob)) list.push(glob);
    into.set(host, list);
  };
  for (const want of wants) {
    if (!mapped.get(want.host)?.has(want.glob)) {
      drift.push(`${want.workspace}: ${want.glob} is not mapped to ${want.host}`);
      push(add, want.host, want.glob);
    }
    for (const [host, globs] of mapped)
      if (host !== want.host && globs.has(want.glob)) {
        drift.push(`${want.workspace}: ${want.glob} is mapped to ${host}, not ${want.host}`);
        push(remove, host, want.glob);
      }
  }
  const fixes = hosts.flatMap((host) => {
    const change = { add: add.get(host) ?? [], remove: remove.get(host) ?? [] };
    return change.add.length || change.remove.length
      ? [{ host, ...change, command: ytrackAuthPathsCommand(host, change) }]
      : [];
  });
  return { state: "ok", drift, fixes };
}
