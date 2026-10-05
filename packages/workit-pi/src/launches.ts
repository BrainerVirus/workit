// Durable Pi launch attempts (S16 review L2). Without core dispatch claims, a
// Pi session records each launch attempt as an exclusively created marker in
// the shared store directory before it spawns, and removes it once the child
// is observed running. A second launcher (another Pi process) loses the
// exclusive create and refuses; a marker left by a dead launcher lets the next
// Pi session mark that worker `unknown` so it cannot be relaunched until the
// lead cancels it.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStore } from "@brainervirus/workit-core/src/store/paths";

export type LaunchAttempt = {
  taskId: string;
  workerId: string;
  session: string;
  pid: number;
  host: string;
  at: string;
};

const launchDir = (root: string): string | null => {
  const location = resolveStore(root);
  return location instanceof Error ? null : path.join(location.dir, "pi-launches");
};

const fileFor = (dir: string, workerId: string) =>
  path.join(dir, `${workerId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);

/** Claim the launch: false when another attempt for this worker is recorded. */
export const recordLaunch = (
  root: string,
  attempt: Omit<LaunchAttempt, "pid" | "host" | "at">,
): boolean => {
  const dir = launchDir(root);
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      fileFor(dir, attempt.workerId),
      JSON.stringify({
        ...attempt,
        pid: process.pid,
        host: os.hostname(),
        at: new Date().toISOString(),
      }),
      { flag: "wx" },
    );
    return true;
  } catch {
    return false;
  }
};

export const clearLaunch = (root: string, workerId: string): void => {
  const dir = launchDir(root);
  if (dir) rmSync(fileFor(dir, workerId), { force: true });
};

const alive = (attempt: LaunchAttempt): boolean => {
  if (attempt.host !== os.hostname()) return true;
  try {
    process.kill(attempt.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Attempts whose launcher process is gone: their outcome is unobserved. */
export const abandonedLaunches = (root: string): LaunchAttempt[] => {
  const dir = launchDir(root);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: LaunchAttempt[] = [];
  for (const name of names) {
    try {
      const attempt = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LaunchAttempt;
      if (typeof attempt.workerId === "string" && typeof attempt.session === "string")
        if (!alive(attempt)) found.push(attempt);
    } catch {
      // A torn marker is ignored; it never authorizes anything.
    }
  }
  return found;
};

export const cancelHint = (workerId: string): string =>
  `cancel it first: workit_worker {"action":"cancel","workerId":"${workerId}","reason":"launch outcome unknown"} (CLI: workit worker cancel --payload '{"workerId":"${workerId}","reason":"launch outcome unknown"}')`;
