// #648: the OpenCode plugin hands every agent shell the Workit-owned `workit`
// (core/cli-locate) ahead of a stale global copy earlier on PATH; a V2 build
// with no shell domain gets it through the plugin process's env.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import definition from "@/packages/workit-opencode/src/v2/plugin";
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
const roots: string[] = [];
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The plugin process runs with `env` (the temp HOME), as OpenCode would start it. */
const useEnv = (env: Record<string, string>) => {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
};

const setupPlugin = async (withShell: boolean) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-oc-owned-"));
  roots.push(root);
  mkdirSync(path.join(root, ".git"));
  const shellHooks = new Map<string, (event: any) => Promise<void> | void>();
  const noop = async () => ({ dispose: async () => {} });
  const editor = {
    list: () => [],
    add: () => {},
    get: () => undefined,
    update: () => {},
    remove: () => {},
  };
  const ctx = {
    location: { directory: root },
    session: {
      get: async () => null,
      hook: noop,
      context: async () => [],
      synthetic: async () => {},
    },
    skill: {
      list: async () => ({ data: [] }),
      transform: async (fn: (e: unknown) => void) => fn(editor),
    },
    command: {
      list: async () => ({ data: [] }),
      transform: async (fn: (e: unknown) => void) => fn(editor),
    },
    permission: { hook: noop },
    ...(withShell
      ? {
          shell: {
            hook: async (name: string, fn: (event: any) => Promise<void> | void) => {
              shellHooks.set(name, fn);
            },
          },
        }
      : {}),
    tool: {
      transform: async (fn: (e: unknown) => void) => {
        fn(editor);
        return { dispose: async () => {} };
      },
      hook: noop,
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            while (!signal.aborted) await Bun.sleep(5);
            return { done: true, value: undefined };
          },
        }),
      }),
    },
  };
  const teardown = await definition.setup(ctx as never);
  const shell = async () => {
    const event = {
      command: "workit",
      cwd: root,
      timeout: 0,
      shell: "sh",
      env: {} as Record<string, string | undefined>,
    };
    await shellHooks.get("create.before")!(event);
    return event.env;
  };
  return { shell, cleanup: () => typeof teardown === "function" && void teardown() };
};

test("Given an owned install and a stale workit earlier on PATH, When OpenCode creates a shell, Then the shell runs the owned workit", async () => {
  const { env, ownedBin } = ownedCliHome(true);
  useEnv(env);
  const plugin = await setupPlugin(true);
  try {
    const shellEnv = await plugin.shell();
    expect(shellEnv.PATH?.split(path.delimiter)[0]).toBe(ownedBin);
    expect(runWorkit({ ...process.env, ...shellEnv })).toBe("owned");
    // The plugin process itself is left alone: only its shells change.
    expect(process.env.PATH).toBe(env.PATH);
  } finally {
    plugin.cleanup();
  }
});

test("Given no owned install, When OpenCode creates a shell, Then PATH resolution is unchanged", async () => {
  const { env } = ownedCliHome(false);
  useEnv(env);
  const plugin = await setupPlugin(true);
  try {
    const shellEnv = await plugin.shell();
    expect(shellEnv.PATH).toBeUndefined();
    expect(shellEnv.WORKIT_CLI).toBeUndefined();
    expect(runWorkit({ ...process.env, ...shellEnv })).toBe("stale");
  } finally {
    plugin.cleanup();
  }
});

test("Given a V2 build with no shell domain, When the plugin loads, Then its process env runs the owned workit", async () => {
  const { env, ownedBin } = ownedCliHome(true);
  useEnv(env);
  const plugin = await setupPlugin(false);
  try {
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(ownedBin);
    expect(runWorkit(process.env)).toBe("owned");
  } finally {
    plugin.cleanup();
  }
});
