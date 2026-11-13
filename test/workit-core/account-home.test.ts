// The account home (core/account-home.ts, #822 F1): grants and the user's own
// ssh and git config are read from the OS account record, which no variable a
// caller sets redirects, under node and under bun on every platform.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useConfigHome } from "../shared/grant-home";
import {
  grantsDir,
  grantsHome,
  listGrants,
  resolveAutonomy,
  writeGrants,
} from "@/packages/workit-core/src/autonomy";
import { resolveConfigDir } from "@/packages/workit-core/src/core/config";
import {
  accountHome,
  childEnv,
  type AccountIo,
} from "@/packages/workit-core/src/core/account-home";

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
  // A user's shell, without the test run marker (#859); the marker would not
  // change the home either. The children only resolve the home.
  delete env.WORKIT_TEST_RUN;
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
  for (const platform of ["linux", "darwin", "win32"] as const)
    expect(accountHome(platform, io({ bun: false, userInfo: () => "/record/home" }))).toBe(
      "/record/home",
    );
});

test("Given no account record answers, Then there is no account home: no path is built", () => {
  expect(accountHome("linux", io({ passwd: () => "" }))).toBeNull();
  expect(accountHome("darwin", io({ passwd: () => "" }))).toBeNull();
  expect(accountHome("win32", io({}))).toBeNull();
  const throwing = () => {
    throw new Error("no record");
  };
  expect(accountHome("linux", io({ bun: false, userInfo: throwing }))).toBeNull();
  expect(accountHome("win32", io({ bun: false, userInfo: throwing }))).toBeNull();
});

test("Given /etc/passwd comment lines that look like the uid's record, Then they are skipped", () => {
  const passwd = () => "#me:x:1000:1000::/planted:/bin/sh\nme:x:1000:1000::/home/me:/bin/sh\n";
  expect(accountHome("linux", io({ passwd }))).toBe("/home/me");
  expect(accountHome("linux", io({ passwd: () => "# x:x:1000:1:/planted\n" }))).toBeNull();
});

test("Given the lookup programs, Then they get a fixed minimal env, never the caller's", () => {
  expect(childEnv("linux")).toEqual({});
  expect(childEnv("darwin")).toEqual({});
  expect(childEnv("win32")).toEqual({ SystemRoot: "C:\\Windows" });
});

const profile = (value: string) => (file: string) =>
  file.endsWith("whoami.exe")
    ? '"host\\me","S-1-5-21-9"\r\n'
    : `    ProfileImagePath    REG_EXPAND_SZ    ${value}\r\n`;

test("Given a REG_EXPAND_SZ ProfileImagePath, Then only %SystemDrive% and %SystemRoot% expand, from the system dir, and anything else fails closed", () => {
  expect(accountHome("win32", io({ run: profile("%SystemDrive%\\Users\\me") }))).toBe(
    "C:\\Users\\me",
  );
  expect(accountHome("win32", io({ run: profile("%SystemRoot%\\Profiles\\me") }))).toBe(
    "C:\\Windows\\Profiles\\me",
  );
  for (const value of ["%USERPROFILE%", "%HOMEDRIVE%\\Users\\me", "Users\\me", "\\\\srv\\me"])
    expect(accountHome("win32", io({ run: profile(value) })), value).toBeNull();
});

test("Given no account home, Then no grants are read or written, and the write guard's dir is the config dir", () => {
  const configHome = useConfigHome("wk-no-account-");
  const saved = grantsHome.resolve;
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wk-no-account-repo-"));
    writeFileSync(
      path.join(configHome.configDir, "workspaces.json"),
      JSON.stringify({ workspaces: [{ name: "w", glob: `${dir}/**`, autonomy: { merge: true } }] }),
    );
    expect(resolveAutonomy(dir).workspace).toBe("w");
    grantsHome.resolve = () => null;
    const autonomy = resolveAutonomy(dir);
    expect(autonomy.workspace).toBeNull();
    expect(autonomy.grants.merge).toBe(false);
    expect(autonomy.note).toContain("no OS account record");
    expect(listGrants().error).toContain("no OS account record");
    const written = writeGrants("w", [{ kind: "merge", value: false }]);
    expect(written.ok).toBe(false);
    expect(grantsDir()).toBe(resolveConfigDir());
    rmSync(dir, { recursive: true, force: true });
  } finally {
    grantsHome.resolve = saved;
    configHome.restore();
  }
});
