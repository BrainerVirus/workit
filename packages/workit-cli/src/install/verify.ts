// The proof an install worked: what `workit --version` prints from the first
// `workit` on PATH, the binary every shell, hook and agent will run.
import { spawnSync } from "node:child_process";
import { pathWorkits } from "./discover";

export type PathWorkit = { path: string | null; version: string | null; error?: string };

export const pathResolvedWorkit = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): PathWorkit => {
  const first = pathWorkits(env, platform)[0];
  if (!first) return { path: null, version: null, error: "no workit on PATH" };
  const result = spawnSync(first, ["--version"], {
    encoding: "utf8",
    env: { ...env, WORKIT_UPDATE_CHECK: "0" },
    timeout: 30_000,
    windowsHide: true,
    shell: platform === "win32" && /\.(?:cmd|bat)$/i.test(first),
  });
  const version = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(result.stdout ?? "")?.[0] ?? null;
  return result.status === 0 && version
    ? { path: first, version }
    : {
        path: first,
        version: null,
        error:
          result.error?.message ??
          (`${result.stderr ?? ""}`.trim().split(/\r?\n/).at(-1) || `exit ${result.status}`),
      };
};
