import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { shellRouteIntent, shouldDenyShellRoute } from "@/packages/workit-core/src/core/route-intent";
import { caller, taskStartRequest } from "./task-fixtures";

test("direct branch creation routes to git.branch_setup", () => {
  for (const command of [
    "git switch -c feature/x",
    "git switch --create feature/x",
    "git checkout -b fix/y",
    "git checkout -B fix/y",
    "cd repo && git switch -c feature/x",
    'git switch -c "feature/x"',
    "FOO=bar git checkout -b fix/y",
  ]) {
    expect(shellRouteIntent(command), command).toMatchObject({ route: "git.branch_setup" });
  }
});

test("direct pull and merge request creation routes to hosting.pull_request", () => {
  for (const command of [
    "gh pr create --title t --body b",
    "glab mr create --title t",
    "git push -u origin feature/x && gh pr create --fill",
  ]) {
    expect(shellRouteIntent(command), command).toMatchObject({ route: "hosting.pull_request" });
  }
});

test("unrelated or unparseable commands stay explicitly unenforced", () => {
  for (const command of [
    "git commit -m x",
    "git switch main",
    "git checkout main",
    "git branch --show-current",
    "gh pr view 5",
    "glab mr list",
    "npm test",
    "echo 'git switch -c fake'",
    "git switch -c `echo feature`",
    'git switch -c "unclosed',
    "",
  ]) {
    expect(shellRouteIntent(command), command).toBeNull();
  }
});

const scopeContext = (root: string): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const startTask = (root: string) => {
  const store = new TaskStore(root);
  const core = new WorkitCore(store, scopeContext(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  return { store, core, id: (started.data as { id: string }).id };
};

test("session-scoped denial allows outside live work", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-route-scope-"));
  try {
    expect(shouldDenyShellRoute(root, "git checkout -b feature/x")).toBeNull();
    expect(shouldDenyShellRoute(root, "gh pr create --fill")).toBeNull();
    expect(shouldDenyShellRoute(join(root, "missing"), "git checkout -b feature/x")).toBeNull();
    expect(shouldDenyShellRoute(root, "")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-scoped denial denies inside active and paused tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-route-scope-"));
  try {
    const { store, core, id } = startTask(root);
    expect(shouldDenyShellRoute(root, "git checkout -b feature/x")).toMatchObject({
      route: "git.branch_setup",
    });
    expect(shouldDenyShellRoute(root, "gh pr create --fill")).toMatchObject({
      route: "hosting.pull_request",
    });
    expect(shouldDenyShellRoute(root, "git status --short")).toBeNull();
    const task = store.readTask(id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const paused = core.task({
      schemaVersion: 1,
      action: "pause",
      taskId: id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      reason: "test",
    });
    expect(paused.ok).toBe(true);
    expect(shouldDenyShellRoute(root, "git checkout -b feature/x")).toMatchObject({
      route: "git.branch_setup",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-scoped denial allows after the task closes", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-route-scope-"));
  try {
    const { store, core, id } = startTask(root);
    const task = store.readTask(id);
    const workspace = store.readWorkspace();
    if (!task.ok || !workspace.ok || !workspace.data) throw new Error("state missing");
    const closed = core.task({
      schemaVersion: 1,
      action: "close",
      taskId: id,
      expectedRevision: task.data.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      outcome: "stopped",
      summary: "test",
      decisionIds: [],
    });
    expect(closed.ok).toBe(true);
    expect(shouldDenyShellRoute(root, "git checkout -b feature/x")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
