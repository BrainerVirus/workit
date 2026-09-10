import { expect, test } from "bun:test";
import { OPERATION_SCHEMA_MAX_DEPTH } from "../../packages/workit-core/src/core";
import { createWorkitTools } from "../../packages/workit-opencode/src/tools/workit";
import { createDocsRepoTools } from "../../packages/workit-opencode/src/tools/docs-repo";
import { createRepoTools } from "../../packages/workit-opencode/src/tools/repo";
import { createRuleTools } from "../../packages/workit-opencode/src/tools/rules";
import { createTemplateTools } from "../../packages/workit-opencode/src/tools/templates";
import { createYouTrackTools } from "../../packages/workit-opencode/src/tools/youtrack";

const defOf = (schema: unknown): Record<string, any> =>
  (schema as any)?.def ?? (schema as any)?._def ?? {};
const unwalked = new Set<string>();

const depthOf = (schema: unknown, current = 0): number => {
  const def = defOf(schema);
  const type = typeof def.type === "string" ? def.type : "unknown";
  if (type === "object") {
    const shape = def.shape;
    if (!shape || typeof shape !== "object") {
      unwalked.add("object-without-shape");
      return current;
    }
    const keys = Object.keys(shape);
    if (!keys.length) return current;
    return Math.max(...keys.map((key) => depthOf(shape[key], current + 1)));
  }
  if (type === "array") return depthOf(def.element, current + 1);
  if (type === "record") return Math.max(depthOf(def.keyType, current + 1), depthOf(def.valueType, current + 1));
  if (type === "union")
    return Array.isArray(def.options) && def.options.length > 0
      ? Math.max(...def.options.map((option: unknown) => depthOf(option, current + 1)))
      : current;
  if (
    type === "optional" ||
    type === "nullable" ||
    type === "default" ||
    type === "readonly" ||
    type === "nonoptional"
  )
    return depthOf(def.innerType, current);
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "any" ||
    type === "unknown" ||
    type === "enum" ||
    type === "literal" ||
    type === "never" ||
    type === "void"
  )
    return current;
  unwalked.add(type);
  return current;
};

test("every advertised OpenCode tool stays within the provider nesting limit", () => {
  const tools = {
    ...createWorkitTools({}),
    ...createDocsRepoTools(),
    ...createRepoTools(),
    ...createRuleTools(),
    ...createTemplateTools(),
    ...createYouTrackTools(),
  };
  expect(Object.keys(tools).length).toBeGreaterThan(8);
  for (const [name, tool] of Object.entries(tools)) {
    const args = (tool as { args?: Record<string, unknown> }).args ?? {};
    const keys = Object.keys(args);
    const measured = keys.length > 0 ? Math.max(...keys.map((key) => depthOf(args[key], 1))) : 0;
    expect(measured, name).toBeLessThanOrEqual(OPERATION_SCHEMA_MAX_DEPTH);
  }
  expect([...unwalked]).toEqual([]);
});
