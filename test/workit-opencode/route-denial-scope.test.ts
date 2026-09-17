import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";
import plugin from "@/packages/workit-opencode/src/plugin";

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

test("OpenCode denies direct branch and PR creation inside live work", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-route-scope-"));
  try {
    startTask(root);
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await expect(bash(hooks, "git checkout -b feature/raw")).rejects.toThrow("git.branch_setup");
    await expect(bash(hooks, "gh pr create --fill")).rejects.toThrow("hosting.pull_request");
    await expect(bash(hooks, "git status --short")).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode allows direct branch and PR creation outside live work", async () => {
  const root = mkdtempSync(join(tmpdir(), "workit-opencode-route-scope-"));
  try {
    const hooks = await plugin({
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost"),
    } as never);
    await expect(bash(hooks, "git checkout -b feature/raw")).resolves.toBeUndefined();
    await expect(bash(hooks, "gh pr create --fill")).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
