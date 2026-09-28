import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import { server as plugin } from "@/packages/workit-opencode/src/index";

const previousEnv = {
  config: process.env.WORKFLOW_TOOLKIT_CONFIG,
  configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  profile: process.env.WORKFLOW_PROFILE,
  workspace: process.env.WORKFLOW_WORKSPACE_NAME,
};
let configDir: string;
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "workit-opencode-route-config-"));
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = configDir;
  delete process.env.WORKFLOW_PROFILE;
  delete process.env.WORKFLOW_WORKSPACE_NAME;
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      branchPolicy: { preset: "custom", allowed: ["feature/*"], protected: ["main"] },
    }),
  );
});
afterAll(() => {
  if (previousEnv.config === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  else process.env.WORKFLOW_TOOLKIT_CONFIG = previousEnv.config;
  if (previousEnv.configDir === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  else process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = previousEnv.configDir;
  if (previousEnv.profile === undefined) delete process.env.WORKFLOW_PROFILE;
  else process.env.WORKFLOW_PROFILE = previousEnv.profile;
  if (previousEnv.workspace === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = previousEnv.workspace;
  rmSync(configDir, { recursive: true, force: true });
});

const startTask = (root: string) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, {
    root,
    caller: { host: "opencode", actor: "lead" },
    capabilities: [],
    constraints: [],
    now: () => "2026-01-01T00:00:00Z",
  });
  const started = core.task(
    taskStartRequest({
      intent: { objective: "test task", scope: scope({ paths: ["."] }), authorityRefs: [] },
    }),
  );
  if (!started.ok) throw new Error(started.error);
};

const bash = (
  hooks: { "tool.execute.before"?: (input: never, output: never) => unknown },
  command: string,
) =>
  hooks["tool.execute.before"]?.(
    { tool: "bash", sessionID: "lead", callID: command } as never,
    { args: { command } } as never,
  );

test("OpenCode blocks only noncompliant literal branch targets inside live work", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-route-scope-"));
  try {
    startTask(root);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await expect(bash(hooks, "git checkout -b main")).rejects.toThrow("protected_ref");
    await expect(bash(hooks, "git checkout -b feature/raw")).resolves.toBeUndefined();
    await expect(bash(hooks, "gh pr create --fill")).resolves.toBeUndefined();
    await expect(bash(hooks, "git worktree add ../other")).resolves.toBeUndefined();
    await expect(bash(hooks, "git status --short")).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode branch policy does not depend on task state", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-route-scope-"));
  try {
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await expect(bash(hooks, "git checkout -b main")).rejects.toThrow("protected_ref");
    await expect(bash(hooks, "git checkout -b feature/raw")).resolves.toBeUndefined();
    await expect(bash(hooks, "gh pr create --fill")).resolves.toBeUndefined();
    await expect(bash(hooks, "git worktree add ../other")).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
