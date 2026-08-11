import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Set the state/config dirs BEFORE importing the plugin so its logger resolves
// a scratch state dir (no writes to the real home) and config reads stay local.
// The env is restored in afterAll so sibling test files in the same worker are
// not polluted. The `?boundary-test` query forces a fresh plugin module instance
// so the logger's rate budget is not exhausted by sibling test files that
// import the plugin in the same process.
const tempDirs: string[] = [];
const persistentDirs: string[] = [];
const scratchDir = (prefix: string, persistent = false): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  (persistent ? persistentDirs : tempDirs).push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const previousState = process.env.WORKFLOW_TOOLKIT_STATE;
const previousConfig = process.env.WORKFLOW_TOOLKIT_CONFIG;
process.env.WORKFLOW_TOOLKIT_STATE = scratchDir("wf-open-state-", true);
process.env.WORKFLOW_TOOLKIT_CONFIG = scratchDir("wf-open-cfg-", true);
afterAll(() => {
  if (previousState === undefined) delete process.env.WORKFLOW_TOOLKIT_STATE;
  else process.env.WORKFLOW_TOOLKIT_STATE = previousState;
  if (previousConfig === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousConfig;
  for (const dir of persistentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Dynamic (non-literal) specifier: tsc skips module resolution, bun re-evaluates
// the module fresh for this file only (isolated logger + rate budget).
const pluginSpecifier = "../../packages/workit-opencode/src/plugin.ts?boundary-test";
const pluginModule = await import(pluginSpecifier);
const { default: plugin, loadCommandTemplates, loadProvenance, reportUncaught } = pluginModule;

type Captured = { level: string; message: string; context: Record<string, unknown> };

const makeClient = (): { client: unknown; events: Captured[] } => {
  const events: Captured[] = [];
  const client = {
    app: {
      async log(options: {
        body: {
          service: string;
          level: string;
          message: string;
          extra: Record<string, unknown>;
        };
      }) {
        events.push({
          level: options.body.level,
          message: options.body.message,
          context: options.body.extra,
        });
        return {};
      },
    },
  };
  return { client, events };
};

const clientArgs = {
  directory: "/repo",
  worktree: "/repo",
  serverUrl: new URL("http://localhost"),
};

const userMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "p",
      messageID: "u",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

test("startup boundaries emit initialization, provenance, and configuration_source events", async () => {
  const { client, events } = makeClient();
  const hooks = await plugin({ client, ...clientArgs } as never);
  const names = events.map((e) => e.message);
  expect(names).toContain("initialization");
  expect(names).toContain("provenance");
  expect(names).toContain("configuration_source");

  const init = events.find((e) => e.message === "initialization")!;
  expect(init.level).toBe("info");
  expect(init.context.host).toBe("opencode");

  const prov = events.find((e) => e.message === "provenance")!;
  expect(prov.context.name).toEndWith("workit-opencode");
  expect(prov.context.version).toBeTruthy();

  const cfg = events.find((e) => e.message === "configuration_source")!;
  expect(cfg.context.source).toBe("defaults");
  expect(typeof cfg.context.config_dir).toBe("string");

  // host usability preserved: tools register and the config hook still works
  expect(hooks.tool?.workflow_verify).toBeDefined();
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  expect(Object.keys(config.command).length).toBeGreaterThan(0);
  expect(config.skills.paths.length).toBeGreaterThan(0);
});

test("configuration_source event reports a malformed config file", async () => {
  const configFile = path.join(process.env.WORKFLOW_TOOLKIT_CONFIG!, "config.json");
  writeFileSync(configFile, "{not valid json");
  try {
    const { client, events } = makeClient();
    await plugin({ client, ...clientArgs } as never);
    const cfg = events.find((e) => e.message === "configuration_source")!;
    expect(cfg.context.source).toBe("defaults");
    expect(cfg.context.malformed).toBe(true);
  } finally {
    rmSync(configFile, { force: true });
  }
});

test("provenance boundary failure is sanitized and mirrored", async () => {
  const { client, events } = makeClient();
  await plugin({ client, ...clientArgs } as never);
  events.length = 0;
  const missing = path.join(scratchDir("wf-prov-token=sk-live-6-"), "package.json");
  loadProvenance(missing);
  const prov = events.find((e) => e.message === "provenance")!;
  expect(prov).toBeDefined();
  expect(prov.level).toBe("warn");
  const raw = JSON.stringify(prov);
  expect(raw).not.toContain("sk-live-6");
  expect(raw.toLowerCase()).toContain("[redacted]");
});

test("assets boundary failure is bounded, sanitized, and mirrored", async () => {
  const { client, events } = makeClient();
  await plugin({ client, ...clientArgs } as never);
  events.length = 0;
  const missingRoot = scratchDir("wf-assets-token=sk-live-9-");
  const loaded = loadCommandTemplates(missingRoot, ["wk-init"]);
  expect(Object.keys(loaded)).toEqual([]);
  const assets = events.filter((e) => e.message === "assets");
  expect(assets.length).toBe(1);
  expect(assets[0].level).toBe("warn");
  expect(assets[0].context.name).toBe("wk-init");
  const raw = JSON.stringify(assets[0]);
  expect(raw).not.toContain("sk-live-9");
  expect(raw.toLowerCase()).toContain("[redacted]");
});

test("hooks boundary failure is logged and the session survives", async () => {
  const { client, events } = makeClient();
  // Discovery scans the host workspace (the plugin `directory`), not
  // process.cwd() (FG-06): a docs/ path that is a file throws on scan.
  const hookCwd = scratchDir("wf-hooks-");
  writeFileSync(path.join(hookCwd, "docs"), "a regular file, not a directory");
  const hooks = await plugin({
    client,
    directory: hookCwd,
    worktree: hookCwd,
    serverUrl: new URL("http://localhost"),
  } as never);
  events.length = 0;
  const output = { messages: [userMessage("hello")] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  const hookEvents = events.filter((e) => e.message === "hooks");
  expect(hookEvents.length).toBe(1);
  expect(hookEvents[0].level).toBe("warn");
  expect(hookEvents[0].context.boundary).toBe("chat.messages.transform");

  // host usability preserved: a fresh plugin still registers tools
  const reloaded = await plugin({
    client: makeClient().client,
    ...clientArgs,
  } as never);
  expect(reloaded.tool?.workflow_verify).toBeDefined();
});

test("uncaught failure boundary is bounded and sanitized", async () => {
  const { client, events } = makeClient();
  await plugin({ client, ...clientArgs } as never);
  events.length = 0;
  reportUncaught("unhandledRejection", new Error("Bearer sk-live-7 https://x.test/p?token=qv"));
  const uncaught = events.find((e) => e.message === "uncaught_failure")!;
  expect(uncaught).toBeDefined();
  expect(uncaught.level).toBe("error");
  expect(uncaught.context.phase).toBe("unhandledRejection");
  const raw = JSON.stringify(uncaught);
  expect(raw).not.toContain("sk-live-7");
  expect(raw).not.toContain("token=qv");
  expect(raw.toLowerCase()).toContain("[redacted]");
});
