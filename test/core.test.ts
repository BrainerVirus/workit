import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

test("paths cannot escape through an in-root symlink", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-"));
  const root = path.join(fixture, "root");
  const outside = path.join(fixture, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, "link"), "dir");

  try {
    expect(() => resolveInside(root, "link/escaped.md")).toThrow("inside repository root");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("paths allow a nonexistent file beneath an in-root parent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-"));
  const parent = path.join(root, "parent");
  mkdirSync(parent);

  try {
    expect(resolveInside(root, "parent/new.md")).toBe(path.join(parent, "new.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("session state retains only workflow paths", () => {
  const state = new WorkflowStateStore();
  const input = { spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x", extra: "discarded" };
  state.set("s1", input);
  expect(state.get("s1")).toEqual({ spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x" });
});

test("session state is unchanged by later caller mutation", () => {
  const state = new WorkflowStateStore();
  const input = { spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x" };
  state.set("s1", input);
  input.plan = "docs/changed.md";
  expect(state.get("s1")?.plan).toBe("docs/plan.md");
});

test("copied runtime cannot redirect assets or workspace through Cursor environment", () => {
  const pluginRootSource = readFileSync(path.resolve(import.meta.dir, "../src/core/scripts.ts"), "utf8");
  const workspaceSource = readFileSync(path.resolve(import.meta.dir, "../src/core/scripts.ts"), "utf8");
  expect(pluginRootSource).not.toContain("WORKFLOW_TOOLKIT_ROOT");
  expect(workspaceSource).not.toContain("WORKFLOW_WORKSPACE_ROOT");
});
