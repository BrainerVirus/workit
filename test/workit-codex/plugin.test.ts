import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { OPERATION_FAMILIES } from "@/packages/workit-core/src/core";
import { codexCapabilities, detectCodexSurface } from "@/packages/workit-codex/hooks/workit-hook";

const packageRoot = path.resolve(import.meta.dir, "../../packages/workit-codex");

test("Codex plugin ships current manifest layout and exactly seven synchronized skills", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  expect(packageJson.publishConfig).toEqual({ access: "public" });
  expect(manifest.skills).toBe("./skills/");
  expect(manifest.hooks).toBeUndefined();
  // The manifest wires skills and MCP only; hooks ship as the separate
  // hooks.json bundle, so the manifest must not advertise a Hooks capability.
  expect(manifest.interface.capabilities).toEqual(["MCP", "Task continuity"]);
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
  const hooks = JSON.parse(readFileSync(path.join(packageRoot, "hooks/hooks.json"), "utf8"));
  for (const event of ["SessionStart", "PreToolUse", "SubagentStart", "SubagentStop"])
    expect(hooks.hooks[event]).toEqual([
      {
        matcher: "*",
        hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/dist/workit-hook.js" }],
      },
    ]);
  const mcp = JSON.parse(readFileSync(path.join(packageRoot, ".mcp.json"), "utf8"));
  expect(mcp.mcpServers.workit).toMatchObject({ args: ["dist/launch-mcp.js"], cwd: "." });
});

test("Codex MCP capabilities are conservative and surface detection is diagnostic only", () => {
  expect(detectCodexSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" })).toBe(
    "codex_desktop",
  );
  expect(detectCodexSurface({ CODEX_ELECTRON_RESOURCES_PATH: "/desktop" })).toBe("codex_desktop");
  expect(detectCodexSurface({})).toBe("codex_cli");
  expect(
    codexCapabilities("codex_cli").find((item) => item.name === "known_product_writes"),
  ).toMatchObject({
    assurance: "unavailable",
  });
  expect(
    codexCapabilities("codex_desktop").find((item) => item.name === "native_subagents"),
  ).toMatchObject({
    assurance: "unavailable",
  });
  expect(
    codexCapabilities("codex_cli", { preToolUse: true }).find(
      (item) => item.name === "known_product_writes",
    ),
  ).toMatchObject({ assurance: "enforced" });
  expect(codexCapabilities("codex_desktop", { preToolUse: true })[1].refs).toEqual([
    { kind: "host", host: "codex_desktop", handle: "PreToolUse" },
  ]);
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
