import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type Result<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: T | null; error: string };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data, error: null });
export const fail = <T = never>(error: string, data: T | null = null): Result<T> => ({ ok: false, data, error });

const revision = /^[A-Za-z0-9@][A-Za-z0-9@._/~^{}-]*$/;

export function gitRevisionParts(value: string): string[] {
  if (!value || value.startsWith("-") || /[\s\\'"`$;|&<>]/.test(value)) {
    throw new Error("invalid Git revision or range");
  }
  const separator = value.includes("...") ? "..." : value.includes("..") ? ".." : null;
  const parts = separator ? value.split(separator) : [value];
  if (parts.length > 2 || parts.some((part) => !revision.test(part))) {
    throw new Error("invalid Git revision or range");
  }
  return parts;
}

export function resolveGitRevision(root: string, value: string): void {
  for (const part of gitRevisionParts(value)) {
    const result = run(root, "git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${part}^{commit}`]);
    if (result.exitCode !== 0) throw new Error(`invalid Git revision or range: ${value}`);
  }
}

export function resolveInside(root: string, candidate: string): string {
  const base = realpathSync(root);
  const target = path.resolve(base, candidate);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("path must stay inside repository root");
  }

  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonicalAncestor = realpathSync(ancestor);
  if (canonicalAncestor !== base && !canonicalAncestor.startsWith(base + path.sep)) {
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
