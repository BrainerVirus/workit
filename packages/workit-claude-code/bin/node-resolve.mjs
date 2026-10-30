// Finds a Node that can run a Workit hook when the PATH node is below the
// package's engines floor (a repo pinned to Node 16/18/22 by a version
// manager). Plain JavaScript with node: builtins only and no syntax newer than
// Node 16 supports: the host launchers import it (or carry a byte-equal copy,
// a test holds them equal) and must start on the very Node they are replacing.
// Side-effect free: importing it runs nothing; no process is spawned here.
//
// Order: (1) $WORKIT_NODE; (2) the node `workit setup`/`upgrade` recorded in
// <state dir>/node.json; (3) a scan of version-manager installs (fnm, nvm,
// volta, mise, asdf and the Windows layouts), highest version >= the floor.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The Node major the hooks need; a test holds it equal to every package's engines.node. */
export const HOOK_NODE_FLOOR = [24, 0, 0];

/** Set on the re-executed child so a launcher never re-executes twice. */
export const HOOK_NODE_REEXEC_ENV = "WORKIT_HOOK_REEXEC";

const MAX_ENTRIES_PER_ROOT = 200;

/** @param {unknown} text @returns {number[] | null} */
export const parseNodeVersion = (text) => {
  const found = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text).trim());
  return found ? [Number(found[1]), Number(found[2] || 0), Number(found[3] || 0)] : null;
};

/** @param {number[]} a @param {number[]} b negative when a < b */
export const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The `>=X[.Y[.Z]]` minimum of an engines.node range, or null. @param {unknown} range */
export const floorOfRange = (range) => {
  const min = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(range === undefined ? "" : range));
  return min ? [Number(min[1]), Number(min[2] || 0), Number(min[3] || 0)] : null;
};

/** @param {NodeJS.ProcessEnv} env */
export const hookStateDir = (env) => {
  if (env.WORKFLOW_TOOLKIT_STATE) return env.WORKFLOW_TOOLKIT_STATE;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "workit");
  const home = env.HOME || os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "workit");
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "workit");
  return path.join(home, ".local", "state", "workit");
};

/** @param {string} file */
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** @param {string} file */
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The version-manager directories that hold one node per child directory:
 * `{ dir, bin }` where the node is `<dir>/<child>/<bin>`.
 * @param {NodeJS.ProcessEnv} env @param {string} platform
 */
const scanRoots = (env, platform) => {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const win = platform === "win32";
  const exe = win ? "node.exe" : "node";
  const bin = win ? exe : path.join("bin", exe);
  /** @type {Array<{ dir: string, bin: string }>} */
  const roots = [];
  const add = (dir, rel) => {
    if (dir) roots.push({ dir, bin: rel });
  };
  // fnm: <dir>/node-versions/<v>/installation/bin/node
  const fnmDirs = [
    env.FNM_DIR,
    win ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "fnm") : "",
    win ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "fnm") : "",
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "fnm") : "",
    path.join(home, ".local", "share", "fnm"),
    path.join(home, "Library", "Application Support", "fnm"),
    path.join(home, ".fnm"),
  ];
  for (const dir of fnmDirs)
    if (dir) add(path.join(dir, "node-versions"), path.join("installation", bin));
  // nvm: <dir>/versions/node/<v>/bin/node; nvm-windows: <NVM_HOME>/<v>/node.exe
  for (const dir of [env.NVM_DIR, path.join(home, ".nvm")])
    if (dir) add(path.join(dir, "versions", "node"), bin);
  if (env.NVM_HOME) add(env.NVM_HOME, exe);
  // volta: <dir>/tools/image/node/<v>/bin/node
  const volta = env.VOLTA_HOME || (win ? "" : path.join(home, ".volta"));
  if (volta) add(path.join(volta, "tools", "image", "node"), bin);
  if (win)
    add(
      path.join(
        env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
        "Volta",
        "tools",
        "image",
        "node",
      ),
      bin,
    );
  // mise and asdf: <dir>/installs/node[js]/<v>/bin/node
  const mise = env.MISE_DATA_DIR || path.join(home, ".local", "share", "mise");
  add(path.join(mise, "installs", "node"), bin);
  const asdf = env.ASDF_DATA_DIR || path.join(home, ".asdf");
  add(path.join(asdf, "installs", "nodejs"), bin);
  return roots;
};

/**
 * Every installed node a version manager lists, with its version: directory
 * listings only, at most MAX_ENTRIES_PER_ROOT per root.
 * @param {NodeJS.ProcessEnv} env @param {string} [platform]
 * @returns {Array<{ path: string, version: number[], source: string }>}
 */
export const scanInstalledNodes = (env, platform = process.platform) => {
  /** @type {Array<{ path: string, version: number[], source: string }>} */
  const found = [];
  for (const root of scanRoots(env, platform)) {
    let names;
    try {
      names = readdirSync(root.dir).slice(0, MAX_ENTRIES_PER_ROOT);
    } catch {
      continue;
    }
    for (const name of names) {
      const version = parseNodeVersion(name);
      if (!version || !/^v?\d/.test(name)) continue;
      // volta's layout nests nothing; fnm's, nvm's, mise's and asdf's differ only in `bin`.
      const candidate = path.join(root.dir, name, root.bin);
      if (isFile(candidate)) found.push({ path: candidate, version, source: root.dir });
    }
  }
  return found;
};

/**
 * The node the hooks should run on, or null. `floor` is [major, minor, patch].
 * @param {{ env: NodeJS.ProcessEnv, floor: number[], platform?: string }} options
 * @returns {{ path: string, version: string | null, source: "env" | "recorded" | "scan" } | null}
 */
export const resolveHookNode = ({ env, floor, platform = process.platform }) => {
  if (env.WORKIT_NODE && isFile(env.WORKIT_NODE))
    return { path: env.WORKIT_NODE, version: null, source: "env" };
  const recorded = readJson(path.join(hookStateDir(env), "node.json"));
  if (recorded && typeof recorded.path === "string" && isFile(recorded.path)) {
    const version = parseNodeVersion(recorded.version);
    if (version && compareVersions(version, floor) >= 0)
      return { path: recorded.path, version: String(recorded.version), source: "recorded" };
  }
  let best = null;
  for (const entry of scanInstalledNodes(env, platform))
    if (
      compareVersions(entry.version, floor) >= 0 &&
      (!best || compareVersions(entry.version, best.version) > 0)
    )
      best = entry;
  return best ? { path: best.path, version: best.version.join("."), source: "scan" } : null;
};

/**
 * The fail-open line for a node below the floor: null when `found` is at or
 * above `floor`, or unparseable (an unreadable version never blocks).
 * @param {string} found @param {number[] | null} floor @param {string} range
 */
export const floorMessage = (found, floor, range) => {
  if (!floor) return null;
  const have = parseNodeVersion(found);
  if (!have || compareVersions(have, floor) >= 0) return null;
  return `needs Node ${range}, found ${found}`;
};

/** What the agent is told once, at SessionStart, when no Node >= the floor resolves. */
export const nodeFloorNotice = (found, range) =>
  `Workit hooks are off: the Node on PATH is ${String(found).replace(/^v/, "")}, below the required ${range}, and no Node 24+ was found. ` +
  "Install Node 24 (fnm install 24, nvm install 24) or run `workit setup` from a Node 24 shell so Workit can record it; " +
  "`workit doctor` (check hook_node) shows what the hooks run on.";

/**
 * Where setup and upgrade record the Node they run on. A no-op for a non-node
 * binary (bun) or a Node below the floor.
 * @param {{ env: NodeJS.ProcessEnv, execPath: string, version: string, floor: number[] }} options
 * @returns {string | null} the file written
 */
export const nodeRecord = ({ env, execPath, version, floor }) => {
  const parsed = parseNodeVersion(version);
  if (!parsed || compareVersions(parsed, floor) < 0) return null;
  if (!/^node(?:\.exe)?$/i.test(path.basename(execPath))) return null;
  return path.join(hookStateDir(env), "node.json");
};

/**
 * Run `script args…` on `nodePath` with this process's stdin, stdout and
 * stderr passed through. The child carries the re-exec guard and a real
 * version (WORKIT_HOOK_NODE_VERSION, a test seam, is dropped).
 * @returns {number | null} the child's exit code, or null when it could not start
 */
export const reexecOnNode = (nodePath, script, args, env) => {
  const child = Object.assign({}, env, { [HOOK_NODE_REEXEC_ENV]: "1" });
  delete child.WORKIT_HOOK_NODE_VERSION;
  const run = spawnSync(nodePath, [script].concat(args), {
    stdio: "inherit",
    env: child,
    windowsHide: true,
  });
  if (run.error) return null;
  return run.status === null ? 1 : run.status;
};
