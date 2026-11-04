// The proof an install worked: what `workit --version` prints from the first
// `workit` on PATH, the binary every shell, hook and agent will run. PATH is
// read the way the person's login shell has it: without the directories a
// package runner added for this one run (`npx … upgrade` puts its cache's
// .bin first) and without a host plugin's own launcher (Claude Code adds its
// plugin bin/ only to its Bash tool), so an npx copy never passes for the CLI.
import { spawnSync } from "node:child_process";
import { hostLauncherOf, pathWorkits, persistentPath } from "./discover";
import { realpathOr } from "./paths";

export type PathWorkit = { path: string | null; version: string | null; error?: string };

export const pathResolvedWorkit = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): PathWorkit => {
  const first = pathWorkits(env, platform).find(
    (file) => !hostLauncherOf(realpathOr(file), platform),
  );
  if (!first) return { path: null, version: null, error: "no workit on PATH" };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const result = spawnSync(first, ["--version"], {
    encoding: "utf8",
    env: {
      ...env,
      [pathKey]: persistentPath(env, platform).join(platform === "win32" ? ";" : ":"),
      WORKIT_UPDATE_CHECK: "0",
    },
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
