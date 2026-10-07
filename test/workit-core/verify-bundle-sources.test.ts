// The release guard against bundles that inline a registry copy of a
// workspace package (8.0.0 shipped 7.7.0's core in every adapter but pi).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
  import.meta.dir,
  "../../packages/workit-core/scripts/verify-bundle-sources.ts",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(bundles: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "workit-bundle-sources-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(bundles)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const guard = (root: string) =>
  spawnSync(process.execPath, [SCRIPT, root], {
    encoding: "utf8",
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });

test("given a CLI bundle that inlined a registry copy of core, the guard fails naming it", () => {
  const root = fixture({
    "packages/workit-cli/dist/index.js":
      "// packages/workit-cli/node_modules/@brainervirus/workit-core/src/ledger.ts\nfunction effectiveOf() {}\n",
    "packages/workit-mcp/dist/index.js": "// packages/workit-core/src/ledger.ts\n",
  });
  const run = guard(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-cli/dist/index.js: 1 modules, e.g. packages/workit-cli/node_modules/@brainervirus/workit-core/src/ledger.ts",
  );
  expect(run.stderr).not.toContain("workit-mcp/dist");
});

test("given bundles that inline only workspace sources, the guard passes", () => {
  const root = fixture({
    "packages/workit-cli/dist/index.js":
      "// packages/workit-core/src/ledger.ts\n// node_modules/ink/build/index.js\n",
    "packages/workit-cursor/dist/hooks/workit-hook.js": "// packages/workit-mcp/src/index.ts\n",
  });
  const run = guard(root);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("verified 2 adapter bundles");
  expect(run.status).toBe(0);
});

test("given no built bundles, the guard fails instead of passing vacuously", () => {
  const run = guard(fixture({ "packages/workit-core/src/ledger.ts": "" }));
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("no adapter bundles");
});

test("given workspaces-update off, `npm version` in a workspace installs nothing", () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["a", "b"] }),
    "a/package.json": JSON.stringify({ name: "@brainervirus/fixture-a", version: "1.0.0" }),
    "b/package.json": JSON.stringify({
      name: "@brainervirus/fixture-b",
      version: "1.0.0",
      dependencies: { "@brainervirus/fixture-a": "^1.0.0" },
    }),
  });
  const run = spawnSync("npm", ["version", "2.0.0", "--no-git-tag-version"], {
    cwd: path.join(root, "a"),
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_WORKSPACES_UPDATE: "false", NPM_CONFIG_OFFLINE: "true" },
  });
  expect(run.status, run.stderr).toBe(0);
  expect(existsSync(path.join(root, "b/node_modules"))).toBe(false);
  expect(existsSync(path.join(root, "node_modules"))).toBe(false);
});
