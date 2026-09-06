import { expect } from "bun:test";
import { createTools } from "../../../packages/workit-opencode/src/tools";

export function assertOpencodeWorkitNamespace(): string[] {
  const names = Object.keys(createTools());
  expect(names).toEqual([
    "workit_task",
    "workit_policy",
    "workit_evidence",
    "workit_finding",
    "workit_decision",
    "workit_worker",
    "workit_writer",
    "workit_state",
  ]);
  return names;
}
