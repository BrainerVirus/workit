// A temp HOME with a stale global `workit` first on PATH and, optionally, a
// Workit-owned install (core/cli-locate), for the host launcher wiring tests.
import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCHER_MARKER, ownedLauncherPath } from "@/packages/workit-core/src/core/cli-locate";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const script = (file: string, body: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

/**
 * HOME, XDG and state all point inside one temp dir; `stale-bin/workit`
 * prints "stale", the owned launcher (when `owned`) prints "owned".
 */
export const ownedCliHome = (owned: boolean) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-owned-cli-"));
  dirs.push(home);
  const stale = path.join(home, "stale-bin");
  script(path.join(stale, "workit"), "echo stale");
  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_BIN_HOME: path.join(home, ".local", "bin"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    WORKIT_STATE_DIR: path.join(home, "state"),
    PATH: [stale, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  };
  const launcher = ownedLauncherPath(env, "linux");
  if (owned) script(launcher, `# ${LAUNCHER_MARKER} 1: test\necho owned`);
  return { home, stale, env, ownedBin: path.dirname(launcher) };
};

/** What `workit` in a shell started from `env` prints. */
export const runWorkit = (env: NodeJS.ProcessEnv): string =>
  spawnSync("/bin/sh", ["-c", "workit"], { env, encoding: "utf8" }).stdout.trim();

/**
 * A bun --preload script that writes the process's final PATH and WORKIT_CLI
 * to `out` on exit: what an entry left in its own env.
 */
export const envProbe = (home: string) => {
  const out = path.join(home, "probe.json");
  const preload = path.join(home, "probe.ts");
  writeFileSync(
    preload,
    `process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ PATH: process.env.PATH, WORKIT_CLI: process.env.WORKIT_CLI ?? null })));\n`,
  );
  return {
    preload,
    read: (): { PATH: string; WORKIT_CLI: string | null } | null =>
      existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null,
  };
};
