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

test("lefthook's install postinstall never runs on dependency install", () => {
  // `lefthook install` from the npm package's postinstall ignores
  // no_auto_install and writes into the .git/hooks shared by every worktree.
  // Hooks are opt-in via `bun run hooks:install` only. bun blocks the script
  // unless lefthook is trusted; pnpm and yarn are told not to build it; npm
  // cannot install this workspace (workspace: protocol).
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf8"));
  expect(pkg.trustedDependencies ?? []).not.toContain("lefthook");
  expect(pkg.pnpm?.neverBuiltDependencies).toContain("lefthook");
  expect(pkg.dependenciesMeta?.lefthook?.built).toBe(false);
  expect(pkg.scripts["hooks:install"]).toBe("lefthook install");
  const lefthook = readFileSync(path.resolve(import.meta.dir, "../../lefthook.yml"), "utf8");
  expect(lefthook).toContain("no_auto_install: true");
});
