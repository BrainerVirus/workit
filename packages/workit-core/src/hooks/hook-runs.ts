// A tiny record of which hook events each host ran (#433): without it "zero
// hook events" cannot tell a host that never fires its hooks from one that
// fires them silently. One small file per host and native event in the state
// dir (`hook-runs/<host>__<event>.json`: last seen time and a count), written
// best effort: one read and one atomic-enough write, no spawn, and a
// read-only state dir never changes the hook's answer. `workit doctor`
// (`hook_runs`) reads it. Light imports only: the Codex launcher's quiet path
// calls it before the runtime loads.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../core/heavy-words";

export const HOOK_RUNS_DIR = "hook-runs";

export type HookRun = {
  host: string;
  event: string;
  at: string;
  count: number;
};

const safe = (part: string): string => part.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);

const runFile = (dir: string, host: string, event: string): string =>
  path.join(dir, HOOK_RUNS_DIR, `${safe(host)}__${safe(event)}.json`);

/** Counts one run of the native `event` on `host`; never throws. */
export const recordHookRun = (
  host: string,
  event: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): void => {
  if (!event) return;
  try {
    const dir = stateDir(env);
    const file = runFile(dir, host, event);
    let count = 0;
    try {
      const previous = JSON.parse(readFileSync(file, "utf8")) as {
        count?: unknown;
      };
      if (typeof previous.count === "number" && Number.isFinite(previous.count))
        count = previous.count;
    } catch {
      // First run, or a torn file: start again.
    }
    const row: HookRun = {
      host,
      event,
      at: new Date(now()).toISOString(),
      count: count + 1,
    };
    try {
      writeFileSync(file, JSON.stringify(row));
    } catch {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(row));
    }
  } catch {
    // The hook still answers the host; only the doctor line is lost.
  }
};

/** Every recorded run under `stateDir`; unreadable or malformed files are skipped. */
export const readHookRuns = (dir: string): HookRun[] => {
  const runs: HookRun[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(path.join(dir, HOOK_RUNS_DIR));
  } catch {
    return runs;
  }
  for (const name of names) {
    try {
      const row = JSON.parse(
        readFileSync(path.join(dir, HOOK_RUNS_DIR, name), "utf8"),
      ) as Partial<HookRun>;
      if (
        typeof row.host === "string" &&
        typeof row.event === "string" &&
        typeof row.at === "string" &&
        typeof row.count === "number"
      )
        runs.push({
          host: row.host,
          event: row.event,
          at: row.at,
          count: row.count,
        });
    } catch {
      // Not a run record.
    }
  }
  return runs;
};
