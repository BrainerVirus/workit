// The release guard against bundles that inline a registry copy of a
// workspace package (8.0.0 shipped 7.7.0's core in every adapter but pi).
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const CORE_BUNDLE = "// packages/workit-core/src/ledger.ts\nfunction effectiveOf() {}\n";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "workit-bundle-sources-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/workit-core"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const guard = (root: string, ...flags: string[]) =>
  spawnSync(process.execPath, [SCRIPT, root, ...flags], {
    encoding: "utf8",
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });

test("given a CLI bundle that inlined a registry copy of core, the guard fails naming it", () => {
  const root = fixture({
    "packages/workit-cli/dist/index.js":
      "// packages/workit-cli/node_modules/@brainervirus/workit-core/src/ledger.ts\nfunction effectiveOf() {}\n",
    "packages/workit-mcp/dist/index.js": CORE_BUNDLE,
  });
  const run = guard(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-cli/dist/index.js: 1 registry-copy modules, e.g. packages/workit-cli/node_modules/@brainervirus/workit-core/src/ledger.ts",
  );
  expect(run.stderr).not.toContain("workit-mcp/dist");
});

test("given Windows-style module headers, the guard still tells a registry copy from workspace core", () => {
  const root = fixture({
    "packages/workit-cli/dist/index.js":
      "// packages\\workit-cli\\node_modules\\@brainervirus\\workit-core\\src\\ledger.ts\n",
    "packages/workit-mcp/dist/index.js": "// packages\\workit-core\\src\\ledger.ts\n",
  });
  const run = guard(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-cli/dist/index.js: 1 registry-copy modules, e.g. packages/workit-cli/node_modules/@brainervirus/workit-core/src/ledger.ts",
  );
  expect(run.stderr).not.toContain("workit-mcp/dist");
});

test("given bundles that inline workspace core, the guard passes", () => {
  const root = fixture({
    "packages/workit-cli/dist/index.js": `${CORE_BUNDLE}// node_modules/ink/build/index.js\n`,
    "packages/workit-cursor/dist/hooks/workit-hook.js": CORE_BUNDLE,
  });
  const run = guard(root);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("verified 2 adapter bundles");
  expect(run.status).toBe(0);
});

test("given an unminified bundle with no workspace-core header, the guard fails", () => {
  const root = fixture({
    "packages/workit-mcp/dist/index.js": "var a = 1;\nfunction effectiveOf() {}\n",
  });
  const run = guard(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-mcp/dist/index.js: no `// packages/workit-core/src/` module header",
  );
});

test("given a code-split entry, core in a chunk it imports counts and the chunks are not entries", () => {
  const root = fixture({
    "packages/workit-codex/dist/workit-hook.js":
      '// packages/workit-codex/hooks/launcher.ts\nimport { a } from "./workit-hook-rt.js";\nawait import("./workit-hook-core.js");\n',
    "packages/workit-codex/dist/workit-hook-rt.js": "var a = 1;\nexport { a };\n",
    "packages/workit-codex/dist/workit-hook-core.js": `import { a } from "./workit-hook-rt.js";\n${CORE_BUNDLE}`,
  });
  const run = guard(root);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
});

test("given a code-split entry whose chunks inline no workspace core, the guard fails on the entry", () => {
  const root = fixture({
    "packages/workit-codex/dist/workit-hook.js":
      '// packages/workit-codex/hooks/launcher.ts\nawait import("./workit-hook-x.js");\n',
    "packages/workit-codex/dist/workit-hook-x.js": "// node_modules/zod/v4/core/util.js\n",
  });
  const run = guard(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-codex/dist/workit-hook.js: no `// packages/workit-core/src/` module header in it or its chunks (first header: packages/workit-codex/hooks/launcher.ts)",
  );
  expect(run.stderr).not.toContain("workit-hook-x.js:");
});

test("given a minified bundle (no headers to read), the bundle check leaves it to the install check", () => {
  const root = fixture({
    "packages/workit-claude-code/dist/workit-hook.js": `${"var a=1;".repeat(400)}\n`,
  });
  expect(guard(root).status).toBe(0);
});

test("given a planted nested node_modules/@brainervirus/workit-core, the install check fails", () => {
  const root = fixture({
    "packages/workit-cli/node_modules/@brainervirus/workit-core/package.json": "{}",
  });
  const run = guard(root, "--installs-only");
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(
    "packages/workit-cli/node_modules/@brainervirus/workit-core: installed copy outside packages/",
  );
});

test("given a hoisted @brainervirus entry outside packages/, the install check fails; a workspace link passes", () => {
  const root = fixture({ "node_modules/@brainervirus/workit-mcp/package.json": "{}" });
  symlinkSync(
    "../../packages/workit-core",
    path.join(root, "node_modules/@brainervirus/workit-core"),
  );
  const run = guard(root, "--installs-only");
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("node_modules/@brainervirus/workit-mcp: installed copy");
  expect(run.stderr).not.toContain("@brainervirus/workit-core:");
  rmSync(path.join(root, "node_modules/@brainervirus/workit-mcp"), { recursive: true });
  expect(guard(root, "--installs-only").status).toBe(0);
});

test("given no built bundles, the guard fails instead of passing vacuously", () => {
  const run = guard(fixture({}));
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
