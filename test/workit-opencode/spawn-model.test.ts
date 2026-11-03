// #654: OpenCode's `subagent` tool takes `model` (providerID/modelID), so the
// plugin's execute.before sets the configured role model on each fresh spawn;
// before, OpenCode ran every subagent on the lead's model whatever
// models.roles said.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import definition from "@/packages/workit-opencode/src/v2/plugin";
import { applySpawnModel } from "@/packages/workit-opencode/src/v2/spawn-model";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
let root: string;
beforeAll(() => {
  configHome = useConfigHome("wk-oc-spawn-model-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-oc-spawn-model-cwd-")));
  spawnSync("git", ["init", "-q", "-b", "feature/models"], { cwd: root });
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const config = (models: unknown): void =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ models }));

type Hook = (event: any) => Promise<void> | void;

/** The plugin set up against a fake OpenCode V2 context: one lead session, no task. */
const plugin = async () => {
  const toolHooks = new Map<string, Hook>();
  const sessionHooks = new Map<string, Hook>();
  const noop = async () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: root },
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        sessionID === "ses_lead" ? { id: sessionID, location: { directory: root } } : null,
      hook: async (name: string, fn: Hook) => void sessionHooks.set(name, fn),
      context: async () => [],
      synthetic: async () => {},
    },
    skill: {
      list: async () => ({ data: [] }),
      transform: async (fn: (editor: unknown) => void) =>
        fn({
          list: () => [],
          add: () => {},
          get: () => undefined,
          update: () => {},
          remove: () => {},
        }),
    },
    command: {
      list: async () => ({ data: [] }),
      transform: async (fn: (editor: unknown) => void) => fn({ add: () => {} }),
    },
    permission: { hook: noop },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({ add: () => {} });
        return { dispose: async () => {} };
      },
      hook: async (name: string, fn: Hook) => void toolHooks.set(name, fn),
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
  let calls = 0;
  /** One subagent call from the lead: the input the host then runs the tool with. */
  const spawn = async (input: Record<string, unknown>) => {
    const event = { tool: "subagent", sessionID: "ses_lead", id: `call-${++calls}`, input };
    await toolHooks.get("execute.before")!(event);
    return event.input;
  };
  /** What the lead's next context build gains. */
  const nextTurn = async (): Promise<string> => {
    const system: Array<{ type: "text"; text: string }> = [];
    await sessionHooks.get("context")!({ sessionID: "ses_lead", system, messages: [], model: {} });
    return system.map((part) => part.text).join("\n");
  };
  const close = (): void => {
    if (typeof teardown === "function") void teardown();
  };
  return { spawn, nextTurn, close };
};

test("G models.roles.verifier set to an OpenCode provider/model, W the lead spawns a verifier subagent, T the plugin sets that model on the spawn", async () => {
  config({ roles: { verifier: { opencode: "anthropic/claude-sonnet-5-5" } } });
  const host = await plugin();
  try {
    expect(
      await host.spawn({
        agent: "general",
        description: "verify",
        prompt: "ROLE: verifier\nCheck.",
      }),
    ).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
    expect(
      await host.spawn({ agent: "workit-verifier", description: "verify", prompt: "Check." }),
    ).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
    expect(await host.nextTurn()).toContain("Workit set anthropic/claude-sonnet-5-5");
  } finally {
    host.close();
  }
});

test("G a configured verifier model, W the lead passes another model, T the configured one wins and a note says so; allowLeadOverride true keeps the lead's", async () => {
  config({ roles: { verifier: { opencode: "openai/gpt-5.5" } } });
  const host = await plugin();
  try {
    const input = await host.spawn({
      agent: "general",
      prompt: "ROLE: verifier\nCheck.",
      model: "openai/gpt-5-mini",
    });
    expect(input).toMatchObject({ model: "openai/gpt-5.5" });
    const note = await host.nextTurn();
    expect(note).toContain("replaced model openai/gpt-5-mini with openai/gpt-5.5");
    expect(note).toContain('"allowLeadOverride": true');
    // Delivered once.
    expect(await host.nextTurn()).not.toContain("replaced model");
    config({ roles: { verifier: { opencode: "openai/gpt-5.5" } }, allowLeadOverride: true });
    expect(
      await host.spawn({ agent: "general", prompt: "ROLE: verifier", model: "openai/gpt-5-mini" }),
    ).toMatchObject({ model: "openai/gpt-5-mini" });
  } finally {
    host.close();
  }
});

test("G models.roles.default, W a general spawn with no role, T the default model is applied; a continuation keeps its child's model", async () => {
  config({ roles: { default: { opencode: "openai/gpt-5-mini" } } });
  const host = await plugin();
  try {
    expect(await host.spawn({ agent: "general", prompt: "look around" })).toMatchObject({
      model: "openai/gpt-5-mini",
    });
    const continued = { agent: "general", prompt: "more", sessionID: "ses_child" };
    applySpawnModel(root, { sessionID: "ses_lead", input: continued }, new Map());
    expect(continued).not.toHaveProperty("model");
  } finally {
    host.close();
  }
});

test("G a configured value that is not providerID/modelID, W a verifier spawn runs, T the spawn keeps its own model and the note names the fix", async () => {
  config({ roles: { verifier: "sonnet" } });
  const host = await plugin();
  try {
    const input = await host.spawn({ agent: "general", prompt: "ROLE: verifier" });
    expect(input).not.toHaveProperty("model");
    const note = await host.nextTurn();
    expect(note).toContain("could not apply sonnet");
    expect(note).toContain("workit models show --role verifier");
  } finally {
    host.close();
  }
});
