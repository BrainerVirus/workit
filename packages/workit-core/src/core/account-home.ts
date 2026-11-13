// The OS account's home directory, which no environment variable redirects
// (D15, #822 F1): grants and the user's own ssh and git config are read from
// it, and an agent can set $HOME, %USERPROFILE% or XDG_* for one command.
// Node's os.userInfo() asks the account record (getpwuid_r; the process
// token's profile dir on Windows); bun's follows $HOME (or %USERPROFILE%), so
// under bun it is read from the record directly. Every program runs by an
// absolute path with a fixed env, a timeout and no shell. With no record
// there is no home (null), never a fallback path: no grants are read.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, dataDir, stateDir } from "./workit-paths.mjs";

/** What accountHome reads; tests pass their own with a platform. */
export type AccountIo = {
  bun: boolean;
  uid: number;
  userInfo: () => string;
  passwd: () => string;
  /** The program's stdout, "" when it failed. */
  run: (file: string, args: string[]) => string;
};

const WINDOWS = "C:\\Windows";
const SYSTEM32 = `${WINDOWS}\\System32\\`;
const PROFILES = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\";

/** The lookup programs' env: fixed, never the caller's (no LD_PRELOAD, IFS or PATH). */
export const childEnv = (platform: string): Record<string, string> =>
  platform === "win32" ? { SystemRoot: WINDOWS } : {};

const hostIo: AccountIo = {
  bun: Boolean(process.versions.bun),
  uid: process.getuid?.() ?? -1,
  userInfo: () => os.userInfo().homedir,
  passwd: () => readFileSync("/etc/passwd", "utf8"),
  run: (file, args) => {
    const done = spawnSync(file, args, {
      encoding: "utf8",
      env: childEnv(process.platform),
      timeout: 3000,
      windowsHide: true,
    });
    return done.status === 0 ? done.stdout : "";
  },
};

/** Field `at` of the passwd line (not a `#` comment) whose uid is `uid`. */
const field = (text: string, uid: string, at: number): string | undefined =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.split(":"))
    .find((fields) => fields[2] === uid)?.[at];

/**
 * A ProfileImagePath (REG_EXPAND_SZ) with only the variables the system dir
 * fixes expanded: any other `%VAR%` would come from an env, so it fails
 * closed, as does a path that is not on a drive.
 */
const profilePath = (raw: string): string | null => {
  const value = raw
    .replaceAll(/%SystemDrive%/giu, WINDOWS.slice(0, 2))
    .replaceAll(/%SystemRoot%/giu, WINDOWS);
  return /^[A-Za-z]:\\/u.test(value) && !value.includes("%") ? value : null;
};

/** The account's home, or null when no account record answers: then no grants are read. */
export const accountHome = (platform = process.platform, io: AccountIo = hostIo): string | null => {
  try {
    if (!io.bun) return io.userInfo() || null;
    if (platform === "win32") {
      const sid = /S-1-[\d-]+/u.exec(io.run(`${SYSTEM32}whoami.exe`, ["/user", "/fo", "csv"]));
      const key =
        sid && io.run(`${SYSTEM32}reg.exe`, ["query", PROFILES + sid[0], "/v", "ProfileImagePath"]);
      const raw = /ProfileImagePath\s+REG_\w+\s+(.+)/u.exec(key || "")?.[1]?.trim();
      return raw ? profilePath(raw) : null;
    }
    const uid = String(io.uid);
    let passwd = "";
    try {
      passwd = io.passwd();
    } catch {
      // No readable /etc/passwd: ask the name service below.
    }
    return (
      field(passwd, uid, 5) ||
      (platform === "darwin"
        ? field(io.run("/usr/bin/id", ["-P"]), uid, 8)
        : field(io.run("/usr/bin/getent", ["passwd", uid]), uid, 5)) ||
      null
    );
  } catch {
    return null;
  }
};

/**
 * The test run marker (#859): the test preload sets it to its run-scoped temp
 * dir, and every process the suite spawns inherits it. Not a user setting.
 */
export const TEST_RUN_ENV = "WORKIT_TEST_RUN";

const realDir = (dir: string): string | null => {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

/**
 * Under a test run, the run's temp account home: `<marker>/account-home`,
 * so a test's child process never reads or writes the OS account's grants
 * or seal. Undefined without the marker. A marker that is not an existing
 * directory inside the OS temp dir is refused: null, no account (no grants
 * read, nothing sealed), never the account record's home.
 */
export const testRunHome = (
  env: NodeJS.ProcessEnv = process.env,
  tmp: string = os.tmpdir(),
): string | null | undefined => {
  const marker = env[TEST_RUN_ENV];
  if (marker === undefined) return undefined;
  if (!path.isAbsolute(marker)) return null;
  const [dir, root] = [realDir(marker), realDir(tmp)];
  if (dir === null || root === null) return null;
  const inside = path.relative(root, dir);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return path.join(dir, "account-home");
};

const defaultResolve = (): string | null => {
  const run = testRunHome();
  return run === undefined ? accountHome() : run;
};

/**
 * Where grants are read from: the OS account record's home directory, never
 * `$HOME` (an agent can set that for one command); under the test run marker,
 * the run's temp account home (testRunHome). Tests swap `resolve` in-process
 * (the test preload points it at a run-scoped temp home). Here, with builtins
 * only, so the preload sets it without loading the config schemas.
 */
export const grantsHome: { resolve: () => string | null } = { resolve: defaultResolve };

/**
 * Whether grants come from the marker's temp home (an unswapped resolve under
 * WORKIT_TEST_RUN): there they never exceed the D4 defaults (autonomy.ts
 * grantsOverride), so setting the marker can only lower authority.
 */
export const grantsFromTestRun = (): boolean =>
  grantsHome.resolve === defaultResolve && process.env[TEST_RUN_ENV] !== undefined;

/** `file` with its deepest existing ancestor resolved (macOS /var is /private/var). */
const resolvedPath = (file: string): string => {
  let dir = path.resolve(file);
  const rest: string[] = [];
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try {
    return path.join(realpathSync(dir), ...rest);
  } catch {
    return path.resolve(file);
  }
};

const within = (root: string, file: string): boolean => {
  const inside = path.relative(root, file);
  return inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside));
};

/**
 * Why a test run must not write `file` (#859), or null: under the test run
 * marker, nothing is written in the OS account home's host settings (Claude
 * Code, Cursor, Codex, Pi, ~/.config) or Workit's own config, state and data
 * dirs (its worktrees aside). `home` is a test seam (default the account
 * record's). Without the marker, null: a user's run writes where it always did.
 */
export const testRunWriteRefusal = (
  file: string,
  home?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  if (env[TEST_RUN_ENV] === undefined) return null;
  const account = home === undefined ? accountHome() : home;
  if (account === null) return null;
  const homeEnv = { HOME: account, USERPROFILE: account };
  const roots = [
    ...[".claude", ".cursor", ".codex", ".pi", ".config"].map((dir) => path.join(account, dir)),
    configDir(homeEnv),
    stateDir(homeEnv),
    dataDir(homeEnv),
  ].map(resolvedPath);
  const target = resolvedPath(file);
  const worktrees = path.join(resolvedPath(stateDir(homeEnv)), "worktrees");
  if (within(worktrees, target) || !roots.some((root) => within(root, target))) return null;
  return `refusing to write ${file}: a test run (${TEST_RUN_ENV}) never writes the OS account's home (#859)`;
};
