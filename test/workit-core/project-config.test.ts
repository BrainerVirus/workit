import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

test("root package exposes pinned Oxc lint and format checks", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf8"));

  expect(pkg.devDependencies.oxlint).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.devDependencies.oxfmt).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.scripts.lint).toStartWith("oxlint --deny-warnings ");
  expect(pkg.scripts["lint:fix"]).toStartWith("oxlint --fix ");
  expect(pkg.scripts.format).toStartWith("oxfmt ");
  expect(pkg.scripts["format:check"]).toStartWith("oxfmt --check ");
  expect(pkg.scripts.check).toBe(
    "bun run build && bun run lint && bun run format:check && bun test && tsc --noEmit",
  );
});

test("CI enforces lint and format checks", () => {
  const workflow = readFileSync(
    path.resolve(import.meta.dir, "../../.github/workflows/ci.yml"),
    "utf8",
  );

  expect(workflow).toContain("run: bun run lint");
  expect(workflow).toContain("run: bun run format:check");
});
