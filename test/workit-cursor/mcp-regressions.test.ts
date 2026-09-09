import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("build scripts derive their directory with fileURLToPath, not URL pathname", () => {
  for (const rel of [
    "packages/workit-cursor/scripts/build.ts",
    "packages/workit-mcp/scripts/build.ts",
    "packages/workit-opencode/scripts/build.ts",
  ]) {
    const src = readFileSync(path.join(repoRoot, rel), "utf8");
    expect(src, rel).toContain("fileURLToPath(import.meta.url)");
    expect(src, rel).not.toMatch(/new URL\(.*\)\.pathname/);
  }
});

test("cursor MCP manifests stay package-relative (mcp.json and hooks-cursor.json)", () => {
  const pkg = path.join(repoRoot, "packages/workit-cursor");
  for (const rel of ["mcp.json", "hooks/hooks-cursor.json"]) {
    const raw = readFileSync(path.join(pkg, rel), "utf8");
    expect(raw, rel).not.toContain("${workspaceFolder}/../");
    expect(raw, rel).not.toContain("/packages/workit-cursor/");
  }
  const manifest = JSON.parse(readFileSync(path.join(pkg, ".cursor-plugin/plugin.json"), "utf8"));
  expect(manifest.mcpServers).toBe("mcp.json");
  expect(manifest.hooks).toBe("hooks/hooks-cursor.json");
});
