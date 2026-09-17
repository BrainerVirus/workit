import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { taskStartRequest } from "@/test/workit-core/task-fixtures";
import { enforceNativeWriter } from "@/packages/workit-pi/src/tools";

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

test("Pi denies direct branch and PR creation inside live work", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pi-route-scope-"));
  try {
    startTask(root);
    const branch = enforceNativeWriter(bash("git checkout -b feature/raw"), ctx(root));
    expect(branch).toMatchObject({ block: true });
    expect(String((branch as { reason?: string })?.reason)).toContain("git.branch_setup");
    const pr = enforceNativeWriter(bash("gh pr create --fill"), ctx(root));
    expect(pr).toMatchObject({ block: true });
    expect(String((pr as { reason?: string })?.reason)).toContain("hosting.pull_request");
    expect(enforceNativeWriter(bash("git status --short"), ctx(root))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi allows direct branch and PR creation outside live work", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-pi-route-scope-"));
  try {
    expect(enforceNativeWriter(bash("git checkout -b feature/raw"), ctx(root))).toBeUndefined();
    expect(enforceNativeWriter(bash("gh pr create --fill"), ctx(root))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
