import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

test("root package exposes pinned Oxc lint and format checks", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf8"));

  expect(pkg.devDependencies.oxlint).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.devDependencies.oxfmt).toMatch(/^\d+\.\d+\.\d+$/);
  // The lint/format file set lives in .oxlintrc.json / .oxfmtrc.json
  // (ignorePatterns), not in duplicated script arguments.
  expect(pkg.scripts.lint).toBe("oxlint");
  expect(pkg.scripts["lint:fix"]).toBe("oxlint --fix");
  expect(pkg.scripts.format).toBe("oxfmt");
  expect(pkg.scripts["format:check"]).toBe("oxfmt --check");
  const oxlintrc = Bun.JSONC.parse(
    readFileSync(path.resolve(import.meta.dir, "../../.oxlintrc.json"), "utf8"),
  ) as { options?: { denyWarnings?: boolean; typeAware?: boolean } };
  expect(oxlintrc.options?.denyWarnings).toBe(true);
  expect(oxlintrc.options?.typeAware).toBe(true);
  expect(pkg.scripts.check).toBe(
    "bun run build && bun run lint && bun run format:check && bun test && tsc --noEmit",
  );
});

test("CI enforces lint and format checks", () => {
  const workflow = readFileSync(
    path.resolve(import.meta.dir, "../../.github/workflows/ci.yml"),
    "utf8",
  );

  expect(workflow).toContain('"bun run lint"');
  expect(workflow).toContain('"bun run format:check"');
});
