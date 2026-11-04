// #648: the Pi extension puts the Workit-owned `workit` (core/cli-locate)
// first on its process PATH when it loads, so Pi's bash tool, which inherits
// that env, runs it ahead of a stale global copy.
import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import extension from "@/packages/workit-pi/extensions/workit";
import { ownedCliHome, runWorkit } from "@/test/shared/helpers/owned-cli";

const KEYS = [
  "HOME",
  "PATH",
  "XDG_DATA_HOME",
  "XDG_BIN_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "WORKFLOW_TOOLKIT_STATE",
  "WORKIT_INSTALL_ROOT",
  "WORKIT_BIN_DIR",
  "WORKIT_CLI",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});

const load = (env: Record<string, string>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  extension({ registerTool() {}, on() {} } as never);
};

test("Given an owned install and a stale workit earlier on PATH, When the Pi extension loads, Then bash runs the owned workit", () => {
  const { env, ownedBin } = ownedCliHome(true);
  load(env);
  expect(process.env.PATH?.split(path.delimiter)[0]).toBe(ownedBin);
  expect(process.env.WORKIT_CLI).toBe(path.join(ownedBin, "workit"));
  expect(runWorkit(process.env)).toBe("owned");
});

test("Given no owned install, When the Pi extension loads, Then PATH is unchanged", () => {
  const { env } = ownedCliHome(false);
  load(env);
  expect(process.env.PATH).toBe(env.PATH);
  expect(process.env.WORKIT_CLI).toBeUndefined();
  expect(runWorkit(process.env)).toBe("stale");
});
