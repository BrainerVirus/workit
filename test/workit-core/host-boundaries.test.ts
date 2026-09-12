import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "@/packages/workit-core/src/core/scripts";
import {
  changedSourcesSinceLoad,
  markSourcesLoaded,
} from "@/packages/workit-core/src/core/boundary";
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CORE_SRC = path.join(REPO_ROOT, "packages", "workit-core", "src");
const CURSOR_SERVER = path.join(REPO_ROOT, "packages", "workit-cursor", "mcp", "server.ts");

const FORBIDDEN = ["@opencode-ai", "@modelcontextprotocol", "ink", "react"];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? tsFilesUnder(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function specifiers(source: string): string[] {
  // Catches `from "x"`, `import("x")`, and bare side-effect `import "x"`
  // (D7) so a host-SDK side-effect import cannot evade the scan.
  return [...source.matchAll(/(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

test("workit-core imports no host SDK, MCP SDK, Ink, or React", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(CORE_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const spec of specifiers(source)) {
      if (FORBIDDEN.some((prefix) => spec === prefix || spec.startsWith(prefix))) {
        offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("specifier scan catches bare side-effect imports, not only from/import() (D7)", () => {
  const source = [
    'import "@opencode-ai/plugin";',
    'import { x } from "ink";',
    'const m = import("react");',
    'import("@opencode-ai/tools");',
  ].join("\n");
  const specs = specifiers(source);
  expect(specs).toContain("@opencode-ai/plugin");
  expect(specs).toContain("ink");
  expect(specs).toContain("react");
  expect(specs).toContain("@opencode-ai/tools");
  expect(specs.filter((s) => s === "@opencode-ai/plugin")).toHaveLength(1);
});

test("root tsconfig typechecks every maintained TS surface", () => {
  const tsconfig = JSON.parse(readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8"));
  expect(tsconfig.compilerOptions.strict).toBe(true);
  for (const entry of [
    "test/**/*.ts",
    "packages/workit-core/src/**/*.ts",
    "packages/workit-opencode/src/**/*.ts",
    "packages/workit-cli/src/**/*.tsx",
    "packages/workit-cursor/mcp/**/*.ts",
  ]) {
    expect(tsconfig.include).toContain(entry);
  }
});

test("cursor delegates workspace root context to the shared transport", () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).toContain("@brainervirus/workit-mcp");
  expect(server).toContain("cursorContextProvider");
  expect(resolveWorkspaceRoot(undefined)).toBe(process.cwd());
  expect(resolveWorkspaceRoot("/workspace")).toBe("/workspace");
});

test("cursor does not duplicate legacy flow registrations", () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).not.toContain("resolveCanonicalLayout");
  expect(server).not.toContain("readFlowState");
  expect(server).not.toContain("registerTool");
  expect(server).not.toContain("flow-state");
});

test("Cursor publishes only the shared eight operation families", async () => {
  const server = readFileSync(CURSOR_SERVER, "utf8");
  expect(server).toContain("createMcpServer");
  const { OPERATION_FAMILIES } = await import("@/packages/workit-core/src/core");
  expect(OPERATION_FAMILIES).toHaveLength(8);
});

test("source markers report only files edited after process load", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workit-source-marker-"));
  const oldFile = path.join(dir, "old.ts");
  const newFile = path.join(dir, "new.ts");
  writeFileSync(oldFile, "v1\n");
  writeFileSync(newFile, "v1\n");
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(oldFile, past, past);
  utimesSync(newFile, past, past);
  const marker = markSourcesLoaded(
    [oldFile, newFile, path.join(dir, "missing.ts")],
    new Date("2020-06-01T00:00:00Z").getTime(),
  );
  expect(changedSourcesSinceLoad(marker)).toEqual([]);
  const later = new Date("2021-01-01T00:00:00Z");
  utimesSync(newFile, later, later);
  expect(changedSourcesSinceLoad(marker)).toEqual([newFile]);
});
