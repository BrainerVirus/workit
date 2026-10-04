import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { WORKIT_TOOL_CATALOG } from "@/packages/workit-opencode/src/shared/tools";
import { createWorkitTools } from "@/packages/workit-opencode/src/tools/workit";

test("the context tool publishes flat, read-only arguments", () => {
  const tools = createWorkitTools() as any;
  const v2 = WORKIT_TOOL_CATALOG.find((tool) => tool.name === "workit_context")?.input;
  expect(v2).toBeDefined();
  const args = {
    kind: "affected",
    range: "HEAD~1...HEAD",
    operation: "git.commit",
    payload: { message: "must not be available" },
  };
  expect(tools).not.toHaveProperty("workit_external_action");
  const validate = new Ajv2020({ strict: false }).compile(v2 as any);
  expect(validate({ kind: "affected", range: "HEAD~1...HEAD" })).toBe(true);
  expect(validate(args)).toBe(false);
  expect((v2 as any).required).toEqual(["kind"]);
  expect((v2 as any).additionalProperties).toBe(false);
});

test("the context catalog exposes only read context families", () => {
  const schema = WORKIT_TOOL_CATALOG.find((tool) => tool.name === "workit_context")?.input as any;
  expect(schema.properties.kind.enum).toEqual([
    "git",
    "pr",
    "youtrack",
    "github_issue",
    "gitlab_issue",
    "changelog",
    "release",
    "affected",
  ]);
  expect(schema.properties.cwd.type).toBe("string");
  expect(schema.properties).not.toHaveProperty("operation");
  expect(schema.properties).not.toHaveProperty("payload");
});
