import { expect, test } from "bun:test";
import path from "node:path";
import {
  LAUNCHER_MARKER,
  locateWorkitCli,
  ownedCurrentEntry,
  ownedLauncherPath,
  useOwnedWorkitCli,
  workitCliEnv,
} from "@/packages/workit-core/src/core/cli-locate";
import { ownedCliHome, runWorkit, script } from "@/test/shared/helpers/owned-cli";

const setup = ownedCliHome;
// These simulate a POSIX PATH (":" delimiter, `sh`) on real temp paths; on
// Windows a drive letter ("C:\\") breaks that simulation. The win32 rule has
// its own test below with a fake filesystem.
const posixOnly = test.skipIf(process.platform === "win32");

posixOnly("an owned install wins over a stale workit earlier on PATH", () => {
  const { env } = setup(true);
  expect(runWorkit(env)).toBe("stale");
  const located = useOwnedWorkitCli({ env, platform: "linux" });
  expect(located.source).toBe("owned-launcher");
  expect(located.command).toBe(ownedLauncherPath(env, "linux"));
  expect(env.WORKIT_CLI).toBe(located.command);
  expect(runWorkit(env)).toBe("owned");
});

posixOnly("the owned bin dir moves to the front instead of appearing twice", () => {
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

posixOnly("old setups without an owned install keep today's PATH resolution", () => {
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
