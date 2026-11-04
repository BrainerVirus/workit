// Cursor hook launch resolution and fail-open runner, shared by the launcher
// (launch.mjs, including its `--probe` mode for `workit doctor`). Side-effect
// free: importing it runs nothing.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stateDir } from "./workit-paths.mjs";

const CURSOR_HOOK_PACKAGE = "@brainervirus/workit-cursor";

/** npm bin name -> bundled entry under dist/. */
const CURSOR_HOOK_BINS = {
  "workit-cursor-hook": "workit-hook.js",
  "workit-cursor-session-start": "cursor-session-start.js",
};

const LOCAL_TIMEOUT_MS = 20_000;
const NPX_TIMEOUT_MS = 30_000;
// A deny can carry a long agent message; spawnSync's 1 MiB default would turn
// an oversized answer into a launcher failure (and fail open).
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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

/** The workit-cursor version a global bin belongs to (its package.json), if any.
 *  @param {string} bin */
const globalBinVersion = (bin) => {
  try {
    for (let dir = path.dirname(realpathSync(bin)); ; dir = path.dirname(dir)) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        const parsed = JSON.parse(readFileSync(pkg, "utf8"));
        return parsed.name === CURSOR_HOOK_PACKAGE ? pluginVersion(dir) : null;
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
};

/** @param {string} name @param {NodeJS.ProcessEnv} env */
const onPath = (name, env) => {
  const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    // Relative entries (`.`, `node_modules/.bin`) resolve against the
    // workspace Cursor runs the hook in: never trust them.
    if (!dir || !path.isAbsolute(dir)) continue;
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
 * @typedef {{ mode: "local" | "npx-pinned", source: string, version: string | null,
 *   command: string, args: string[], verbatim?: boolean, timeoutMs: number }} LaunchCandidate
 */

// cmd.exe metacharacters, escaped with `^` (ported from workit-core's
// checks.ts, which this plain-JS launcher cannot import).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a `cmd /d /s /c "…"` line; `double` for node_modules/.bin
 *  shims, which re-parse their arguments.
 *  @param {string} arg @param {boolean} double */
const cmdArgument = (arg, double) => {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return double ? out.replace(CMD_META, "^$1") : out;
};

/**
 * How to spawn `file args…`. Node cannot spawn a Windows `.cmd`/`.bat` shim
 * directly, so it runs as `cmd.exe /d /s /c "<line>"` with every metacharacter
 * escaped and the line passed verbatim: a path such as `C:\A&B\x.cmd` must
 * never split into a second command.
 * @param {string} file @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @returns {{ command: string, args: string[], verbatim: boolean }}
 */
export const cursorSpawnPlan = (file, args, env) => {
  if (!/\.(?:cmd|bat)$/i.test(file)) return { command: file, args, verbatim: false };
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [
    path.win32.normalize(file).replace(CMD_META, "^$1"),
    ...args.map((arg) => cmdArgument(arg, double)),
  ].join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
};

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
  const version = pluginVersion(root);
  const bundled = path.join(root, "dist", entry);
  if (existsSync(bundled))
    candidates.push({
      mode: "local",
      source: bundled,
      version,
      command: node,
      args: [bundled],
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  const global = onPath(bin, env);
  if (global)
    candidates.push({
      mode: "local",
      source: global,
      version: globalBinVersion(global),
      ...cursorSpawnPlan(global, [], env),
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  const npx = onPath("npx", env);
  if (version && npx)
    candidates.push({
      mode: "npx-pinned",
      source: `${CURSOR_HOOK_PACKAGE}@${version}`,
      version,
      // WORKIT_CURSOR_HOOK_NPX_OFFLINE=1 (the doctor's probe) never downloads.
      ...cursorSpawnPlan(
        npx,
        [
          "-y",
          env.WORKIT_CURSOR_HOOK_NPX_OFFLINE === "1" ? "--offline" : "--prefer-offline",
          `--package=${CURSOR_HOOK_PACKAGE}@${version}`,
          bin,
        ],
        env,
      ),
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
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      windowsVerbatimArguments: candidate.verbatim === true,
    });
    const code = /** @type {{ code?: string } | undefined} */ (run.error)?.code;
    // The process never started: try the next candidate on the same payload.
    if (run.error && (code === "ENOENT" || code === "EACCES")) {
      errors.push(`${candidate.source}: ${run.error.message}`);
      continue;
    }
    // EPIPE only means the hook exited without reading all of stdin; its exit
    // status still stands.
    if (run.error && !(code === "EPIPE" && typeof run.status === "number"))
      return failOpen(`${candidate.source}: ${run.error.message}`);
    // 0 = the hook's answer; 2 = the hook's own policy deny (Cursor's channel).
    if (run.status === 0 || run.status === 2)
      return { stdout: String(run.stdout ?? ""), exitCode: run.status, warning: null };
    return failOpen(`${candidate.source} exited ${run.status ?? `on ${run.signal ?? "a signal"}`}`);
  }
  return failOpen(errors.join("; "));
};

/** Workit's state dir (workit-paths.mjs, the one resolver).
 *  @param {NodeJS.ProcessEnv} env */
export const workitStateDir = (env) => stateDir(env);

/** File the launcher touches on every run, so `workit doctor` can tell when
 *  Cursor started sessions but never ran a Workit hook. */
export const CURSOR_HOOK_HEARTBEAT = "cursor-hook-last-run";

/** Best-effort heartbeat; a read-only state dir never blocks a hook.
 *  @param {NodeJS.ProcessEnv} env @param {string} bin */
export const touchCursorHookHeartbeat = (env, bin) => {
  try {
    const dir = workitStateDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, CURSOR_HOOK_HEARTBEAT),
      `${JSON.stringify({ at: new Date().toISOString(), bin })}\n`,
    );
  } catch {
    /* heartbeat is diagnostic only */
  }
};

/** A hook-runs failure row, as workit-core hooks/hook-runs.ts recordHookFailure
 *  writes it (`<state>/hook-runs/cursor__<event>__failed.json`), so `workit
 *  doctor` sees a hook that could not answer. Best effort.
 *  @param {NodeJS.ProcessEnv} env @param {unknown} event @param {string} cause */
export const recordCursorHookFailure = (env, event, cause) => {
  try {
    const name = typeof event === "string" && event ? event : "unknown";
    const safe = (/** @type {string} */ part) => part.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
    const file = path.join(workitStateDir(env), "hook-runs", `cursor__${safe(name)}__failed.json`);
    let count = 0;
    try {
      const previous = JSON.parse(readFileSync(file, "utf8")).count;
      if (typeof previous === "number" && Number.isFinite(previous)) count = previous;
    } catch {
      /* first failure, or a torn file */
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        host: "cursor",
        event: name,
        at: new Date().toISOString(),
        count: count + 1,
        failure: String(cause).slice(0, 500),
      }),
    );
  } catch {
    /* diagnostic only */
  }
};

/** What the agent reads at sessionStart when the Workit hook could not run.
 *  @param {string} reason */
export const cursorHookOffNotice = (reason) =>
  `Workit hooks are off: the Cursor hook could not run (${reason}). Branch policy, task context and verifier sessions are off until it does. Run \`workit upgrade\` to reinstall the plugin, then \`workit doctor\` (check hook_node runs each installed hook).`;
