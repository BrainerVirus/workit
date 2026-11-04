import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LAUNCHER_MARKER as CLI_MARKER,
  installRoot as cliInstallRoot,
  launcherDir as cliLauncherDir,
  ownedPaths,
} from "@/packages/workit-cli/src/install/paths";
import {
  LAUNCHER_MARKER,
  installRoot,
  launcherDir,
  locateWorkitCli,
  ownedCurrentEntry,
  ownedLauncherPath,
  useOwnedWorkitCli,
  workitCliEnv,
} from "@/packages/workit-core/src/core/cli-locate";
import { opencodeShellEnv, useOwnedCliInOpencode } from "@/packages/workit-opencode/src/cli-path";
import { useOwnedCliInPi } from "@/packages/workit-pi/src/cli-path";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempHome = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workit-cli-locate-"));
  temps.push(dir);
  return dir;
};

const script = (file: string, body: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

/** A HOME with a stale global `workit` on PATH and, optionally, an owned install. */
const setup = (owned: boolean) => {
  const home = tempHome();
  const stale = path.join(home, "stale-bin");
  script(path.join(stale, "workit"), "echo stale");
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${stale}:/usr/bin:/bin` };
  if (owned) script(ownedLauncherPath(env, "linux"), `# ${LAUNCHER_MARKER} 1: test\necho owned`);
  return { home, stale, env };
};

const runWorkit = (env: NodeJS.ProcessEnv): string =>
  spawnSync("/bin/sh", ["-c", "workit"], {
    env,
    encoding: "utf8",
  }).stdout.trim();

test("the core locations match the CLI installer's for every override", () => {
  const cases: NodeJS.ProcessEnv[] = [
    { HOME: "/h" },
    { HOME: "/h", XDG_DATA_HOME: "/d", XDG_BIN_HOME: "/b" },
    { HOME: "/h", WORKIT_INSTALL_ROOT: "/r", WORKIT_BIN_DIR: "/w" },
  ];
  for (const platform of ["linux", "darwin"] as const)
    for (const env of cases) {
      expect(installRoot(env, platform)).toBe(cliInstallRoot(env, platform));
      expect(launcherDir(env, platform)).toBe(cliLauncherDir(env, platform));
      expect(ownedLauncherPath(env, platform)).toBe(ownedPaths(env, platform).launcher);
    }
  const win = { USERPROFILE: "C:\\u", LOCALAPPDATA: "C:\\l" };
  expect(installRoot(win, "win32")).toBe(cliInstallRoot(win, "win32"));
  expect(ownedLauncherPath(win, "win32")).toBe(ownedPaths(win, "win32").launcher);
  expect(LAUNCHER_MARKER).toBe(CLI_MARKER);
});

test("an owned install wins over a stale workit earlier on PATH", () => {
  const { env } = setup(true);
  expect(runWorkit(env)).toBe("stale");
  const located = useOwnedWorkitCli({ env, platform: "linux" });
  expect(located.source).toBe("owned-launcher");
  expect(located.command).toBe(ownedLauncherPath(env, "linux"));
  expect(env.WORKIT_CLI).toBe(located.command);
  expect(runWorkit(env)).toBe("owned");
});

test("the owned bin dir moves to the front instead of appearing twice", () => {
  const { env } = setup(true);
  const bin = path.dirname(ownedLauncherPath(env, "linux"));
  env.PATH = `/usr/bin:${bin}:/bin`;
  const patch = workitCliEnv(locateWorkitCli({ env, platform: "linux" }), env, "linux");
  expect(patch.PATH).toBe(`${bin}:/usr/bin:/bin`);
});

test("Windows keeps its Path key and ; delimiter", () => {
  const env: NodeJS.ProcessEnv = {
    LOCALAPPDATA: "C:\\l",
    Path: "C:\\stale;C:\\Windows",
  };
  const launcher = ownedLauncherPath(env, "win32");
  const located = locateWorkitCli({
    env,
    platform: "win32",
    exists: (file) => file === launcher,
    read: () => `@echo off\nrem ${LAUNCHER_MARKER} 1`,
  });
  const patch = workitCliEnv(located, env, "win32");
  expect(patch.Path).toBe(`${path.dirname(launcher)};C:\\stale;C:\\Windows`);
  expect(patch.PATH).toBeUndefined();
});

test("a file at the launcher path without the marker is not trusted", () => {
  const { env } = setup(false);
  script(ownedLauncherPath(env, "linux"), "echo impostor");
  expect(locateWorkitCli({ env, platform: "linux" }).source).toBe("path");
});

test("with only the owned current entry, node runs it and PATH is untouched", () => {
  const { env } = setup(false);
  const entry = ownedCurrentEntry(env, "linux");
  script(entry, "");
  const before = env.PATH;
  const located = useOwnedWorkitCli({
    env,
    platform: "linux",
    node: "/n/node",
  });
  expect(located).toEqual({
    source: "owned-current",
    command: "/n/node",
    args: [entry],
    binDir: null,
  });
  expect(env.PATH).toBe(before);
  expect(env.WORKIT_CLI).toBe(`/n/node ${entry}`);
});

test("a bundled CLI is used only when there is no owned install", () => {
  const { home, env } = setup(false);
  const bundled = path.join(home, "bundled", "index.js");
  script(bundled, "");
  expect(locateWorkitCli({ env, platform: "linux", bundled, node: "/n" })).toEqual({
    source: "bundled",
    command: "/n",
    args: [bundled],
    binDir: null,
  });
  script(ownedLauncherPath(env, "linux"), `# ${LAUNCHER_MARKER} 1`);
  expect(locateWorkitCli({ env, platform: "linux", bundled }).source).toBe("owned-launcher");
});

test("old setups without an owned install keep today's PATH resolution", () => {
  const { env } = setup(false);
  const before = { ...env };
  const located = useOwnedWorkitCli({ env, platform: "linux" });
  expect(located).toEqual({
    source: "path",
    command: "workit",
    args: [],
    binDir: null,
  });
  expect(env).toEqual(before);
  expect(runWorkit(env)).toBe("stale");
});

test("the OpenCode plugin and Pi extension hand their shells the owned workit", () => {
  if (process.platform === "win32") return;
  const opencode = setup(true).env;
  expect(runWorkit({ ...opencode, ...opencodeShellEnv(opencode) })).toBe("owned");
  expect(useOwnedCliInOpencode(opencode).source).toBe("owned-launcher");
  expect(runWorkit(opencode)).toBe("owned");
  const pi = setup(true).env;
  expect(useOwnedCliInPi(pi).source).toBe("owned-launcher");
  expect(runWorkit(pi)).toBe("owned");
  const old = setup(false).env;
  expect(opencodeShellEnv(old)).toEqual({});
});
