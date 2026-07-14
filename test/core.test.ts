import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, ok, resolveInside, run } from "../src/core";
import { WorkflowStateStore } from "../src/state";

test("result envelope is stable", () => {
  expect(ok({ value: 1 })).toEqual({ ok: true, data: { value: 1 }, error: null });
  expect(fail("broken")).toEqual({ ok: false, data: null, error: "broken" });
});

test("paths cannot escape the worktree", () => {
  expect(() => resolveInside(os.tmpdir(), "../outside")).toThrow("inside repository root");
});

test("process runner uses executable and argument array", () => {
  const result = run(os.tmpdir(), process.execPath, ["-e", "console.log(process.argv[1])", "a b"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("a b");
});

test("session state emits compact path-only context", () => {
  const state = new WorkflowStateStore();
  state.set("s1", { spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x" });
  expect(state.compactionContext("s1")).toContain("Plan: docs/plan.md");
});

test("copied runtime cannot redirect assets or workspace through Cursor environment", () => {
  const pluginRootSource = readFileSync(path.resolve(import.meta.dir, "../src/legacy/plugin-root.js"), "utf8");
  const workspaceSource = readFileSync(path.resolve(import.meta.dir, "../src/legacy/resolve-workspace-root.js"), "utf8");
  expect(pluginRootSource).not.toContain("WORKFLOW_TOOLKIT_ROOT");
  expect(workspaceSource).not.toContain("WORKFLOW_WORKSPACE_ROOT");
});
