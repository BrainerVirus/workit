import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cursorHooksEntry,
  cursorMcpServerEntry,
  isWorkitPlugin,
  mergeCursorEnabledPlugins,
  mergeCursorHooks,
  mergeCursorMcp,
  mergeCursorPluginDirs,
  mergeCursorSettings,
  mergeOpenCodeConfig,
  mergeOpenCodePlugins,
} from "../../packages/workit-core/src/core/registration";

// Task 8 registration gate (RR-06): the installer registration merges accept an
// existing user config, deduplicate every current + legacy Workit identity, and
// return the deduplicated config PLUS the explicit list of keys changed — never
// rewriting unrelated user settings (values round-trip JSON-identical).

const PIN = "file:///work/packages/workit-opencode/src/plugin.ts";
const CURSOR_ROOT = path.join("/home/user", ".cursor");
const CURSOR_PLUGIN_DIR = path.join(CURSOR_ROOT, "plugins", "local", "workit");
const LEGACY_PLUGIN_DIR = path.join(CURSOR_ROOT, "plugins", "local", "workflow-toolkit");
const OTHER_PLUGIN_DIR = path.join(CURSOR_ROOT, "plugins", "local", "other");

test("isWorkitPlugin matches every legacy and current identity, never unrelated plugins", () => {
  for (const id of [
    "workflow-toolkit-opencode",
    "workflow-toolkit-opencode@git+file:///old/checkout",
    "@brainervirus/workit-opencode",
    "@brainervirus/workit-opencode@1.0.0",
    "@brainervirus/workit-cursor",
    "@brainervirus/workit-cursor@2.0.0",
    "file:///work/packages/workit-opencode/src/plugin.ts",
    "git+file:///work/workflow-toolkit",
    "file:///x/node_modules/@brainervirus/workit-opencode/dist/plugin.js",
    "file:///x/packages/workit-opencode/src/plugin.ts",
    "workflow-toolkit",
    "local/workflow-toolkit",
    "workit",
    "local/workit",
    "workit@1.0.0",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(true);
  }
  for (const id of [
    "@dietrichgebert/ponytail",
    "@opencode-ai/plugin",
    "my-plugin",
    "@brainervirus/workit-opencode-helper",
    "@brainervirus/workit-cursor-tools",
    "@brainervirus/workit-opencode-extra",
    "@brainervirus/workit-cursor-legacy",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

// AR-04: prefix-shared names are unrelated packages, never Workit identities.
test("isWorkitPlugin rejects prefix-shared @brainervirus names, still accepts exact names", () => {
  for (const id of [
    "@brainervirus/workit-opencode",
    "@brainervirus/workit-opencode@0.4.0",
    "@brainervirus/workit-opencode@^0.4.0",
    "@brainervirus/workit-cursor",
    "@brainervirus/workit-cursor@0.4.0",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(true);
  }
  for (const id of [
    "@brainervirus/workit-opencode-helper",
    "@brainervirus/workit-cursor-tools",
    "@brainervirus/workit-opencode-extra",
    "@brainervirus/workit-cursor-legacy",
    "@brainervirus/workit-cursor-tools@1.0.0",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

test("isWorkitPlugin preserves unrelated plugin ids that merely contain workflow-toolkit (D3)", () => {
  for (const id of [
    "some-workflow-toolkit-helper",
    "my-workflow-toolkit-plugins",
    "my-workflow-toolkit-plugin",
    "workflow-toolkit-mcp",
    "org/plugin-workflow-toolkit-v2",
    "github.com/owner/workflow-toolkit-fork",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

test("mergeOpenCodePlugins preserves unrelated workflow-toolkit-containing ids (D3)", () => {
  const existing = ["some-workflow-toolkit-helper", "@brainervirus/workit-opencode", PIN];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([PIN, "some-workflow-toolkit-helper"]);
  expect(changed).toEqual(["plugin"]);
});

// AR-04: prefix-shared helper packages survive a registration merge unchanged.
test("mergeOpenCodePlugins preserves prefix-shared helper packages (AR-04)", () => {
  const existing = [
    "@brainervirus/workit-opencode-helper",
    "@brainervirus/workit-cursor-tools",
    "@brainervirus/workit-opencode",
    PIN,
  ];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([
    PIN,
    "@brainervirus/workit-opencode-helper",
    "@brainervirus/workit-cursor-tools",
  ]);
  expect(changed).toEqual(["plugin"]);
});

test("mergeOpenCodePlugins dedups legacy + current identities to a single pin", () => {
  const existing = [
    "@dietrichgebert/ponytail",
    "workflow-toolkit-opencode@git+file:///old/checkout",
    "@brainervirus/workit-opencode",
    PIN,
  ];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([PIN, "@dietrichgebert/ponytail"]);
  expect(changed).toEqual(["plugin"]);
});

test("mergeOpenCodeConfig dedups plugins and preserves unrelated settings byte-for-byte", () => {
  const input: Record<string, unknown> = {
    model: "gpt-5",
    theme: "dark",
    $schema: "https://opencode.ai/config.json",
    plugin: [
      "@dietrichgebert/ponytail",
      "workflow-toolkit-opencode@git+file:///old/checkout",
      "@brainervirus/workit-opencode",
      PIN,
    ],
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  expect(config.plugin).toEqual([PIN, "@dietrichgebert/ponytail"]);
  expect(changed).toEqual(["plugin"]);
  for (const key of ["model", "theme", "$schema"]) {
    expect(JSON.stringify(config[key]), key).toBe(JSON.stringify(input[key]));
  }
  expect(Object.keys(config).sort()).toEqual(Object.keys(input).sort());
});

test("mergeOpenCodeConfig drops stale workflow-toolkit skill paths, keeps unrelated paths", () => {
  const input = {
    plugin: ["other-plugin"],
    skills: {
      paths: [
        "/x/share/workflow-toolkit/skills",
        "~/.config/opencode/skills",
        "/other/custom-skills",
      ],
      enabled: ["wk-commit"],
    },
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  const skills = config.skills as { paths?: string[]; enabled?: string[] };
  expect(skills.paths).toEqual(["~/.config/opencode/skills", "/other/custom-skills"]);
  expect(skills.enabled).toEqual(["wk-commit"]);
  expect(changed).toEqual(["plugin", "skills.paths"]);
});

test("mergeOpenCodeConfig keeps skill paths that merely contain the substring, drops only canonical Workit dirs", () => {
  const input = {
    plugin: ["other-plugin"],
    skills: {
      paths: [
        "/x/share/workflow-toolkit/skills",
        "~/projects/my-workflow-toolkit-skills",
        "~/.config/opencode/skills",
      ],
    },
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  const skills = config.skills as { paths?: string[] };
  expect(skills.paths).toEqual([
    "~/projects/my-workflow-toolkit-skills",
    "~/.config/opencode/skills",
  ]);
  expect(changed).toEqual(["plugin", "skills.paths"]);
});

test("mergeOpenCodeConfig reports no changes when the config is already canonical", () => {
  const input = { plugin: [PIN], skills: { paths: ["/other/skills"] } };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  expect(config.plugin).toEqual([PIN]);
  expect(changed).toEqual([]);
});

test("mergeOpenCodeConfig tolerates a missing config and a string plugin field", () => {
  const { config } = mergeOpenCodeConfig(undefined, PIN);
  expect(config.plugin).toEqual([PIN]);
  const str = mergeOpenCodeConfig({ plugin: "@brainervirus/workit-opencode" }, PIN);
  expect(str.config.plugin).toEqual([PIN]);
});

test("mergeCursorSettings writes the canonical workit identity and removes exact legacy entries", () => {
  const input = {
    enabled_plugins: {
      "local/workflow-toolkit": true,
      "workflow-toolkit": true,
      "some-other-plugin": true,
      "my-workflow-toolkit-plugin": true, // unrelated similarly-named plugin (D3)
    },
    plugin_dirs: [OTHER_PLUGIN_DIR, LEGACY_PLUGIN_DIR],
    "chat.temperature": 0.3,
    telemetry: { machineId: "abc" },
  };
  const { config, changed } = mergeCursorSettings(input, CURSOR_PLUGIN_DIR);
  expect(config.enabled_plugins).toEqual({
    workit: true,
    "some-other-plugin": true,
    "my-workflow-toolkit-plugin": true,
  });
  expect(config.plugin_dirs).toEqual([OTHER_PLUGIN_DIR, CURSOR_PLUGIN_DIR]);
  expect(config["chat.temperature"]).toBe(0.3);
  expect(JSON.stringify(config.telemetry)).toBe(JSON.stringify(input.telemetry));
  expect(changed).toEqual(["enabled_plugins", "plugin_dirs"]);
});

test("mergeCursorEnabledPlugins writes workit and drops every legacy Workit key, preserving unrelated keys", () => {
  const { config, changed } = mergeCursorEnabledPlugins({
    "workflow-toolkit": true,
    "local/workflow-toolkit": true,
    "some-other-plugin": true,
  });
  expect(config).toEqual({ workit: true, "some-other-plugin": true });
  expect(changed).toEqual(["enabled_plugins"]);
});

test("mergeCursorEnabledPlugins is idempotent once canonical", () => {
  const once = mergeCursorEnabledPlugins({ workit: true });
  expect(once.changed).toEqual([]);
  expect(once.config).toEqual({ workit: true });
});

test("mergeCursorPluginDirs removes the exact legacy directory and appends the canonical one", () => {
  const { config, changed } = mergeCursorPluginDirs(
    [OTHER_PLUGIN_DIR, LEGACY_PLUGIN_DIR],
    CURSOR_PLUGIN_DIR,
  );
  expect(config).toEqual([OTHER_PLUGIN_DIR, CURSOR_PLUGIN_DIR]);
  expect(changed).toEqual(["plugin_dirs"]);
});

test("mergeOpenCodeConfig does not mutate the caller's nested skills object", () => {
  const skills = { paths: ["/x/share/workflow-toolkit/skills", "/other"], enabled: ["wk-commit"] };
  const input = { plugin: ["other-plugin"], skills };
  const before = JSON.stringify(skills);
  mergeOpenCodeConfig(input, PIN);
  expect(JSON.stringify(skills)).toBe(before);
  expect(skills.paths).toEqual(["/x/share/workflow-toolkit/skills", "/other"]);
});

test("mergeCursorPluginDirs normalizes trailing slashes so variants do not duplicate", () => {
  const pkg = path.join("/pkg");
  const pkgTrailing = `${pkg}${path.sep}`;

  const appended = mergeCursorPluginDirs([], pkgTrailing);
  expect(appended.config).toEqual([pkg]);
  expect(appended.changed).toEqual(["plugin_dirs"]);

  const dedup = mergeCursorPluginDirs([pkg], pkgTrailing);
  expect(dedup.config).toEqual([pkg]);
  expect(dedup.changed).toEqual([]);

  const existing = mergeCursorPluginDirs([pkgTrailing], pkg);
  expect(existing.config).toEqual([pkgTrailing]);
  expect(existing.changed).toEqual([]);
});

test("mergeCursorSettings is idempotent", () => {
  const once = mergeCursorSettings({ enabled_plugins: {}, plugin_dirs: [] }, CURSOR_PLUGIN_DIR);
  expect(once.config.plugin_dirs).toEqual([CURSOR_PLUGIN_DIR]);
  const twice = mergeCursorSettings(once.config, CURSOR_PLUGIN_DIR);
  expect(twice.config).toEqual(once.config);
  expect(twice.changed).toEqual([]);
});

test("mergeCursorMcp replaces the legacy MCP name with one portable server", () => {
  const portable = { command: "node", args: ["/pkg/dist/mcp-server.js", "${workspaceFolder}"] };
  const input = {
    mcpServers: {
      "workflow-toolkit": { command: "bash", args: ["-lc", "legacy"] },
      "other-server": { command: "python", args: ["-m", "http.server"] },
    },
  };
  const { config, changed } = mergeCursorMcp(input, "workit", portable);
  const servers = config.mcpServers as Record<string, unknown>;
  expect(Object.keys(servers).sort()).toEqual(["other-server", "workit"]);
  expect(servers.workit).toEqual(portable);
  expect(JSON.stringify(servers["other-server"])).toBe(
    JSON.stringify(input.mcpServers["other-server"]),
  );
  expect(changed).toEqual(["mcpServers"]);
});

test("mergeCursorMcp is idempotent", () => {
  const portable = { command: "node", args: ["/pkg/dist/mcp-server.js", "${workspaceFolder}"] };
  const once = mergeCursorMcp({ mcpServers: {} }, "workit", portable);
  const twice = mergeCursorMcp(once.config, "workit", portable);
  expect(twice.config).toEqual(once.config);
  expect(twice.changed).toEqual([]);
});

test("mergeCursorHooks swaps the sessionStart command and keeps unrelated hook config", () => {
  const input = {
    version: 1,
    hooks: {
      sessionStart: [{ command: "./hooks/session-start" }],
      otherHook: [{ command: "echo hi" }],
    },
  };
  const { config, changed } = mergeCursorHooks(input, {
    command: "node",
    args: ["./dist/cursor-session-start.js"],
  });
  const hooks = config.hooks as {
    sessionStart?: { command: string; args?: string[] }[];
    otherHook?: { command: string }[];
  };
  expect(hooks.sessionStart).toEqual([
    { command: "node", args: ["./dist/cursor-session-start.js"] },
  ]);
  expect(hooks.otherHook).toEqual([{ command: "echo hi" }]);
  expect(changed).toEqual(["hooks.sessionStart"]);
});

test("cursorMcpServerEntry prefers the node dist bundle and falls back to the shim", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-entry-"));
  try {
    const dist = path.join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "mcp-server.js"), "");
    const entry = cursorMcpServerEntry(root);
    expect(entry.command).toBe("node");
    expect(entry.args[0]).toContain(path.join("dist", "mcp-server.js"));
    expect(entry.args[1]).toBe("${workspaceFolder}");
    rmSync(dist, { recursive: true, force: true });

    const fallback = cursorMcpServerEntry(root);
    expect(fallback.command).toBe("bash");
    expect(fallback.args[0]).toContain(path.join("mcp", "run-server.sh"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursorHooksEntry prefers the node dist bundle and falls back to the shim", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-hooks-entry-"));
  try {
    const dist = path.join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "cursor-session-start.js"), "");
    const entry = cursorHooksEntry(root);
    expect(entry.command).toBe("node");
    expect(entry.args[0]).toContain(path.join("dist", "cursor-session-start.js"));
    rmSync(dist, { recursive: true, force: true });

    const fallback = cursorHooksEntry(root);
    expect(fallback.command).toBe("bash");
    expect(fallback.args[0]).toContain(path.join("hooks", "session-start"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
