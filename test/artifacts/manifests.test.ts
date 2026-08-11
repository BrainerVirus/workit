import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import { packWorkspacePackages, readTarballFile, REPO_ROOT } from "../shared/helpers/packages";

// Task 8 manifest gate (RR-07 / PT-10 / RR-10 / PT-11 / PT-12): the shipped
// OpenCode + Cursor manifests are package-relative and invoke Node explicitly,
// and the pinned toolchain/support-matrix constants declared in CI and in the
// package metadata stay in sync with SUPPORT_MATRIX. Deno is never advertised.

const CURSOR = "@brainervirus/workit-cursor";
const OPENCODE = "@brainervirus/workit-opencode";

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;

const byName = (packs: ReturnType<typeof packWorkspacePackages>, name: string) =>
  packs.find((p) => p.packageName === name)!;

test("cursor mcp.json is package-relative and invokes Node explicitly (PT-10)", () => {
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/mcp.json")
        : readTarballFile(byName(packWorkspacePackages(), CURSOR).tarball, "mcp.json");
    const mcp = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers.workit;
    expect(server, source).toBeDefined();
    expect(server.command, source).toBe("node");
    const joined = [...server.args].join(" ");
    expect(joined, source).toContain("dist/mcp-server.js");
    expect(joined, source).not.toMatch(/\$HOME/);
    expect(joined, source).not.toContain(".local/share");
    expect(joined, source).not.toContain("Documents/projects");
    expect(joined, source).not.toMatch(/^\//);
  }
});

test("cursor hooks-cursor.json references a package-relative Node entry", () => {
  const packs = packWorkspacePackages();
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/hooks/hooks-cursor.json")
        : readTarballFile(byName(packs, CURSOR).tarball, "hooks/hooks-cursor.json");
    const hooks = JSON.parse(raw) as {
      version: number;
      hooks: { sessionStart: { command: string; args?: string[] }[] };
    };
    expect(hooks.version, source).toBe(1);
    const entry = hooks.hooks.sessionStart[0];
    expect(entry.command, source).toBe("node");
    expect(entry.args?.[0], source).toBe("./dist/cursor-session-start.js");
    expect(JSON.stringify(entry), source).not.toMatch(/\$HOME/);
    expect(JSON.stringify(entry), source).not.toMatch(/^\//);
    // the referenced entry is Node (shebang documents the runtime)
    const entryFile = readTarballFile(
      byName(packs, CURSOR).tarball,
      "dist/cursor-session-start.js",
    );
    expect(entryFile.startsWith("#!/usr/bin/env node"), source).toBe(true);
  }
});

test("cursor .cursor-plugin/plugin.json is package-relative and versioned", () => {
  const plugin = json<Record<string, unknown>>("packages/workit-cursor/.cursor-plugin/plugin.json");
  const pkg = json<{ version: string }>("packages/workit-cursor/package.json");
  expect(plugin.version).toBe(pkg.version);
  for (const value of Object.values(plugin)) {
    if (typeof value === "string" && value.includes("/")) {
      expect(value.startsWith("../"), value).toBe(true);
      expect(value).not.toMatch(/^\//);
      expect(value).not.toContain("$HOME");
    }
  }
});

test("cursor marketplace.json is package-relative and versioned", () => {
  const market = json<Record<string, unknown>>("packages/workit-cursor/marketplace.json");
  const pkg = json<{ version: string }>("packages/workit-cursor/package.json");
  expect(market.version).toBe(pkg.version);
  for (const value of Object.values(market)) {
    expect(JSON.stringify(value), `${value}`).not.toContain("$HOME");
    expect(JSON.stringify(value), `${value}`).not.toContain("Documents/projects");
    expect(JSON.stringify(value), `${value}`).not.toContain(".local/share");
  }
});

test("opencode package.json ships a package-relative plugin entry and the pinned SDK", () => {
  const pkg = json<{
    main: string;
    exports: Record<string, string>;
    dependencies: Record<string, string>;
    engines?: { node?: string };
  }>("packages/workit-opencode/package.json");
  expect(pkg.main).toBe("./dist/plugin.js");
  expect(Object.values(pkg.exports)).toContain("./dist/plugin.js");
  expect(pkg.dependencies["@opencode-ai/plugin"]).toBe(SUPPORT_MATRIX.opencode.current);
  expect(pkg.engines?.node).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
});

test("all platform packages declare the Node minimum and pin the SDK in the packed tarballs", () => {
  const packs = packWorkspacePackages();
  for (const name of [OPENCODE, CURSOR]) {
    const raw = readTarballFile(byName(packs, name).tarball, "package.json");
    const pkg = JSON.parse(raw) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    };
    expect(pkg.engines?.node, name).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
    if (name === OPENCODE) {
      expect(pkg.dependencies?.["@opencode-ai/plugin"], name).toBe(SUPPORT_MATRIX.opencode.current);
    }
  }
  const cli = json<{ engines?: { node?: string } }>("packages/workit-cli/package.json");
  expect(cli.engines?.node).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
});

test("ci.yml pins the declared support matrix (Bun/Node/OpenCode, 3 OS, no Deno)", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain(`BUN_VERSION: "${SUPPORT_MATRIX.bun}"`);
  expect(ci).toContain(`NODE_MINIMUM: "${SUPPORT_MATRIX.node.minimum}"`);
  expect(ci).toContain(`NODE_CURRENT: "${SUPPORT_MATRIX.node.current}"`);
  expect(ci).toContain(`OPENCODE_MINIMUM: "${SUPPORT_MATRIX.opencode.minimum}"`);
  expect(ci).toContain(`OPENCODE_CURRENT: "${SUPPORT_MATRIX.opencode.current}"`);
  expect(ci).toContain("bun-version: ${{ env.BUN_VERSION }}");
  for (const os of SUPPORT_MATRIX.os) {
    expect(ci).toContain(os);
  }
  expect(ci).toMatch(/node:\s*\[20,\s*22\]/);
  expect(ci).not.toMatch(/[Dd]eno/);
});

test("bun.lock pins the declared Bun types and the current OpenCode SDK", () => {
  const lock = read("bun.lock");
  expect(lock).toContain(`"@types/bun": "${SUPPORT_MATRIX.bun}"`);
  expect(lock).toContain(`"@opencode-ai/plugin": "${SUPPORT_MATRIX.opencode.current}"`);
});
