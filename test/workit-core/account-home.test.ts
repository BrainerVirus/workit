// The account home (core/account-home.ts, #822 F1): grants and the user's own
// ssh and git config are read from the OS account record, which no variable a
// caller sets redirects, under node and under bun on every platform.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { accountHome, NO_HOME, type AccountIo } from "@/packages/workit-core/src/core/account-home";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const CORE = path.join(ROOT, "packages", "workit-core", "src");
const FAKE = mkdtempSync(path.join(os.tmpdir(), "wk-fake-home-"));
afterAll(() => rmSync(FAKE, { recursive: true, force: true }));

/** Every variable a caller could point at a home of its own. */
const fakeEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_\w+)$/u.test(key))
      env[key] = value;
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"])
    env[key] = FAKE;
  return env;
};

const spawnOut = (file: string, args: string[]): string => {
  const done = spawnSync(file, args, {
    env: fakeEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(done.status, done.stderr).toBe(0);
  return done.stdout.trim();
};

/** Node's os.userInfo() reads the account record (getpwuid_r, the token's profile dir). */
const recordHome = (): string =>
  spawnOut("node", ["-e", "console.log(require('node:os').userInfo().homedir)"]);

const importing = (file: string, expression: string): string =>
  `import * as m from ${JSON.stringify(pathToFileURL(path.join(CORE, file)).href)}; console.log(${expression});`;

test("Given HOME, USERPROFILE and XDG_* point elsewhere, When bun resolves the grants home, Then it is the account record's home", () => {
  const real = recordHome();
  expect(real).not.toBe(FAKE);
  const script = importing("autonomy.ts", "m.grantsHome.resolve()");
  expect(spawnOut(process.execPath, ["-e", script])).toBe(real);
});

test("Given HOME, USERPROFILE and XDG_* point elsewhere, When node or bun resolve the account home, Then both read the account record", () => {
  const real = recordHome();
  const script = importing("core/account-home.ts", "m.accountHome()");
  expect(spawnOut(process.execPath, ["-e", script])).toBe(real);
  expect(spawnOut("node", ["--input-type=module", "-e", script])).toBe(real);
});

const io = (over: Partial<AccountIo>): AccountIo => ({
  bun: true,
  uid: 1000,
  userInfo: () => "/followed/home",
  passwd: () => "root:x:0:0::/root:/bin/sh\nme:x:1000:1000:Me:/home/me:/bin/zsh\n",
  run: () => "",
  ...over,
});

test("Given bun on Linux, Then the home is the /etc/passwd line of the uid, never os.userInfo()", () => {
  expect(accountHome("linux", io({}))).toBe("/home/me");
});

test("Given bun on Linux and a uid /etc/passwd lacks, Then getent is asked by absolute path with the uid, and nothing else", () => {
  const calls: string[][] = [];
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return "ldap:*:2000:2000::/net/home/ldap:/bin/sh\n";
  };
  expect(accountHome("linux", io({ uid: 2000, passwd: () => "", run }))).toBe("/net/home/ldap");
  expect(calls).toEqual([["/usr/bin/getent", "passwd", "2000"]]);
});

test("Given bun on macOS, Then the home is the 10-field record `id -P` prints", () => {
  const run = (file: string, args: string[]) =>
    file === "/usr/bin/id" && args[0] === "-P"
      ? "me:********:501:20::0:0:Me:/Users/me:/bin/zsh\n"
      : "";
  expect(accountHome("darwin", io({ uid: 501, passwd: () => "", run }))).toBe("/Users/me");
});

test("Given bun on Windows, Then the home is the ProfileList entry of the token's SID, not %USERPROFILE%", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const calls: string[] = [];
  const run = (file: string, args: string[]) => {
    calls.push(file);
    if (file.endsWith("whoami.exe")) return `"host\\me","${sid}"\r\n`;
    return args[1]?.endsWith(sid)
      ? `\r\nHKEY_LOCAL_MACHINE\\...\\${sid}\r\n    ProfileImagePath    REG_EXPAND_SZ    C:\\Users\\me\r\n`
      : "";
  };
  expect(accountHome("win32", io({ run }))).toBe("C:\\Users\\me");
  expect(calls).toEqual(["C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\reg.exe"]);
});

test("Given node, Then the home is os.userInfo() (the account record) on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"])
    expect(accountHome(platform, io({ bun: false, userInfo: () => "/record/home" }))).toBe(
      "/record/home",
    );
});

test("Given no account record answers, Then the home is one no user can create, so no grants are read", () => {
  expect(accountHome("linux", io({ passwd: () => "" }))).toBe(NO_HOME);
  expect(accountHome("win32", io({}))).toBe(NO_HOME);
  const throwing = () => {
    throw new Error("no record");
  };
  expect(accountHome("linux", io({ bun: false, userInfo: throwing }))).toBe(NO_HOME);
});
