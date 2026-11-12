// The OS account's home directory, which no environment variable redirects
// (D15, #822 F1): grants and the user's own ssh and git config are read from
// it, and an agent can set $HOME, %USERPROFILE% or XDG_* for one command.
// Node's os.userInfo() asks the account record (getpwuid_r; the process
// token's profile dir on Windows); bun's follows $HOME (or %USERPROFILE%), so
// under bun it is read from the record directly. Every program runs by an
// absolute path with a fixed env, a timeout and no shell. With no record
// there is no home (null), never a fallback path: no grants are read.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

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
