// S17: advertised tool schemas are flat (depth 1) on every host, so no
// provider needs a depth projection; flat inputs nest into the contract.
import { expect, test } from "bun:test";
import {
  flatOperationJsonSchema,
  normalizeOperationInput,
  OPERATION_FAMILIES,
  operationSchemas,
} from "@/packages/workit-core/src/core";

const propertyDepth = (node: unknown): number => {
  if (!node || typeof node !== "object") return 0;
  const record = node as { properties?: Record<string, unknown>; items?: unknown };
  const children = [
    ...Object.values(record.properties ?? {}),
    ...(record.items ? [record.items] : []),
  ];
  const nested = Math.max(0, ...children.map(propertyDepth));
  return record.properties ? 1 + nested : nested;
};

test("given MCP tool schemas, then max depth is 1 with no projection or union", () => {
  for (const family of OPERATION_FAMILIES)
    for (const options of [{}, { stringTolerant: true }]) {
      const schema = flatOperationJsonSchema(family, options)!;
      expect(propertyDepth(schema), family).toBe(1);
      expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
      expect(schema.required).toEqual(["action"]);
    }
});

test("read-only projections keep only read actions and drop families without one", () => {
  const actions = (family: (typeof OPERATION_FAMILIES)[number]) =>
    (
      flatOperationJsonSchema(family, { readOnly: true }) as {
        properties: { action: { enum: string[] } };
      } | null
    )?.properties.action.enum ?? null;
  expect(actions("task")).toEqual(["list", "inspect"]);
  expect(actions("policy")).toEqual(["preview", "explain"]);
  expect(actions("evidence")).toBeNull();
});

test("Pi's string-tolerant schema accepts JSON-encoded strings for non-string fields", () => {
  const schema = flatOperationJsonSchema("task", { stringTolerant: true }) as {
    properties: Record<string, { type: unknown }>;
  };
  expect(schema.properties.paths.type).toEqual(["array", "string"]);
  expect(schema.properties.objective.type).toBe("string");
});

const id = "00000000-0000-4000-8000-000000000001";
test("flat inputs nest into the canonical contract on every family", () => {
  const cases: [(typeof OPERATION_FAMILIES)[number], Record<string, unknown>][] = [
    ["task", { action: "start", objective: "ship it", paths: ["src"] }],
    ["task", { action: "progress", taskId: id, summary: "half", blockers: ["waiting on CI"] }],
    ["task", { action: "close", taskId: id, outcome: "stopped", summary: "done" }],
    ["policy", { action: "assess", taskId: id, riskTier: "low", behaviorChange: "yes" }],
    [
      "evidence",
      { action: "record", taskId: id, kind: "investigation", claim: "c", result: "passed" },
    ],
    ["finding", { action: "record", taskId: id, claim: "c", consequence: "x", refs: ["a.ts"] }],
    [
      "finding",
      { action: "resolve", taskId: id, findingId: id, disposition: "fixed", reason: "r" },
    ],
    [
      "decision",
      {
        action: "record",
        taskId: id,
        purpose: "design",
        response: "stated",
        choice: "A",
        presented: "A or B?",
      },
    ],
    [
      "worker",
      { action: "assign", taskId: id, role: "reviewer", objective: "o", stoppingCondition: "s" },
    ],
    ["worker", { action: "report", taskId: id, workerId: id, outcome: "completed", summary: "s" }],
    ["state", { action: "export", taskId: id }],
  ];
  for (const [family, input] of cases) {
    const request = normalizeOperationInput(family, input, "workit_cli") as Record<string, unknown>;
    // Decision binding ids are filled by the engine from the recording task.
    if (family === "decision")
      Object.assign(request.binding as object, { taskId: id, workspaceId: id });
    const parsed = operationSchemas[family].safeParse(request);
    expect(parsed.success, `${family}.${String(input.action)}: ${parsed.error?.message}`).toBe(
      true,
    );
  }
});

test("canonical nested payloads pass through normalization unchanged in meaning", () => {
  const canonical = {
    schemaVersion: 1,
    action: "start",
    intent: {
      objective: "o",
      scope: { description: "d", paths: ["."], exclusions: [] },
      authorityRefs: [],
    },
  };
  expect(normalizeOperationInput("task", canonical, "workit_cli")).toEqual(canonical);
});
