import { expect, test } from "bun:test";
import {
  TASK_BRIEF_MAX_BYTES,
  boundTaskSummary,
} from "@/packages/workit-core/src/core/task-evaluation";
import type { TaskSummary } from "@/packages/workit-core/src/core/task-contract";

const digest = (index: number) => index.toString(16).padStart(64, "0");
const id = "00000000-0000-4000-8000-000000000001";

const summary = (overrides: Partial<TaskSummary> = {}, requirements = 40): TaskSummary => ({
  id,
  revision: id,
  workspaceRevision: id,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  runtime: null,
  objective: "ship it",
  status: "active",
  closure: null,
  progress: { summary: "going", nextAction: null, blockers: [] },
  policy: {
    policyVersion: "1.0.0",
    inputDigest: digest(0),
    requirements: Array.from({ length: requirements }, (_, index) => ({
      id: digest(index + 1),
      ruleId: "rule",
      dimension: "testing" as const,
      scope: { description: "x".repeat(2000), paths: ["."], exclusions: [] },
      reason: "r".repeat(2000),
      satisfaction: "s".repeat(2000),
      before: "close" as const,
      dependentAction: null,
      acceptanceAllowed: false,
    })),
  },
  requirements: Array.from({ length: requirements }, (_, index) => ({
    requirementId: digest(index + 1),
    status: index % 4 === 0 ? ("satisfied" as const) : ("unsatisfied" as const),
    evidenceIds: [id, id, id],
    decisionIds: [],
    reason: "why ".repeat(500),
  })),
  ...overrides,
});

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("a small task keeps its text and lists only what is still owed", () => {
  const brief = boundTaskSummary(summary({}, 4));
  expect(brief).toMatchObject({
    objective: "ship it",
    progress: { summary: "going", nextAction: null, blockers: [] },
    requirements: { total: 4, unmet: 3 },
    truncated: false,
  });
  expect(brief.requirements.open).toEqual([
    { dimension: "testing", before: "close", status: "unsatisfied" },
    { dimension: "testing", before: "close", status: "unsatisfied" },
    { dimension: "testing", before: "close", status: "unsatisfied" },
  ]);
});

test("any amount of text, blockers and requirements stays under the 4 KB bound", () => {
  const hostile = summary({
    objective: '"\\\n é'.repeat(2000),
    closure: {
      outcome: "stopped",
      at: "2026-01-01T00:00:00Z",
      summary: '"'.repeat(5000),
      decisionIds: [],
      evidenceIds: [],
    },
    progress: {
      summary: '"\n'.repeat(3000),
      nextAction: "é".repeat(3000),
      blockers: Array.from({ length: 200 }, () => ({
        reason: '"'.repeat(4000),
        dependentAction: "\n".repeat(4000),
        refs: [],
      })),
    },
  });
  const brief = boundTaskSummary(hostile);
  expect(bytes(brief)).toBeLessThan(TASK_BRIEF_MAX_BYTES);
  expect(brief.truncated).toBe(true);
  expect(brief.requirements).toMatchObject({ total: 40, unmet: 30 });
  expect(JSON.parse(JSON.stringify(brief)).id).toBe(id);
});
