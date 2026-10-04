import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoRuntime } from "@/packages/workit-opencode/src/shared/repo-result";
import { initApplyData } from "@/packages/workit-core/src/core/init";
import { PLUGIN_ROOT } from "@/packages/workit-core/src/core/scripts";
import { WORKIT_TOOL_CATALOG } from "@/packages/workit-opencode/src/shared/tools";

import {
  executeInitApply,
  initApplyRuntime,
} from "@/packages/workit-opencode/src/shared/init-apply";

// The OpenCode V2 adapter calls the shared executor directly (v2/plugin.ts).
const createRepoTools = (runtime = initApplyRuntime) => ({
  workit_init_apply: {
    execute: async (args: unknown, context: { directory: string }) =>
      executeInitApply(args as never, context.directory, runtime),
  },
});

const initApplyInput = WORKIT_TOOL_CATALOG.find((tool) => tool.name === "workit_init_apply")!
  .input as { properties: Record<string, any> };

// Isolate from the developer's global config: tests assume gitflow semantics
// (PRESETS.gitflow in src/core/config.ts), like CI with no global config.
const previousXdg = process.env.XDG_CONFIG_HOME;
let isolatedConfig: string;
beforeAll(() => {
  isolatedConfig = mkdtempSync(path.join(os.tmpdir(), "wf-test-config-"));
  writeFileSync(
    path.join(isolatedConfig, "config.json"),
    JSON.stringify(
      {
        locale: "en",
        localeOptions: ["en"],
        branchPolicy: {
          preset: "gitflow",
          allowed: ["feature/*", "bugfix/*", "hotfix/*", "release/*"],
          protected: ["main", "develop", "master", "prod", "production"],
        },
      },
      null,
      2,
    ),
  );
  process.env.XDG_CONFIG_HOME = isolatedConfig;
});
afterAll(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(isolatedConfig, { recursive: true, force: true });
});

const initApplyCalls: Array<{ root: string; action: string; env: Record<string, string> }> = [];
const runtime: RepoRuntime = {
  initApply: (root: string, action: string, env: Record<string, string>) => {
    initApplyCalls.push({ root, action, env });
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, action: "youtrack_json" }),
      stderr: "",
      cwd: root,
    };
  },
};

test(
  "OpenCode init_apply exposes no workspace override",
  () => {
    expect("workspace_root" in initApplyInput.properties).toBe(false);
  },
  { timeout: 60_000 },
);

test(
  "init_apply rejects missing confirmation before any resolution",
  async () => {
    initApplyCalls.length = 0;
    const tools = createRepoTools(runtime);
    const raw = await tools.workit_init_apply.execute({ confirmed: false }, {
      directory: "/repo",
      worktree: "/repo",
    } as never);
    expect(JSON.parse(raw).error).toBe("confirmed: true required");
    expect(initApplyCalls.length).toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "legacy ok false values normalize to failures",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-false-"));
    try {
      const raw = await createRepoTools({
        ...runtime,
        initApply: (cwd: string) => ({
          exitCode: 0,
          stdout: JSON.stringify({ ok: false }),
          stderr: "",
          cwd,
        }),
      }).workit_init_apply.execute({ confirmed: true, action: "youtrack_scaffold" }, {
        directory: root,
        worktree: root,
      } as never);
      expect(JSON.parse(raw)).toEqual({
        ok: false,
        data: { stdout: JSON.stringify({ ok: false }), stderr: "", exitCode: 0 },
        error: "legacy operation reported failure",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "changelog implementation is package-owned",
  () => {
    const expectedRoot = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core");
    const port = path.join(PLUGIN_ROOT, "src", "core", "changelog.ts");
    expect(PLUGIN_ROOT).toBe(expectedRoot);
    expect(port.startsWith(`${PLUGIN_ROOT}${path.sep}`)).toBe(true);
    expect(port).not.toContain(".cursor/plugins");
    expect(existsSync(port)).toBe(true);
  },
  { timeout: 60_000 },
);

test(
  "OpenCode init omits obsolete MCP dependency installation",
  () => {
    expect(initApplyInput.properties.action.enum).not.toContain("npm_install");

    const config = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-init-"));
    try {
      const apply = initApplyData("npm_install", {
        ...process.env,
        WORKFLOW_TOOLKIT_CONFIG: config,
      });
      expect(String(apply.error)).toContain("unknown action npm_install");
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

test(
  "init_apply config locale validation matches core LOCALE_RE (es-419 in, es_cl out)",
  async () => {
    const previousToolkit = process.env.WORKFLOW_TOOLKIT_CONFIG;
    const dir = mkdtempSync(path.join(os.tmpdir(), "workflow-toolkit-locale-"));
    process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
    try {
      const tools = createRepoTools();
      const context = { directory: dir, worktree: dir } as never;

      const accepted = JSON.parse(
        await tools.workit_init_apply.execute(
          { confirmed: true, action: "config", locale: "es-419" },
          context,
        ),
      );
      expect(accepted.ok).toBe(true);
      expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"))).toMatchObject({
        locale: "es-419",
      });

      const rejected = JSON.parse(
        await tools.workit_init_apply.execute(
          { confirmed: true, action: "config", locale: "es_cl" },
          context,
        ),
      );
      expect(rejected.ok).toBe(false);
      expect(String(rejected.error)).toContain("invalid locale");
    } finally {
      if (previousToolkit === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
      else process.env.WORKFLOW_TOOLKIT_CONFIG = previousToolkit;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
