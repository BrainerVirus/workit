// The detached supervisor `workit run --bg` starts (#328). It runs in its own
// session and process group (setsid through a detached spawn), so the agent's
// shell returning never takes it down. It:
//   - charges the server against the heavy budget of its own checkout (the
//     sources the caller resolved, never a module-level budget), refusing at
//     once when it does not fit or the machine is under critical pressure;
//   - starts the command in a process group of its own, logging to
//     `<state>/procs/logs/<id>.log`, and records the row in the threads store;
//   - for docker, records the containers this start created (a `docker ps -q`
//     diff) so a stop touches exactly those;
//   - samples the group's RSS every `sampleMs`, keeps the row and the budget
//     charge current, and writes one notice past the ceiling;
//   - ends the row when the command exits on its own.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  admit,
  hostShape,
  leaseDir,
  resolveResourceSettings,
  type Admission,
  type Budget,
  type ResourceSource,
} from "@workit-dev/core/src/core/resources";
import { readPressure } from "@workit-dev/core/src/core/pressure";
import {
  dockerIds,
  endProc,
  openProcs,
  procLogFile,
  readExtra,
  updateExtra,
  writeRssNotice,
  type ProcKind,
} from "@workit-dev/core/src/core/procs";
import { readProc, upsertProc } from "@workit-dev/core/src/store/threads/procs";
import { groupRss, procTree } from "@workit-dev/core/src/core/proc-tree";

/** The env var carrying the spec to a supervisor process. */
export const SUPERVISE_ENV = "WORKIT_PROC_SPEC";

export type SupervisorSpec = {
  id: string;
  argv: string[];
  cwd: string;
  name: string;
  kind: ProcKind;
  port: number | null;
  session: string | null;
  lead: string | null;
  host: string | null;
  hostPid: number | null;
  repo: string | null;
  branch: string | null;
  /** Skip the budget (`--no-lease --reason`, recorded by the caller). */
  noLease: boolean;
  /** The caller's checkout's resource sources (workspaces.json, .workit/checks.json). */
  sources: ResourceSource[];
  /** What the server is charged before its first sample. */
  expectedRssBytes: number;
  /** How often RSS is sampled. */
  sampleMs: number;
  /** The RSS past which the owner gets a notice; null: the budget's per-check memoryMax. */
  ceilingBytes: number | null;
};

/**
 * The budget of the caller's checkout, with the pressure gate the CLI's own
 * budget has (unless the machine turned it off, or the test preload did).
 * Passing the host keeps this resolution out of any module-level state.
 */
export function checkoutBudget(sources: ResourceSource[], env: NodeJS.ProcessEnv): Budget {
  const { budget } = resolveResourceSettings(sources, hostShape());
  return {
    ...budget,
    pressure:
      budget.pressureGate && env.WORKIT_NO_PRESSURE_GATE !== "1" ? () => readPressure() : null,
  };
}

/** Container ids in `after` that were not running `before`. */
const added = (before: string[] | null, after: string[] | null): string[] | null =>
  before === null || after === null ? null : after.filter((id) => !before.includes(id));

export async function supervise(spec: SupervisorSpec, env: NodeJS.ProcessEnv): Promise<number> {
  const store = openProcs(env);
  const childEnv = { ...env };
  delete childEnv[SUPERVISE_ENV];
  const budget = checkoutBudget(spec.sources, env);
  const ceiling = spec.ceilingBytes ?? budget.defaultBytes;
  let admission: Admission | null = null;
  try {
    updateExtra(env, spec.id, { supervisorPid: process.pid });
    if (!spec.noLease) {
      const admitted = admit({
        dir: leaseDir(env),
        kind: "server",
        label: `${spec.name}: ${spec.argv.join(" ")}`,
        rssBytes: spec.expectedRssBytes,
        cwd: spec.cwd,
        session: spec.session,
        ref: spec.id,
        budget,
      });
      if (!admitted.ok) {
        updateExtra(env, spec.id, {
          state: "refused",
          message: admitted.line,
          unblock: admitted.unblock,
        });
        return 3;
      }
      admission = admitted.admission;
    }
    const before = spec.kind === "docker" ? dockerIds(spec.cwd) : [];
    const logFile = procLogFile(env, spec.id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const log = fs.openSync(logFile, "a", 0o600);
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: childEnv,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    fs.closeSync(log);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    const failed = await new Promise<Error | null>((resolve) => {
      child.once("error", resolve);
      child.once("spawn", () => resolve(null));
    });
    if (failed || child.pid === undefined) {
      updateExtra(env, spec.id, {
        state: "failed",
        message: `could not start ${spec.argv[0]}: ${failed?.message ?? "no pid"}`,
      });
      return 1;
    }
    const pid = child.pid;
    const startedAt = new Date().toISOString();
    upsertProc(store, spec.id, () => ({
      session: spec.session,
      lead: spec.lead,
      host: spec.host,
      hostPid: spec.hostPid,
      repo: spec.repo,
      cwd: spec.cwd,
      branch: spec.branch,
      pgid: process.platform === "win32" ? null : pid,
      pid,
      pidStart: procTree.start(pid),
      cmd: spec.argv.join(" "),
      kind: spec.kind,
      port: spec.port,
      startedAt,
    }));
    updateExtra(env, spec.id, { state: "running" });

    const sampleContainers = () => {
      if (spec.kind !== "docker") return;
      const now = added(before, dockerIds(spec.cwd));
      const known = readExtra(env, spec.id)?.containers ?? [];
      updateExtra(env, spec.id, {
        // Unreadable once: report-only (ruling 4); never guess which containers are ours.
        containers: now === null || known === null ? null : [...new Set([...known, ...now])],
      });
    };
    const sample = () => {
      sampleContainers();
      const rss = groupRss(pid);
      if (rss === null) return;
      const row = upsertProc(store, spec.id, () => ({ rss, rssAt: new Date().toISOString() }));
      admission?.update(rss);
      if (rss > ceiling && !readExtra(env, spec.id)?.noticed && row.endedAt === null) {
        writeRssNotice(env, row, rss, ceiling);
        updateExtra(env, spec.id, { noticed: true });
      }
    };
    // A first sample soon after the start, then every sampleMs.
    const first = setTimeout(sample, Math.min(2_000, spec.sampleMs));
    const timer = setInterval(sample, spec.sampleMs);
    const { code, signal } = await exited;
    clearTimeout(first);
    clearInterval(timer);
    sampleContainers();
    const containers = readExtra(env, spec.id)?.containers;
    // `docker run -d` exits at once and leaves its container: the row lives until `workit stop`.
    if (spec.kind === "docker" && (containers === null || (containers?.length ?? 0) > 0)) {
      updateExtra(env, spec.id, { exitCode: code ?? 128 });
      return 0;
    }
    const row = readProc(store, spec.id);
    if (row && row.endedAt === null)
      endProc(store, spec.id, code !== null ? `exited ${code}` : `ended by ${signal}`);
    updateExtra(env, spec.id, { state: "exited", exitCode: code ?? 128 });
    return 0;
  } catch (error) {
    updateExtra(env, spec.id, { state: "failed", message: (error as Error).message });
    return 1;
  } finally {
    admission?.release();
    store.close();
  }
}
