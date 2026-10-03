import { expect } from "bun:test";
import { createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";

export function assertOpencodeWorkitNamespace(): string[] {
  const names = Object.keys(createWorkitTools());
  const core = [
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ];
  expect(names.filter((name) => core.includes(name))).toEqual(core);
  expect(names).toContain("workit_context");
  expect(names).not.toContain("workit_external_action");
  return names;
}
