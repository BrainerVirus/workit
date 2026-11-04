// The one resolver for every Workit file location (docs/agents/file-locations.md).
// Kinds: config, state, data, cache and runtime. Linux and macOS follow the
// XDG Base Directory spec; Windows uses %APPDATA% (config, roaming) and
// %LOCALAPPDATA% (state, data, cache). An absolute XDG_*_HOME wins on every
// platform; a relative one is ignored, as the spec says.
//
// Plain JavaScript with node: builtins only and no syntax newer than Node 16:
// TypeScript imports it, and the hook launchers carry a byte-equal copy
// (claude-code bin/, codex bin/, cursor hooks/; a test holds them equal). The
// POSIX shell launchers embed the *_SH functions below verbatim, and a test
// runs them against the JavaScript for the same environment.
// Side-effect free on import; only migrateLegacyDirs touches the disk.
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every location kind the resolver knows. */
export const WORKIT_DIR_KINDS = ["config", "state", "data", "cache", "runtime"];

/** Environment overrides per kind, first non-empty wins; each names the directory itself. */
export const WORKIT_DIR_OVERRIDES = {
  config: ["WORKIT_CONFIG", "WORKIT_CONFIG_DIR"],
  state: ["WORKIT_STATE_DIR"],
  data: [],
  cache: [],
  runtime: [],
};

/** The XDG base variable each kind follows (`<base>/workit`). */
export const WORKIT_DIR_XDG = {
  config: "XDG_CONFIG_HOME",
  state: "XDG_STATE_HOME",
  data: "XDG_DATA_HOME",
  cache: "XDG_CACHE_HOME",
  runtime: "XDG_RUNTIME_DIR",
};

/** The XDG defaults under $HOME when the base variable is unset. */
const XDG_DEFAULTS = {
  config: [".config"],
  state: [".local", "state"],
  data: [".local", "share"],
  cache: [".cache"],
};

/**
 * The user's home: $HOME, else %USERPROFILE%, else the OS record.
 * @param {NodeJS.ProcessEnv} env
 */
export const userHome = (env) => env.HOME || env.USERPROFILE || os.homedir();

/**
 * The kind's XDG base when set to an absolute path (the spec ignores a relative one).
 * @param {string} kind @param {NodeJS.ProcessEnv} env
 */
const xdgBase = (kind, env) => {
  const base = env[WORKIT_DIR_XDG[kind]];
  return base && path.isAbsolute(base) ? base : "";
};

/**
 * Where one kind of Workit file lives.
 * @param {"config" | "state" | "data" | "cache" | "runtime"} kind
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export const workitDir = (kind, env = process.env, platform = process.platform) => {
  for (const name of WORKIT_DIR_OVERRIDES[kind]) if (env[name]) return String(env[name]);
  const base = xdgBase(kind, env);
  if (base) return path.join(base, "workit");
  if (kind === "runtime") {
    if (platform === "win32") return path.join(env.TEMP || env.TMP || os.tmpdir(), "workit");
    const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
    return path.join(env.TMPDIR || os.tmpdir(), `workit-${uid}`);
  }
  const home = userHome(env);
  if (platform !== "win32") return path.join(home, ...XDG_DEFAULTS[kind], "workit");
  if (kind === "config")
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "workit");
  const local = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "workit");
  return kind === "cache" ? path.join(local, "cache") : local;
};

/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export const configDir = (env, platform) => workitDir("config", env, platform);
/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export const stateDir = (env, platform) => workitDir("state", env, platform);
/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export const dataDir = (env, platform) => workitDir("data", env, platform);
/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export const cacheDir = (env, platform) => workitDir("cache", env, platform);
/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export const runtimeDir = (env, platform) => workitDir("runtime", env, platform);

/**
 * Where Workit keeps the worktrees it manages: `<state>/worktrees/<repo>/<slug>`.
 * State, not cache: a worktree holds uncommitted work.
 * @param {NodeJS.ProcessEnv} [env] @param {string} [platform]
 */
export const worktreesDir = (env, platform) => path.join(stateDir(env, platform), "worktrees");

/**
 * The managed worktree root before it moved to worktreesDir:
 * `$XDG_CACHE_HOME/workit-wt`, else `~/.cache/workit-wt` (on every platform).
 * Never moved (a session may be using a worktree there); cleanup still sweeps it.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const legacyWorktreesDir = (env = process.env) =>
  path.join(xdgBase("cache", env) || path.join(userHome(env), ".cache"), "workit-wt");

/**
 * The POSIX shell form of stateDir, embedded verbatim by the shell launchers
 * (claude-code bin/workit, the owned launcher `workit upgrade` writes).
 */
export const STATE_DIR_SH = `workit_state_dir() {
  if [ -n "\${WORKIT_STATE_DIR:-}" ]; then printf '%s\\n' "$WORKIT_STATE_DIR"; return; fi
  case "\${XDG_STATE_HOME:-}" in /*) printf '%s\\n' "$XDG_STATE_HOME/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\\n' "\${LOCALAPPDATA:-$HOME/AppData/Local}/workit" ;;
    *) printf '%s\\n' "$HOME/.local/state/workit" ;;
  esac
}`;

/** The POSIX shell form of configDir, embedded verbatim by scripts/lib/config-dir.sh. */
export const CONFIG_DIR_SH = `workit_config_dir() {
  if [ -n "\${WORKIT_CONFIG:-}" ]; then printf '%s\\n' "$WORKIT_CONFIG"; return; fi
  if [ -n "\${WORKIT_CONFIG_DIR:-}" ]; then printf '%s\\n' "$WORKIT_CONFIG_DIR"; return; fi
  case "\${XDG_CONFIG_HOME:-}" in /*) printf '%s\\n' "$XDG_CONFIG_HOME/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\\n' "\${APPDATA:-$HOME/AppData/Roaming}/workit" ;;
    *) printf '%s\\n' "$HOME/.config/workit" ;;
  esac
}`;

/** The POSIX shell form of dataDir, embedded verbatim by scripts/lib/config-dir.sh. */
export const DATA_DIR_SH = `workit_data_dir() {
  case "\${XDG_DATA_HOME:-}" in /*) printf '%s\\n' "$XDG_DATA_HOME/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\\n' "\${LOCALAPPDATA:-$HOME/AppData/Local}/workit" ;;
    *) printf '%s\\n' "$HOME/.local/share/workit" ;;
  esac
}`;

/**
 * The POSIX shell form of runtimeDir, embedded verbatim by scripts/lib/config-dir.sh.
 * `os.tmpdir()` drops a trailing slash from TMPDIR; so does this.
 */
export const RUNTIME_DIR_SH = `workit_runtime_dir() {
  case "\${XDG_RUNTIME_DIR:-}" in /*) printf '%s\\n' "$XDG_RUNTIME_DIR/workit"; return ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) printf '%s\\n' "\${TEMP:-\${TMP:-/tmp}}/workit" ;;
    *) set -- "\${TMPDIR:-/tmp}"; printf '%s\\n' "\${1%/}/workit-$(id -u)" ;;
  esac
}`;

/**
 * Locations older Workit versions used, per kind, that migrateLegacyDirs moves
 * to the resolver's default: macOS state lived in ~/Library/Application
 * Support/workit, Windows config in ~\.config\workit. Only while the kind has
 * no override or XDG variable (then the default is in use).
 * @param {NodeJS.ProcessEnv} [env] @param {string} [platform]
 * @returns {Array<{ kind: "config" | "state", legacy: string, target: string }>}
 */
export const legacyDirs = (env = process.env, platform = process.platform) => {
  const home = userHome(env);
  /** @type {Array<{ kind: "config" | "state", legacy: string }>} */
  const old = [];
  if (platform === "darwin")
    old.push({
      kind: "state",
      legacy: path.join(home, "Library", "Application Support", "workit"),
    });
  if (platform === "win32")
    old.push({ kind: "config", legacy: path.join(home, ".config", "workit") });
  return old
    .filter(
      (entry) =>
        !WORKIT_DIR_OVERRIDES[entry.kind].some((name) => env[name]) && !xdgBase(entry.kind, env),
    )
    .map((entry) => ({
      kind: entry.kind,
      legacy: entry.legacy,
      target: workitDir(entry.kind, env, platform),
    }));
};

/** The marker a move leaves beside the old location: `<legacy>.moved-<stamp>`. */
export const LEGACY_MARKER_INFIX = ".moved-";

/**
 * A real directory, never a symlink to one: a migration must not move a link
 * the user made (the data behind it would stay where the link pointed).
 * @param {string} file
 */
export const isRealDir = (file) => {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
};

/**
 * One-time move of each legacy location whose new location does not exist yet.
 * Leaves `<legacy>.moved-<UTC stamp>` naming the new location; a second run
 * finds no legacy directory and does nothing. Never throws: a failed move
 * leaves both places as they were, and `workit doctor` (legacy_dirs) names the
 * command that finishes it.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, now?: Date }} [options]
 * @returns {Array<{ kind: string, legacy: string, target: string, marker: string }>}
 */
export const migrateLegacyDirs = (options = {}) => {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const stamp = (options.now || new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "Z");
  /** @type {Array<{ kind: string, legacy: string, target: string, marker: string }>} */
  const moved = [];
  for (const entry of legacyDirs(env, platform)) {
    if (!isRealDir(entry.legacy) || existsSync(entry.target)) continue;
    const marker = `${entry.legacy}${LEGACY_MARKER_INFIX}${stamp}`;
    try {
      mkdirSync(path.dirname(entry.target), { recursive: true });
      renameSync(entry.legacy, entry.target);
    } catch {
      continue;
    }
    try {
      writeFileSync(
        marker,
        `Workit moved this ${entry.kind} directory to ${entry.target} at ${stamp}.\n`,
      );
    } catch {
      // the move is done; a missing marker only loses the note
    }
    moved.push({ kind: entry.kind, legacy: entry.legacy, target: entry.target, marker });
  }
  return moved;
};
