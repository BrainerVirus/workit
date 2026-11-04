// The Node and npm the owned install runs with: a Node >= 24 found by the
// hooks' resolve order (core/node-resolve.mjs), and that Node's own npm run as
// `node npm-cli.js`, so neither the PATH `npm` nor its `#!/usr/bin/env node`
// shebang can pick another Node's global prefix.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  HOOK_NODE_FLOOR,
  compareVersions,
  parseNodeVersion,
  resolveHookNode,
} from "@brainervirus/workit-core/src/core/node-resolve.mjs";
import { realpathOr } from "./paths";

export type InstallNode = { node: string; npmCli: string; version: string | null };

/** npm's entry script beside a node binary (its install layout, symlinks followed). */
export const npmCliFor = (
  node: string,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const candidates = [node, realpathOr(node)].flatMap((file) => {
    const bin = path.dirname(file);
    return platform === "win32"
      ? [path.join(bin, "node_modules", "npm", "bin", "npm-cli.js")]
      : [
          path.join(path.dirname(bin), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
          path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
        ];
  });
  return candidates.find((file) => existsSync(file)) ?? null;
};

/**
 * This process's node when it is a Node >= 24, else the hooks' resolve order
 * (WORKIT_NODE, the recorded node, a version-manager scan). Null when none
 * has an npm beside it.
 */
export const resolveInstallNode = (
  env: NodeJS.ProcessEnv,
  options: { execPath?: string; version?: string; platform?: NodeJS.Platform } = {},
): InstallNode | null => {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const version = options.version ?? process.versions.node;
  const own = parseNodeVersion(version);
  const candidates: { node: string; version: string | null }[] = [];
  if (
    /^node(?:\.exe)?$/i.test(path.basename(execPath)) &&
    own &&
    compareVersions(own, HOOK_NODE_FLOOR) >= 0
  )
    candidates.push({ node: execPath, version });
  const resolved = resolveHookNode({ env, floor: HOOK_NODE_FLOOR, platform });
  if (resolved) candidates.push({ node: resolved.path, version: resolved.version });
  for (const candidate of candidates) {
    const npmCli = npmCliFor(candidate.node, platform);
    if (npmCli) return { ...candidate, npmCli };
  }
  return null;
};
