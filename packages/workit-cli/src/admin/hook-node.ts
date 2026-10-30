// The Node the host hooks run on. Claude Code, Codex and Cursor launch their
// hooks with the bare PATH `node`, which a version manager may pin to a Node
// below the floor (a repo's .nvmrc). The launchers then look for a Node >= the
// floor themselves (core/node-resolve.mjs): `workit setup` and `workit upgrade`
// record the node they run on in <state dir>/node.json for them, and
// `workit doctor` reports which Node the hooks will end up on.
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "@brainervirus/workit-core/src/core/safe-write";
import {
  HOOK_NODE_FLOOR,
  compareVersions,
  nodeRecord,
  parseNodeVersion,
  resolveHookNode,
} from "@brainervirus/workit-core/src/core/node-resolve.mjs";

/** Record this process's node for the hook launchers; best effort, never throws. */
export const recordHookNode = (
  env: NodeJS.ProcessEnv,
  node: { execPath: string; version: string } = {
    execPath: process.execPath,
    version: process.versions.node,
  },
): string | null => {
  try {
    const file = nodeRecord({ env, floor: HOOK_NODE_FLOOR, ...node });
    if (!file) return null;
    writeFileAtomic(
      file,
      `${JSON.stringify({ path: node.execPath, version: node.version, recordedAt: new Date().toISOString() })}\n`,
    );
    return file;
  } catch {
    return null;
  }
};

export type HookNodeReport = {
  /** The PATH node's version, or null when no node is on PATH. */
  pathVersion: string | null;
  pathOk: boolean;
  /** What the launchers fall back to when the PATH node is below the floor. */
  resolved: { path: string; version: string | null; source: "env" | "recorded" | "scan" } | null;
};

export const hookNodeReport = (
  env: NodeJS.ProcessEnv,
  pathVersion: string | null = nodeOnPathVersion(env),
): HookNodeReport => {
  const parsed = pathVersion ? parseNodeVersion(pathVersion) : null;
  const pathOk = parsed !== null && compareVersions(parsed, HOOK_NODE_FLOOR) >= 0;
  return {
    pathVersion,
    pathOk,
    resolved: pathOk ? null : resolveHookNode({ env, floor: HOOK_NODE_FLOOR }),
  };
};

const nodeOnPathVersion = (env: NodeJS.ProcessEnv): string | null => {
  const run = spawnSync("node", ["--version"], { encoding: "utf8", env, timeout: 5_000 });
  return run.error || run.status !== 0 ? null : run.stdout.trim() || null;
};
