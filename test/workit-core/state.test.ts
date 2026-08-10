import { expect, test } from "bun:test";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";

test("set stores only the workflow paths", () => {
  const state = new WorkflowStateStore();
  state.set("s1", { spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x" });
  expect(state.get("s1")).toEqual({
    spec: "docs/spec.md",
    plan: "docs/plan.md",
    sdd: "docs/sdd/x",
  });
});

test("get returns undefined for unknown sessions", () => {
  const state = new WorkflowStateStore();
  expect(state.get("missing")).toBeUndefined();
});

test("compactionContext returns null without state and paths with state", () => {
  const state = new WorkflowStateStore();
  expect(state.compactionContext("missing")).toBeNull();
  state.set("s1", { spec: "docs/spec.md", plan: "docs/plan.md", sdd: "docs/sdd/x" });
  const context = state.compactionContext("s1");
  expect(context).toContain("Spec: docs/spec.md");
  expect(context).toContain("Plan: docs/plan.md");
  expect(context).toContain("SDD: docs/sdd/x");
});
