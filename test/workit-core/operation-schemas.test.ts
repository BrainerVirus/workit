import { expect, test } from "bun:test";
import {
  boundedOperationJsonSchema,
  canonicalFieldsDescription,
  OPERATION_FAMILIES,
  OPERATION_SCHEMA_DEPTH,
  operationJsonSchema,
  type OperationFamily,
} from "../../packages/workit-core/src/core";

const depth = (node: unknown, current = 0): number => {
  if (Array.isArray(node))
    return node.reduce((max, item) => Math.max(max, depth(item, current)), current);
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (!keys.length) return current;
    return keys.reduce(
      (max, key) => Math.max(max, depth((node as Record<string, unknown>)[key], current + 1)),
      current,
    );
  }
  return current;
};

const collectDescriptions = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const item of node) collectDescriptions(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.description === "string") out.push(record.description);
    for (const key of Object.keys(record))
      if (key !== "description") collectDescriptions(record[key], out);
  }
  return out;
};

test("advertised operation schemas stay within provider nesting limits", () => {
  for (const family of OPERATION_FAMILIES) {
    const bounded = boundedOperationJsonSchema(family as OperationFamily);
    expect(depth(bounded), family).toBeLessThanOrEqual(8);
  }
});

test("collapsed nodes name their canonical fields", () => {
  const bounded = boundedOperationJsonSchema("task") as Record<string, unknown>;
  const descriptions = collectDescriptions(bounded);
  const collapsed = descriptions.filter((text) => text.startsWith("Canonical object fields:"));
  expect(collapsed.length).toBeGreaterThan(0);
  expect(collapsed.some((text) => text.includes("objective"))).toBe(true);
  expect(canonicalFieldsDescription(["a", "b"])).toContain("a, b");
});

test("bounded schemas keep routable top-level actions", () => {
  const text = JSON.stringify(boundedOperationJsonSchema("task"));
  for (const action of ["start", "close"]) expect(text).toContain(`"${action}"`);
});

test("shared projection depth matches the documented host bound", () => {
  expect(OPERATION_SCHEMA_DEPTH).toBe(1);
});

test("full contract schemas stay complete for runtime validation", () => {
  for (const family of OPERATION_FAMILIES) {
    const full = operationJsonSchema(family as OperationFamily);
    expect(JSON.stringify(full)).toContain("properties");
  }
});
