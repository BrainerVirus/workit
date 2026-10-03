import { expect, test } from "bun:test";
import { scopeCovers } from "@/packages/workit-core/src/core/task-contract";

test("scopeCovers normalizes trailing slashes so docs/ covers docs/x", () => {
  const outer = {
    description: "batch",
    paths: [".cursor-plugin", "docs", "packages", "test"],
    exclusions: ["node_modules", ".git", "dist"],
  };
  const slashed = { ...outer, paths: [".cursor-plugin/", "docs/", "packages/", "test/"] };
  const file = { description: "", paths: ["docs/v1-preclose-batch/spec.md"], exclusions: [] };
  expect(scopeCovers(outer, file)).toBe(true);
  expect(scopeCovers(slashed, file)).toBe(true);
  expect(scopeCovers(slashed, { description: "", paths: ["node_modules/x"], exclusions: [] })).toBe(
    false,
  );
});
