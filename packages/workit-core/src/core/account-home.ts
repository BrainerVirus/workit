// The OS account's home directory, which no environment variable redirects
// (D15, #822 F1): grants and the user's own ssh and git config are read from
// it, and an agent can set $HOME, %USERPROFILE% or XDG_* for one command.
// Node's os.userInfo() asks the account record (getpwuid_r; the process
// token's profile dir on Windows); bun's follows $HOME (or %USERPROFILE%), so
// under bun it is read from the record directly. Every program runs by an
// absolute path (PATH is the caller's too), with a timeout and no shell.
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

const SYSTEM32 = "C:\\Windows\\System32\\";
const PROFILES = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\";
/** No account record answered: a home no user can create, so no grants. */
export const NO_HOME = "/nonexistent";

const hostIo: AccountIo = {
  bun: Boolean(process.versions.bun),
  uid: process.getuid?.() ?? -1,
  userInfo: () => os.userInfo().homedir,
  passwd: () => readFileSync("/etc/passwd", "utf8"),
  run: (file, args) => {
    const done = spawnSync(file, args, {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return done.status === 0 ? done.stdout : "";
  },
};

/** Field `at` of the passwd line whose uid is `uid`. */
const field = (text: string, uid: string, at: number): string | undefined =>
  text
    .split("\n")
    .map((line) => line.split(":"))
    .find((fields) => fields[2] === uid)?.[at];

export const accountHome = (platform = process.platform, io: AccountIo = hostIo): string => {
  try {
    if (!io.bun) return io.userInfo();
    if (platform === "win32") {
      const sid = /S-1-[\d-]+/u.exec(io.run(`${SYSTEM32}whoami.exe`, ["/user", "/fo", "csv"]));
      const key =
        sid && io.run(`${SYSTEM32}reg.exe`, ["query", PROFILES + sid[0], "/v", "ProfileImagePath"]);
      return /ProfileImagePath\s+REG_\w+\s+(.+)/u.exec(key || "")?.[1]?.trim() || NO_HOME;
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
      NO_HOME
    );
  } catch {
    return NO_HOME;
  }
};
