import { expect } from "bun:test";
import { createTools } from "@/packages/workit-opencode/src/tools";

export function assertOpencodeWorkitNamespace(): string[] {
  const names = Object.keys(createTools());
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
  expect(names).toContain("workit_external_action");
  return names;
}
