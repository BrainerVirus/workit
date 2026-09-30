import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  OPERATION_SCHEMA_MAX_DEPTH,
  boundedOperationJsonSchema,
  externalActionJsonSchema,
  externalActionRequest,
} from "@/packages/workit-core/src/core";
import { WORKIT_TOOL_CATALOG } from "@/packages/workit-opencode/src/shared/tools";
import { createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";

test("V1 native argument schemas reject the same malformed payload shapes", () => {
  const tools = createWorkitTools() as any;
  const payload = tools.workit_external_action.args.payload;
  expect(payload.safeParse({ stash: false }).success).toBe(false);
  expect(payload.safeParse({ stash: "no", target_branch: "feature/example" }).success).toBe(true);
  expect(payload.safeParse({ plan_steps: [{ message: "not a supported step" }] }).success).toBe(
    false,
  );
  expect(
    payload.safeParse({
      plan_steps: ["feat(example): change", { branch: "feature/next" }, { pr: true }],
    }).success,
  ).toBe(true);
});

const record = (value: unknown): Record<string, any> => value as Record<string, any>;

const maximumDepth = (value: unknown, depth = 0): number => {
  if (Array.isArray(value))
    return Math.max(depth, ...value.map((child) => maximumDepth(child, depth)));
  if (!value || typeof value !== "object") return depth;
  const schema = record(value);
  const containerDepth = schema.type === "object" || schema.type === "array" ? depth + 1 : depth;
  const children = [
    ...(schema.properties && typeof schema.properties === "object"
      ? Object.values(schema.properties as Record<string, unknown>)
      : []),
    ...(schema.items ? [schema.items] : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
  ];
  return Math.max(containerDepth, ...children.map((child) => maximumDepth(child, containerDepth)));
};

test("V2 external-action schema advertises the canonical operation payloads", () => {
  const canonical = externalActionJsonSchema();
  const advertised = WORKIT_TOOL_CATALOG.find((tool) => tool.name === "workit_external_action");
  if (!advertised) throw new Error("V2 external-action tool is not registered");
  expect(advertised?.input).toEqual(canonical);
  expect(advertised?.input.type).toBe("object");
  expect(maximumDepth(advertised?.input)).toBeLessThanOrEqual(OPERATION_SCHEMA_MAX_DEPTH);

  const variants = record(advertised?.input).oneOf as Record<string, any>[];
  const branchSetup = variants.find(
    (variant) => variant.properties.operation.const === "git.branch_setup",
  );
  if (!branchSetup) throw new Error("branch_setup variant is missing");
  expect(branchSetup.properties.payload.properties.stash.enum).toEqual(["yes", "no"]);

  const commit = variants.find((variant) => variant.properties.operation.const === "git.commit");
  if (!commit) throw new Error("git.commit variant is missing");
  expect(commit.properties.payload.properties.plan_steps.items.anyOf).toEqual([
    expect.objectContaining({ type: "string" }),
    expect.objectContaining({
      properties: { branch: expect.objectContaining({ type: "string" }) },
    }),
    expect.objectContaining({ properties: { pr: expect.objectContaining({ const: true }) } }),
  ]);
  expect(commit.additionalProperties).toBe(false);
  expect(commit.properties.payload.additionalProperties).toBe(false);

  const validate = new Ajv2020({ strict: false }).compile(advertised.input as any);
  const samples = [
    {
      operation: "git.branch_setup",
      payload: { action: "setup", target_branch: "feature/sample", stash: "no" },
    },
    {
      operation: "git.branch_setup",
      payload: { action: "setup", target_branch: "feature/sample", stash: "false" },
    },
    {
      operation: "git.commit",
      payload: {
        plan_branch: "feature/sample",
        plan_steps: ["feat(sample): commit", { branch: "feature/next" }, { pr: true }],
      },
    },
    {
      operation: "git.commit",
      payload: {
        plan_branch: "feature/sample",
        plan_steps: [{ branch: "feature/next", pr: true }],
      },
    },
  ];
  for (const sample of samples) expect(validate(sample)).toBe(externalActionRequest(sample).ok);
});

test("collapsed family schemas describe required fields and nested discriminators", () => {
  const schema = boundedOperationJsonSchema("decision");
  const recordDecision = (schema.oneOf as Record<string, any>[]).find(
    (variant) => variant.properties.action.const === "record",
  );
  if (!recordDecision) throw new Error("decision record variant is missing");
  const description = recordDecision.properties.binding.description as string;
  expect(description).toContain("taskId!:str");
  expect(description).toContain('kind!:="file"');
  expect(recordDecision.properties.response.enum).toEqual(["approved", "rejected", "stated"]);
  expect(description).toContain("Full nested value is validated.");
});

test("runtime external-action validation agrees with advertised enum and plan-step shapes", () => {
  expect(
    externalActionRequest({
      operation: "git.branch_setup",
      payload: { action: "setup", target_branch: "feature/sample", stash: "no" },
    }).ok,
  ).toBe(true);
  expect(
    externalActionRequest({
      operation: "git.branch_setup",
      payload: { action: "setup", target_branch: "feature/sample", stash: "false" },
    }).ok,
  ).toBe(false);
  expect(
    externalActionRequest({
      operation: "git.commit",
      payload: {
        plan_branch: "feature/sample",
        plan_steps: ["feat(sample): commit", { branch: "feature/next" }, { pr: true }],
      },
    }).ok,
  ).toBe(true);
  expect(
    externalActionRequest({
      operation: "git.commit",
      payload: {
        plan_branch: "feature/sample",
        plan_steps: [{ branch: "feature/next", pr: true }],
      },
    }).ok,
  ).toBe(false);
});
