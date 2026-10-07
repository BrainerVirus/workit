// Cursor hook launch resolution and fail-open runner, shared by the launcher
// (launch.mjs, including its `--probe` mode for `workit doctor`). Side-effect
// free: importing it runs nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CURSOR_HOOK_PACKAGE = "@brainervirus/workit-cursor";

/** npm bin name -> bundled entry under dist/. */
const CURSOR_HOOK_BINS = {
  "workit-cursor-hook": "workit-hook.js",
  "workit-cursor-session-start": "cursor-session-start.js",
};

const LOCAL_TIMEOUT_MS = 20_000;
const NPX_TIMEOUT_MS = 30_000;

/** @param {string} root */
const pluginVersion = (root) => {
  try {
    const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
      ? version
      : null;
  } catch {
    return null;
  }
};

/** @param {string} name @param {NodeJS.ProcessEnv} env */
const onPath = (name, env) => {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of names.map((n) => path.join(dir, n))) {
      try {
        const st = statSync(candidate);
        if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0))
          return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
};

/**
 * @typedef {{ mode: "local" | "npx-pinned", source: string, command: string,
 *   args: string[], timeoutMs: number }} LaunchCandidate
 */

/**
 * Ordered launch candidates for `bin`; an empty list means "missing".
 * @param {{ root: string, bin: string, env: NodeJS.ProcessEnv, node?: string }} options
 * @returns {LaunchCandidate[]}
 */
export const resolveCursorHookLaunch = ({ root, bin, env, node = process.execPath }) => {
  /** @type {LaunchCandidate[]} */
  const candidates = [];
  const entry = Object.hasOwn(CURSOR_HOOK_BINS, bin)
    ? CURSOR_HOOK_BINS[/** @type {keyof typeof CURSOR_HOOK_BINS} */ (bin)]
    : null;
  if (!entry) return candidates;
  const bundled = path.join(root, "dist", entry);
  if (existsSync(bundled))
    candidates.push({
      mode: "local",
      source: bundled,
      command: node,
      args: [bundled],
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  const global = onPath(bin, env);
  if (global)
    candidates.push({
      mode: "local",
      source: global,
      command: global,
      args: [],
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  const version = pluginVersion(root);
  const npx = onPath("npx", env);
  if (version && npx)
    candidates.push({
      mode: "npx-pinned",
      source: `${CURSOR_HOOK_PACKAGE}@${version}`,
      command: npx,
      // WORKIT_CURSOR_HOOK_NPX_OFFLINE=1 (the doctor's probe) never downloads.
      args: [
        "-y",
        env.WORKIT_CURSOR_HOOK_NPX_OFFLINE === "1" ? "--offline" : "--prefer-offline",
        `--package=${CURSOR_HOOK_PACKAGE}@${version}`,
        bin,
      ],
      timeoutMs: NPX_TIMEOUT_MS,
    });
  return candidates;
};

/**
 * Run the first launchable candidate with `payload` on stdin.
 * @param {{ candidates: LaunchCandidate[], payload: string, env: NodeJS.ProcessEnv,
 *   spawn?: typeof spawnSync }} options
 * @returns {{ stdout: string, exitCode: number, warning: string | null }}
 */
export const runCursorHookLaunch = ({ candidates, payload, env, spawn = spawnSync }) => {
  const failOpen = (/** @type {string} */ reason) => ({
    stdout: "{}\n",
    exitCode: 0,
    warning: `[workit] Cursor hook unavailable: ${reason}`,
  });
  if (candidates.length === 0)
    return failOpen("no local workit-cursor runtime and no npx to fetch the pinned one");
  const timeoutMs = Number(env.WORKIT_CURSOR_HOOK_TIMEOUT_MS) || null;
  const errors = [];
  for (const candidate of candidates) {
    const run = spawn(candidate.command, candidate.args, {
      input: payload,
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "inherit"],
      timeout: timeoutMs ?? candidate.timeoutMs,
      windowsHide: true,
    });
    const code = /** @type {{ code?: string } | undefined} */ (run.error)?.code;
    // The process never started: try the next candidate on the same payload.
    if (run.error && (code === "ENOENT" || code === "EACCES")) {
      errors.push(`${candidate.source}: ${run.error.message}`);
      continue;
    }
    if (run.error) return failOpen(`${candidate.source}: ${run.error.message}`);
    // 0 = the hook's answer; 2 = the hook's own policy deny (Cursor's channel).
    if (run.status === 0 || run.status === 2)
      return { stdout: String(run.stdout ?? ""), exitCode: run.status, warning: null };
    return failOpen(`${candidate.source} exited ${run.status ?? `on ${run.signal ?? "a signal"}`}`);
  }
  return failOpen(errors.join("; "));
};
