// The OS account's home directory, which no environment variable redirects
// (D15, #822 F1): grants and the user's own ssh and git config are read from
// it, and an agent can set $HOME, %USERPROFILE% or XDG_* for one command.
// Node's os.userInfo() asks the account record (getpwuid_r; the process
// token's profile dir on Windows); bun's follows $HOME (or %USERPROFILE%), so
// under bun it is read from the record directly. Every program runs by an
// absolute path with a fixed env, a timeout and no shell. With no record
// there is no home (null), never a fallback path: no grants are read.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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
 * dir, and every process the suite spawns inherits it. It changes nothing a
 * process reads; it only adds refusals (testRunWriteRefusal), so setting it
 * can only make a run stricter.
 */
export const TEST_RUN_ENV = "WORKIT_TEST_RUN";

/**
 * Where grants are read from: the OS account record's home directory, never
 * `$HOME` (an agent can set that for one command). The test run marker never
 * moves it (it only adds write refusals, testRunWriteRefusal). Tests swap
 * `resolve` in-process (the test preload points it at a run-scoped temp
 * home); nothing outside this process can change it. Here, with builtins
 * only, so the preload sets it without loading the config schemas.
 */
export const grantsHome: { resolve: () => string | null } = { resolve: () => accountHome() };

/**
 * The account home testRunWriteRefusal protects (test seam, set in a test's
 * own process; undefined: the OS account record's). It only picks what is
 * refused, never what is read.
 */
export const refusedHome: { value: string | null | undefined } = { value: undefined };

/**
 * The account home testRunWriteRefusal asks for when no seam gives one: looked
 * up once per process (a getent spawn each call otherwise). `resolve` is a
 * test seam to spy on; resetRefusalHome clears the memo.
 */
export const accountHomeLookup: { resolve: () => string | null } = {
  resolve: () => accountHome(),
};
let memoHome: { value: string | null } | undefined;
export const resetRefusalHome = (): void => {
  memoHome = undefined;
};
const memoizedHome = (): string | null => {
  memoHome ??= { value: accountHomeLookup.resolve() };
  return memoHome.value;
};

const MAX_LINKS = 40;

/** `file` with every symlink component (dangling or not) followed, capped. */
const followLinks = (file: string): string => {
  let pending = path.resolve(file).split(path.sep);
  let cur = pending.shift() || path.sep;
  if (/^[A-Za-z]:$/u.test(cur)) cur += path.sep;
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    const next = path.join(cur, part);
    let target: string | undefined;
    try {
      target = readlinkSync(next);
    } catch {
      // Not a link, or absent: keep the component.
    }
    if (target === undefined) {
      cur = next;
    } else {
      links += 1;
      if (links > MAX_LINKS) return path.resolve(file);
      const full = path.resolve(cur, target);
      pending.unshift(...full.split(path.sep).slice(1));
      cur = path.parse(full).root;
    }
  }
  return cur;
};

/** `file` with its deepest existing ancestor resolved (macOS /var is /private/var). */
const resolvedPath = (file: string): string => {
  let dir = followLinks(file);
  const rest: string[] = [];
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try {
    // native: Windows 8.3 short names (C:\Users\RUNNER~1) resolve to the long one.
    return path.join(realpathSync.native(dir), ...rest);
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
 * Code, Cursor, Codex, Pi, ~/.config, ~/.local/share: shell completions,
 * ~/.local/bin: launchers) or Workit's own config, state and data dirs as
 * this platform puts them (core/workit-paths.mjs; %APPDATA% and
 * %LOCALAPPDATA% under the home on Windows), its worktrees and the OS temp dir
 * aside. Paths compare as the platform does (case-insensitive on Windows). `home` is a test seam (default the account
 * record's). Without the marker, null: a user's run writes where it always did.
 */
export const testRunWriteRefusal = (
  file: string,
  home?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  /** The OS temp dir (test seam). */
  tempDir: string = os.tmpdir(),
): string | null => {
  if (env[TEST_RUN_ENV] === undefined) return null;
  const account =
    home !== undefined
      ? home
      : refusedHome.value !== undefined
        ? refusedHome.value
        : memoizedHome();
  if (account === null) return null;
  const homeEnv = { HOME: account, USERPROFILE: account };
  const roots = [
    ...[
      ".claude",
      ".cursor",
      ".codex",
      ".pi",
      ".config",
      path.join(".local", "share"),
      path.join(".local", "bin"),
    ].map((dir) => path.join(account, dir)),
    configDir(homeEnv),
    stateDir(homeEnv),
    dataDir(homeEnv),
  ].map(resolvedPath);
  const target = resolvedPath(file);
  // The OS temp dir holds fixture homes, never the account's own files: on
  // Windows it is under the home (%LOCALAPPDATA%\Temp). A fake account home
  // inside it (a test of this guard) is still protected, and a temp dir inside
  // a protected root (TMPDIR=~/.config) is no exemption.
  const tmp = resolvedPath(tempDir);
  const base = resolvedPath(account);
  if (within(tmp, target) && !within(tmp, base) && !roots.some((root) => within(root, tmp)))
    return null;
  const worktrees = path.join(resolvedPath(stateDir(homeEnv)), "worktrees");
  if (within(worktrees, target) || !roots.some((root) => within(root, target))) return null;
  return `refusing to write ${file}: a test run (${TEST_RUN_ENV}) never writes the OS account's home (#859)`;
};
