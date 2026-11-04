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

test("scopeCovers (#647): a nested glob inside a lead path glob is contained; a wider or sibling one is not", () => {
  const lead = {
    description: "lead",
    paths: ["apps/**", "packages/**", "docs/*"],
    exclusions: [],
  };
  const worker = (paths: string[]) => ({ description: "", paths, exclusions: [] });
  expect(scopeCovers(lead, worker(["packages/x/src/**"]))).toBe(true);
  expect(scopeCovers(lead, worker(["packages/db/**", "apps/desktop/**", "apps/web/app/**"]))).toBe(
    true,
  );
  expect(scopeCovers(lead, worker(["packages/x/a.ts", "docs/guide/intro.md"]))).toBe(true);
  expect(scopeCovers(lead, worker(["test/**"]))).toBe(false);
  expect(scopeCovers(lead, worker(["**"]))).toBe(false);
  expect(scopeCovers(lead, worker(["docs/**"]))).toBe(false);
  expect(scopeCovers(lead, worker(["packagesx/**"]))).toBe(false);
  const narrow = { ...lead, paths: ["packages/*/src/**"] };
  expect(scopeCovers(narrow, worker(["packages/x/src/a.ts"]))).toBe(true);
  expect(scopeCovers(narrow, worker(["packages/**"]))).toBe(false);
  expect(scopeCovers(narrow, worker(["packages/*/test/**"]))).toBe(false);
});
