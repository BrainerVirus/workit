import { expect } from "bun:test";
import { createTools } from "../../../packages/workit-opencode/src/tools";
import { WorkflowStateStore } from "../../../packages/workit-core/src/state";

export function assertOpencodeWorkitNamespace(): string[] {
  const names = Object.keys(createTools({} as never, new WorkflowStateStore()));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name).toMatch(/^workit_[a-z0-9_]+$/);
  }
  expect(names).toContain("workit_commit");
  expect(names).toContain("workit_handoff_session");
  expect(names).not.toContain("workit_handoff_prompt");
  return names;
}
