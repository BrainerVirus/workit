import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export type Result<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: T | null; error: string };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data, error: null });
export const fail = <T = never>(error: string, data: T | null = null): Result<T> => ({ ok: false, data, error });

export function resolveInside(root: string, candidate: string): string {
  const base = realpathSync(root);
  const target = path.resolve(base, candidate);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("path must stay inside repository root");
  }
  return target;
}

export function run(root: string, executable: string, args: string[], env: Record<string, string> = {}) {
  const cwd = realpathSync(root);
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    cwd,
  };
}
