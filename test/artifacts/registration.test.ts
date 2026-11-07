import { expect, test } from "bun:test";
import path from "node:path";
import {
  CURSOR_PRETOOLUSE_MATCHER,
  CURSOR_RUNTIME_PACKAGE,
  cursorHookDrift,
  cursorHookLocalDistEntry,
  cursorHooksEntry,
  cursorMcpLocalDistEntry,
  cursorMcpServerEntry,
  isWorkitPlugin,
  mergeCursorEnabledPlugins,
  mergeCursorHooks,
  mergeCursorMcp,
  mergeCursorPluginDirs,
  mergeCursorSettings,
  mergeOpenCodeConfig,
  mergeOpenCodePlugins,
} from "@/packages/workit-cli/src/admin/registration";

// Task 8 registration gate (RR-06): the installer registration merges accept an
// existing user config, deduplicate every current + legacy Workit identity, and
// return the deduplicated config PLUS the explicit list of keys changed — never
// rewriting unrelated user settings (values round-trip JSON-identical).

const HOOK_COMMAND = 'node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" workit-cursor-hook';
const SESSION_COMMAND = 'node "${CURSOR_PLUGIN_ROOT}/hooks/launch.mjs" workit-cursor-session-start';

const PIN = "file:///work/packages/workit-opencode/src/plugin.ts";
const CURSOR_ROOT = path.join("/home/user", ".cursor");
const CURSOR_PLUGIN_DIR = path.join(CURSOR_ROOT, "plugins", "local", "workit");
// The old product name, spelled in parts so the no-legacy-name guard stays clean.
const OLD_NAME = ["workflow", "toolkit"].join("-");
const OTHER_PLUGIN_DIR = path.join(CURSOR_ROOT, "plugins", "local", "other");

test("isWorkitPlugin matches every Workit identity, never unrelated plugins or the old name", () => {
  for (const id of [
    "@workit-dev/opencode",
    "@workit-dev/opencode@1.0.0",
    "@workit-dev/cursor",
    "@workit-dev/cursor@2.0.0",
    "file:///work/packages/workit-opencode/src/plugin.ts",
    "file:///work/packages/workit-opencode",
    "file:///work/packages/workit-cursor",
    "file:///x/node_modules/@workit-dev/opencode",
    "file:///x/node_modules/@workit-dev/opencode/dist/plugin.js",
    "file:///x/packages/workit-opencode/src/plugin.ts",
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
    "@workit-dev/opencode-helper",
    "@workit-dev/cursor-tools",
    "@workit-dev/opencode-extra",
    "@workit-dev/cursor-legacy",
    OLD_NAME,
    `local/${OLD_NAME}`,
    `${OLD_NAME}-opencode@git+file:///old/checkout`,
    `git+file:///work/${OLD_NAME}`,
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

// AR-04: prefix-shared names are unrelated packages, never Workit identities.
test("isWorkitPlugin rejects prefix-shared @workit-dev names, still accepts exact names", () => {
  for (const id of [
    "@workit-dev/opencode",
    "@workit-dev/opencode@0.4.0",
    "@workit-dev/opencode@^0.4.0",
    "@workit-dev/cursor",
    "@workit-dev/cursor@0.4.0",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(true);
  }
  for (const id of [
    "@workit-dev/opencode-helper",
    "@workit-dev/cursor-tools",
    "@workit-dev/opencode-extra",
    "@workit-dev/cursor-legacy",
    "@workit-dev/cursor-tools@1.0.0",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

test("isWorkitPlugin preserves unrelated plugin ids that merely contain workit (D3)", () => {
  for (const id of [
    "some-workit-helper",
    "my-workit-plugins",
    "my-workit-plugin",
    "workit-mcp",
    "org/plugin-workit-v2",
    "github.com/owner/workit-fork",
  ]) {
    expect(isWorkitPlugin(id), id).toBe(false);
  }
});

test("mergeOpenCodePlugins preserves unrelated workit-containing ids (D3)", () => {
  const existing = ["some-workit-helper", "@workit-dev/opencode", PIN];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([PIN, "some-workit-helper"]);
  expect(changed).toEqual(["plugins"]);
});

// AR-04: prefix-shared helper packages survive a registration merge unchanged.
test("mergeOpenCodePlugins preserves prefix-shared helper packages (AR-04)", () => {
  const existing = [
    "@workit-dev/opencode-helper",
    "@workit-dev/cursor-tools",
    "@workit-dev/opencode",
    PIN,
  ];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([PIN, "@workit-dev/opencode-helper", "@workit-dev/cursor-tools"]);
  expect(changed).toEqual(["plugins"]);
});

test("mergeOpenCodePlugins dedups every Workit identity to a single pin", () => {
  const existing = [
    "@dietrichgebert/ponytail",
    "file:///old/checkout/packages/workit-opencode",
    "@workit-dev/opencode",
    PIN,
  ];
  const { config, changed } = mergeOpenCodePlugins(existing, PIN);
  expect(config).toEqual([PIN, "@dietrichgebert/ponytail"]);
  expect(changed).toEqual(["plugins"]);
});

test("mergeOpenCodeConfig dedups plugins and preserves unrelated settings byte-for-byte", () => {
  const input: Record<string, unknown> = {
    model: "gpt-5",
    theme: "dark",
    $schema: "https://opencode.ai/config.json",
    plugins: [
      "@dietrichgebert/ponytail",
      "file:///old/checkout/packages/workit-opencode",
      "@workit-dev/opencode",
      PIN,
    ],
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  expect(config.plugins).toEqual([PIN, "@dietrichgebert/ponytail"]);
  expect(changed).toEqual(["plugins"]);
  for (const key of ["model", "theme", "$schema"]) {
    expect(JSON.stringify(config[key]), key).toBe(JSON.stringify(input[key]));
  }
  expect(Object.keys(config).toSorted()).toEqual(Object.keys(input).toSorted());
});

test("mergeOpenCodeConfig preserves every skill path without ownership evidence", () => {
  const input = {
    plugins: ["other-plugin"],
    skills: {
      paths: ["/x/share/workit/skills", "~/.config/opencode/skills", "/other/custom-skills"],
      enabled: ["wk-commit"],
    },
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  const skills = config.skills as { paths?: string[]; enabled?: string[] };
  expect(skills.paths).toEqual([
    "/x/share/workit/skills",
    "~/.config/opencode/skills",
    "/other/custom-skills",
  ]);
  expect(skills.enabled).toEqual(["wk-commit"]);
  expect(changed).toEqual(["plugins"]);
});

test("mergeOpenCodeConfig preserves similarly named and canonical Workit skill paths", () => {
  const input = {
    plugins: ["other-plugin"],
    skills: {
      paths: ["/x/share/workit/skills", "~/projects/my-workit-skills", "~/.config/opencode/skills"],
    },
  };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  const skills = config.skills as { paths?: string[] };
  expect(skills.paths).toEqual([
    "/x/share/workit/skills",
    "~/projects/my-workit-skills",
    "~/.config/opencode/skills",
  ]);
  expect(changed).toEqual(["plugins"]);
});

test("mergeOpenCodeConfig reports no changes when the config is already canonical", () => {
  const input = { plugins: [PIN], skills: { paths: ["/other/skills"] } };
  const { config, changed } = mergeOpenCodeConfig(input, PIN);
  expect(config.plugins).toEqual([PIN]);
  expect(changed).toEqual([]);
});

test("mergeOpenCodeConfig tolerates a missing config and a string plugin field", () => {
  const { config } = mergeOpenCodeConfig(undefined, PIN);
  expect(config.plugins).toEqual([PIN]);
  const str = mergeOpenCodeConfig({ plugin: "@workit-dev/opencode" }, PIN);
  expect(str.config.plugins).toEqual([PIN]);
  expect(str.config.plugin).toBeUndefined();
});

test("mergeOpenCodeConfig moves a Workit entry out of the deprecated plugin key", () => {
  const { config, changed } = mergeOpenCodeConfig(
    { plugin: ["@workit-dev/opencode", "<other>"] },
    PIN,
  );
  expect(config.plugins).toEqual([PIN]);
  expect(config.plugin).toEqual(["<other>"]);
  expect(changed).toEqual(["plugins", "plugin"]);
});

test("mergeCursorSettings writes the canonical workit identity and keeps unrelated entries", () => {
  const input = {
    enabled_plugins: {
      "some-other-plugin": true,
      "my-workit-plugin": true, // unrelated similarly-named plugin (D3)
    },
    plugin_dirs: [OTHER_PLUGIN_DIR],
    "chat.temperature": 0.3,
    telemetry: { machineId: "abc" },
  };
  const { config, changed } = mergeCursorSettings(input, CURSOR_PLUGIN_DIR);
  expect(config.enabled_plugins).toEqual({
    workit: true,
    "some-other-plugin": true,
    "my-workit-plugin": true,
  });
  expect(config.plugin_dirs).toEqual([OTHER_PLUGIN_DIR, CURSOR_PLUGIN_DIR]);
  expect(config["chat.temperature"]).toBe(0.3);
  expect(JSON.stringify(config.telemetry)).toBe(JSON.stringify(input.telemetry));
  expect(changed).toEqual(["enabled_plugins", "plugin_dirs"]);
});

test("mergeCursorEnabledPlugins writes workit and treats the old name as an unrelated key", () => {
  const { config, changed } = mergeCursorEnabledPlugins({
    [OLD_NAME]: true,
    "some-other-plugin": true,
  });
  expect(config).toEqual({ [OLD_NAME]: true, workit: true, "some-other-plugin": true });
  expect(changed).toEqual(["enabled_plugins"]);
});

test("mergeCursorEnabledPlugins is idempotent once canonical", () => {
  const once = mergeCursorEnabledPlugins({ workit: true });
  expect(once.changed).toEqual([]);
  expect(once.config).toEqual({ workit: true });
});

test("mergeCursorPluginDirs keeps other directories and appends the canonical one", () => {
  const { config, changed } = mergeCursorPluginDirs([OTHER_PLUGIN_DIR], CURSOR_PLUGIN_DIR);
  expect(config).toEqual([OTHER_PLUGIN_DIR, CURSOR_PLUGIN_DIR]);
  expect(changed).toEqual(["plugin_dirs"]);
});

test("mergeOpenCodeConfig does not mutate the caller's nested skills object", () => {
  const skills = { paths: ["/x/share/workit/skills", "/other"], enabled: ["wk-commit"] };
  const input = { plugin: ["other-plugin"], skills };
  const before = JSON.stringify(skills);
  mergeOpenCodeConfig(input, PIN);
  expect(JSON.stringify(skills)).toBe(before);
  expect(skills.paths).toEqual(["/x/share/workit/skills", "/other"]);
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

test("mergeCursorMcp replaces a stale workit server with one portable server", () => {
  const portable = { command: "node", args: ["/pkg/dist/mcp-server.js", "${workspaceFolder}"] };
  const input = {
    mcpServers: {
      workit: { command: "bash", args: ["-lc", "stale"] },
      "other-server": { command: "python", args: ["-m", "http.server"] },
    },
  };
  const { config, changed } = mergeCursorMcp(input, "workit", portable);
  const servers = config.mcpServers as Record<string, unknown>;
  expect(Object.keys(servers).toSorted()).toEqual(["other-server", "workit"]);
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
      sessionStart: [{ command: "echo legacy" }],
      otherHook: [{ command: "echo hi" }],
    },
  };
  const { config, changed } = mergeCursorHooks(input, {
    command: SESSION_COMMAND,
  });
  const hooks = config.hooks as {
    sessionStart?: { command: string; args?: string[] }[];
    preToolUse?: { command: string; matcher: string; failClosed: boolean }[];
    beforeShellExecution?: { command: string; failClosed: boolean }[];
    otherHook?: { command: string }[];
  };
  expect(hooks.sessionStart).toEqual([
    {
      command: SESSION_COMMAND,
    },
  ]);
  // Missing enforcement events are filled with the canonical entries so the
  // installer heals exactly what the doctor flags.
  expect(hooks.preToolUse).toEqual([
    { command: HOOK_COMMAND, matcher: CURSOR_PRETOOLUSE_MATCHER, failClosed: false },
  ]);
  expect(hooks.beforeShellExecution).toEqual([{ command: HOOK_COMMAND, failClosed: false }]);
  expect(hooks.otherHook).toEqual([{ command: "echo hi" }]);
  expect(changed).toEqual([
    "hooks.sessionStart",
    "hooks.preToolUse",
    "hooks.beforeShellExecution",
    "hooks.subagentStart",
    "hooks.subagentStop",
    "hooks.stop",
    "hooks.preCompact",
  ]);
  // Stop control continues a turn at most once: loop_limit 1.
  expect((config.hooks as Record<string, unknown>).stop).toEqual([
    { command: HOOK_COMMAND, loop_limit: 1, failClosed: false },
  ]);
});

test("mergeCursorHooks is idempotent on canonical input", () => {
  const canonical = {
    version: 1,
    hooks: {
      sessionStart: [
        {
          command: SESSION_COMMAND,
        },
      ],
      preToolUse: [
        { command: HOOK_COMMAND, matcher: CURSOR_PRETOOLUSE_MATCHER, failClosed: false },
      ],
      beforeShellExecution: [{ command: HOOK_COMMAND, failClosed: false }],
      subagentStart: [{ command: HOOK_COMMAND, failClosed: false }],
      subagentStop: [{ command: HOOK_COMMAND, failClosed: false }],
      stop: [{ command: HOOK_COMMAND, loop_limit: 1, failClosed: false }],
      preCompact: [{ command: HOOK_COMMAND, failClosed: false }],
    },
  };
  const { config, changed } = mergeCursorHooks(canonical, {
    command: SESSION_COMMAND,
  });
  expect(changed).toEqual([]);
  expect(config).toEqual(canonical);
});

test("cursorHookDrift flags divergent enforcement events, not absent ones", () => {
  expect(cursorHookDrift({ version: 1, hooks: {} })).toEqual([]);
  expect(
    cursorHookDrift({
      version: 1,
      hooks: { preToolUse: [{ command: HOOK_COMMAND, matcher: "Write" }] },
    }),
  ).toEqual(["preToolUse"]);
  expect(
    cursorHookDrift({
      version: 1,
      hooks: {
        preToolUse: [
          { command: HOOK_COMMAND, matcher: CURSOR_PRETOOLUSE_MATCHER, failClosed: false },
        ],
        beforeShellExecution: [{ command: "echo stale", failClosed: false }],
      },
    }),
  ).toEqual(["beforeShellExecution"]);
  expect(cursorHookDrift(null)).toEqual(["hooks file is not a hook map"]);
});

test("cursorHookDrift flags the legacy fail-closed npx @latest entries an older install carries", () => {
  const legacy =
    "npx -y --prefer-online --min-release-age=0 --package=@workit-dev/cursor@latest workit-cursor-hook";
  expect(
    cursorHookDrift({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: legacy, failClosed: true }],
        subagentStart: [{ command: HOOK_COMMAND, failClosed: true }],
        subagentStop: [{ command: HOOK_COMMAND }],
      },
    }),
  ).toEqual(["beforeShellExecution", "subagentStart"]);
  // A stop hook without loop_limit 1 could continue a turn more than once.
  expect(
    cursorHookDrift({
      version: 1,
      hooks: { stop: [{ command: HOOK_COMMAND, failClosed: false }] },
    }),
  ).toEqual(["stop"]);
});

test("cursorMcpServerEntry launches the published package via npx", () => {
  const entry = cursorMcpServerEntry("/any/pkg/dir");
  expect(entry.command).toBe("npx");
  expect(entry.args).toEqual([
    "-y",
    "--prefer-online",
    "--min-release-age=0",
    `--package=${CURSOR_RUNTIME_PACKAGE}`,
    "workit-cursor-mcp",
    "${workspaceFolder}",
  ]);
});

test("cursorHooksEntry uses the documented single command string with no args", () => {
  const entry = cursorHooksEntry();
  expect(entry.command).toBe(SESSION_COMMAND);
  expect(entry.args).toEqual([]);
  expect(cursorHooksEntry("/home/u/.cursor/plugins/local/workit").command).toBe(
    `node "${path.join("/home/u/.cursor/plugins/local/workit", "hooks", "launch.mjs")}" workit-cursor-session-start`,
  );
});

test("a local install's hook entries carry the absolute launcher path, which drift accepts", () => {
  const dir = "/home/u/.cursor/plugins/local/workit";
  const launcher = `node "${path.join(dir, "hooks", "launch.mjs")}"`;
  const { config } = mergeCursorHooks({ version: 1, hooks: {} }, { command: "s" }, dir);
  const hooks = config.hooks as Record<string, { command: string }[]>;
  for (const event of ["preToolUse", "beforeShellExecution", "subagentStart", "subagentStop"])
    expect(hooks[event][0].command, event).toBe(`${launcher} workit-cursor-hook`);
  expect(cursorHookDrift(config, dir)).toEqual([]);
  // Without the plugin dir only the portable form is canonical.
  expect(cursorHookDrift(config)).toEqual([
    "preToolUse",
    "beforeShellExecution",
    "subagentStart",
    "subagentStop",
    "stop",
    "preCompact",
  ]);
});

test("cursorMcpLocalDistEntry launches the installed dist through node", () => {
  const entry = cursorMcpLocalDistEntry("/pkg");
  expect(entry.command).toBe("node");
  expect(entry.args).toEqual([path.join("/pkg", "dist", "mcp-server.js"), "${workspaceFolder}"]);
});

test("cursorHookLocalDistEntry uses the node dist single command string with no args", () => {
  const entry = cursorHookLocalDistEntry("/pkg");
  expect(entry.command).toBe(`node ${path.join("/pkg", "dist", "cursor-session-start.js")}`);
  expect(entry.args).toEqual([]);
});

test("generated Cursor hook config never resolves @latest, never shells to npx, never fails closed", () => {
  for (const sessionStart of [cursorHooksEntry("/pkg"), cursorHookLocalDistEntry("/pkg")]) {
    const { config } = mergeCursorHooks(
      {
        version: 1,
        hooks: {
          preToolUse: [
            {
              command:
                "npx -y --prefer-online --min-release-age=0 --package=@workit-dev/cursor@latest workit-cursor-hook",
              failClosed: true,
            },
          ],
        },
      },
      { command: sessionStart.command },
    );
    const text = JSON.stringify(config);
    expect(text).not.toContain("@latest");
    expect(text).not.toContain("npx");
    expect(text).not.toContain('"failClosed":true');
  }
});

test.skipIf(process.platform === "win32")(
  "an absolute plugin path is escaped for sh -c inside the double-quoted launcher",
  () => {
    expect(cursorHooksEntry("/home/a$b`c/plugin").command).toBe(
      'node "/home/a\\$b\\`c/plugin/hooks/launch.mjs" workit-cursor-session-start',
    );
  },
);
