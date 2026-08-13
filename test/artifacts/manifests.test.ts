import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SUPPORT_MATRIX } from "../../packages/workit-core/src/core/support-matrix";
import {
  listTarball,
  packWorkspacePackages,
  readTarballFile,
  REPO_ROOT,
} from "../shared/helpers/packages";

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

test("cursor .cursor-plugin/plugin.json uses valid plugin-root-relative components", () => {
  const packs = packWorkspacePackages();
  const pkg = json<{ version: string }>("packages/workit-cursor/package.json");
  const packed = byName(packs, CURSOR).tarball;
  let packedPlugin: Record<string, string | string[]>;
  for (const source of ["committed", "packed"] as const) {
    const raw =
      source === "committed"
        ? read("packages/workit-cursor/.cursor-plugin/plugin.json")
        : readTarballFile(packed, ".cursor-plugin/plugin.json");
    const plugin = JSON.parse(raw) as Record<string, string | string[]>;
    if (source === "packed") packedPlugin = plugin;
    expect(plugin.version, source).toBe(pkg.version);
    expect(plugin.skills, source).toEqual(["skills/", "vendor/superpowers/skills/"]);
    expect(plugin.rules, source).toBe("rules/");
    expect(plugin.mcpServers, source).toBe("mcp.json");
    expect(plugin.hooks, source).toBe("hooks/hooks-cursor.json");
    for (const field of [plugin.skills, plugin.rules, plugin.mcpServers, plugin.hooks]) {
      for (const value of Array.isArray(field) ? field : [field]) {
        expect(value, source).not.toContain("..");
        expect(value, source).not.toMatch(/^\//);
        expect(value, source).not.toContain("$HOME");
      }
    }
  }

  const entries = new Set(listTarball(packed));
  for (const field of [
    packedPlugin!.skills,
    packedPlugin!.rules,
    packedPlugin!.mcpServers,
    packedPlugin!.hooks,
  ]) {
    for (const value of Array.isArray(field) ? field : [field]) {
      expect(
        value.endsWith("/")
          ? [...entries].some((entry) => entry.startsWith(value))
          : entries.has(value),
        value,
      ).toBe(true);
    }
  }

  const packedSkills = [...entries].filter((entry) => entry.endsWith("/SKILL.md"));
  expect(packedSkills).toHaveLength(26);
  for (const [source, target] of [
    ["packages/workit-cursor/skills", "skills"],
    ["packages/workit-core/vendor/superpowers/skills", "vendor/superpowers/skills"],
  ] as const) {
    const skills = readdirSync(path.join(REPO_ROOT, source)).filter((name) =>
      existsSync(path.join(REPO_ROOT, source, name, "SKILL.md")),
    );
    for (const skill of skills) {
      expect(entries, `${target}/${skill}/SKILL.md`).toContain(`${target}/${skill}/SKILL.md`);
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

test("opencode package.json ships a package-relative plugin entry and pins the SDK build-only", () => {
  const pkg = json<{
    main: string;
    exports: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
  }>("packages/workit-opencode/package.json");
  expect(pkg.main).toBe("./dist/plugin.js");
  expect(Object.values(pkg.exports)).toContain("./dist/plugin.js");
  expect(pkg.dependencies?.["@opencode-ai/plugin"]).toBeUndefined();
  expect(pkg.devDependencies?.["@opencode-ai/plugin"]).toBe(SUPPORT_MATRIX.opencode.current);
  expect(pkg.engines?.node).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
});

test("all platform packages declare the Node minimum and publish no OpenCode SDK runtime dependency", () => {
  const packs = packWorkspacePackages();
  for (const name of [OPENCODE, CURSOR]) {
    const raw = readTarballFile(byName(packs, name).tarball, "package.json");
    const pkg = JSON.parse(raw) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    };
    expect(pkg.engines?.node, name).toBe(`>=${SUPPORT_MATRIX.node.minimum}`);
    if (name === OPENCODE) {
      expect(pkg.dependencies?.["@opencode-ai/plugin"], name).toBeUndefined();
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
