import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { enforceNativeWriter } from "@/packages/workit-pi/src/tools";

const previousEnv = {
  config: process.env.WORKFLOW_TOOLKIT_CONFIG,
  configDir: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  profile: process.env.WORKFLOW_PROFILE,
  workspace: process.env.WORKFLOW_WORKSPACE_NAME,
};
let configDir: string;
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "workit-pi-route-config-"));
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
  const context: OperationContext = {
    root,
    caller: { host: "pi", actor: "pi-session" },
    callerAttested: true,
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  };
  const started = new WorkitCore(store, context).task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
};

const ctx = (root: string) =>
  ({
    cwd: root,
    hasUI: false,
    mode: "json",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: { confirm: async () => true },
  }) as never;

const bash = (command: string) => ({ toolName: "bash", input: { command } }) as never;

test("Pi blocks only noncompliant literal branch targets inside live work", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pi-route-scope-"));
  try {
    startTask(root);
    const branch = enforceNativeWriter(bash("git checkout -b main"), ctx(root));
    expect(branch).toMatchObject({ block: true });
    expect(String((branch as { reason?: string })?.reason)).toContain("protected_ref");
    expect(enforceNativeWriter(bash("git checkout -b feature/raw"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("gh pr create --fill"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("git worktree add ../other"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("git status --short"), ctx(root))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi branch policy does not depend on task state", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pi-route-scope-"));
  try {
    expect(enforceNativeWriter(bash("git checkout -b main"), ctx(root))).toMatchObject({
      block: true,
    });
    expect(enforceNativeWriter(bash("git checkout -b feature/raw"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("gh pr create --fill"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("git worktree add ../other"), ctx(root))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
