// Issue #325 on OpenCode V2: execute.before rewrites a heavy shell command
// through the lease before the shell-session correlation notes the call, so
// `shell.create.before`, which sees the rewritten command, still finds the
// calling session and gives a child its derived Workit session.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import definition from "@/packages/workit-opencode/src/v2/plugin";

const saved = { PATH: process.env.PATH, STATE: process.env.WORKFLOW_TOOLKIT_STATE };
let root: string;
let bin: string;
let state: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "workit-v2-heavy-"));
  mkdirSync(path.join(root, ".git"));
  bin = mkdtempSync(path.join(os.tmpdir(), "workit-v2-heavy-bin-"));
  writeFileSync(path.join(bin, "workit"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "workit"), 0o755);
  state = mkdtempSync(path.join(os.tmpdir(), "workit-v2-heavy-state-"));
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.WORKFLOW_TOOLKIT_STATE = state;
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.STATE === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = saved.STATE;
  for (const dir of [root, bin, state]) rmSync(dir, { recursive: true, force: true });
});

const harness = async (sessions: Record<string, { parentID?: string }>) => {
  const toolHooks = new Map<string, (event: any) => Promise<void>>();
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
      get: async ({ sessionID }: { sessionID: string }) =>
        sessions[sessionID]
          ? { id: sessionID, ...sessions[sessionID], location: { directory: root } }
          : null,
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
    shell: {
      hook: async (name: string, fn: (event: any) => Promise<void> | void) => {
        shellHooks.set(name, fn);
      },
    },
    tool: {
      transform: async (fn: (e: unknown) => void) => {
        fn(editor);
        return { dispose: async () => {} };
      },
      hook: async (name: string, fn: (event: any) => Promise<void>) => {
        toolHooks.set(name, fn);
      },
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
  /** One shell tool call: what OpenCode would hand create.before after execute.before. */
  const shell = async (sessionID: string, command: string) => {
    const input = { command };
    await toolHooks.get("execute.before")!({ tool: "shell", sessionID, id: "c1", input });
    const event = { command: input.command, cwd: root, timeout: 0, shell: "bash", env: {} };
    await shellHooks.get("create.before")!(event);
    return event as { command: string; env: Record<string, string | undefined> };
  };
  return { shell, cleanup: () => typeof teardown === "function" && void teardown() };
};

test("Given a child session's raw `npx jest`, When OpenCode creates its shell, Then the shell runs the lease rewrite and carries the child's derived session", async () => {
  const plugin = await harness({ ses_lead: {}, ses_child: { parentID: "ses_lead" } });
  try {
    const created = await plugin.shell("ses_child", "npx jest");
    expect(created.command).toBe("workit check --heavy -- npx jest");
    expect(created.env.WORKIT_SESSION_ID).toBe("ses_lead:ses_child");
  } finally {
    plugin.cleanup();
  }
});
