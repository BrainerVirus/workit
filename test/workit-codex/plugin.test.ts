import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OPERATION_FAMILIES } from "../../packages/workit-core/src/core";
import {
  codexCapabilities,
  detectCodexSurface,
} from "../../packages/workit-codex/hooks/workit-hook";

const packageRoot = path.resolve(import.meta.dir, "../../packages/workit-codex");

test("Codex plugin ships current manifest layout and exactly seven synchronized skills", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  expect(manifest.skills).toBe("./skills/");
  expect(manifest.hooks).toBeUndefined();
  expect(manifest.mcpServers).toBe("./.mcp.json");
  expect(readdirSync(path.join(packageRoot, "skills")).sort()).toEqual([
    "workit-behavioral-tdd",
    "workit-challenge",
    "workit-debug",
    "workit-handoff",
    "workit-implement",
    "workit-plan",
    "workit-review",
  ]);
  expect(existsSync(path.join(packageRoot, "hooks/hooks.json"))).toBe(true);
  expect(existsSync(path.join(packageRoot, ".mcp.json"))).toBe(true);
});

test("Codex MCP capabilities are conservative and surface detection is diagnostic only", () => {
  expect(detectCodexSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" })).toBe(
    "codex_desktop",
  );
  expect(detectCodexSurface({ CODEX_ELECTRON_RESOURCES_PATH: "/desktop" })).toBe("codex_desktop");
  expect(detectCodexSurface({})).toBe("codex_cli");
  expect(codexCapabilities().find((item) => item.name === "known_product_writes")).toMatchObject({
    assurance: "unavailable",
  });
  expect(codexCapabilities().find((item) => item.name === "native_subagents")).toMatchObject({
    assurance: "unavailable",
  });
  expect(
    codexCapabilities({ preToolUse: true }).find((item) => item.name === "known_product_writes"),
  ).toMatchObject({ assurance: "enforced" });
});

test("shared MCP families remain the sole Codex tool surface", async () => {
  expect(OPERATION_FAMILIES).toHaveLength(8);
  expect(OPERATION_FAMILIES).toEqual([
    "task",
    "policy",
    "evidence",
    "finding",
    "decision",
    "worker",
    "writer",
    "state",
  ]);
});
