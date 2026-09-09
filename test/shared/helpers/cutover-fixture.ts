import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKIT_METHOD_SKILLS } from "../../../packages/workit-core/src/core/skill-manifests";

export type CutoverFixture = {
  root: string;
  home: string;
  configDir: string;
  stateDir: string;
  dev: string;
  workspace: string;
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  pluginDir: string;
  cleanup: () => void;
};

export const digestBytes = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const managedBytes = (fixture: CutoverFixture): Record<string, Buffer> => {
  const out: Record<string, Buffer> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = readFileSync(p);
    }
  };
  walk(fixture.configDir);
  walk(fixture.home);
  return out;
};

const mk = (dir: string, ...parts: string[]): string => {
  const p = path.join(dir, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

const writeLegacyFlowRecords = (workspace: string, count: number) => {
  for (let i = 0; i < count; i++) {
    const slug = `legacy-flow-${i}`;
    const dir = mk(workspace, "docs", slug, "sdd");
    writeFileSync(
      path.join(dir, "flow.json"),
      JSON.stringify(
        {
          slug,
          activated: i < 3,
          execution: { status: i < 3 ? "completed" : "pending" },
          updated_at: Date.now(),
        },
        null,
        2,
      ) + "\n",
    );
  }
};

export function makeCutoverFixture(opts: { legacyFlows?: number; secret?: string } = {}): CutoverFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-cutover-"));
  const home = mk(root, "home");
  const configDir = mk(root, "config");
  const stateDir = mk(root, "state");
  const dev = mk(root, "dev");
  const workspace = mk(root, "workspace");
  const pluginDir = mk(home, ".cursor", "plugins", "local", "workit");
  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
  const cursorSettings = path.join(home, ".cursor", "settings.json");
  const cursorMcp = path.join(home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(opencodeConfig), { recursive: true });

  mk(dev, "packages", "workit-core", "src", "core");
  mk(dev, "packages", "workit-opencode", "src");
  mk(dev, "packages", "workit-opencode", "assets", "commands");
  mk(dev, "packages", "workit-cursor", "dist");
  mk(dev, "packages", "workit-cursor", "hooks");
  mk(dev, "packages", "workit-codex", ".codex-plugin");
  mk(dev, "packages", "workit-pi");

  writeFileSync(path.join(dev, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
  writeFileSync(path.join(dev, "packages/workit-opencode/assets/commands/wk-init.md"), "# wk-init\n");
  writeFileSync(
    path.join(dev, "packages/workit-cursor/dist/mcp-server.js"),
    "#!/usr/bin/env node\n// bundle\n",
  );
  writeFileSync(
    path.join(dev, "packages/workit-cursor/dist/cursor-session-start.js"),
    "#!/usr/bin/env node\n// hook\n",
  );
  writeFileSync(
    path.join(dev, "packages/workit-cursor/hooks/hooks-cursor.json"),
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command:
              "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
          },
        ],
      },
    }),
  );

  for (const skill of ["wk-init", "wk-status"]) {
    const dir = mk(pluginDir, "skills", skill);
    writeFileSync(path.join(dir, "SKILL.md"), "# legacy\n");
  }
  mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  writeFileSync(path.join(pluginDir, "dist/mcp-server.js"), "#!/usr/bin/env node\n// bundle\n");
  writeFileSync(
    path.join(pluginDir, "dist/cursor-session-start.js"),
    "#!/usr/bin/env node\n// hook\n",
  );
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  cpSync(
    path.join(dev, "packages/workit-cursor/hooks/hooks-cursor.json"),
    path.join(pluginDir, "hooks/hooks-cursor.json"),
  );

  const secret = opts.secret ?? "secret-value";
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        locale: "es-CL",
        timezone: "America/Santiago",
        workflowMode: "strict",
        branchPolicy: { preset: "custom", allowed: ["*"], protected: ["main"] },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    path.join(configDir, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.com", tokenFile: "youtrack.token" }),
  );
  writeFileSync(path.join(configDir, "youtrack.token"), `${secret}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(configDir, "vcs.json"),
    JSON.stringify({ gitlab: { tokenFile: "gitlab.token" } }),
  );
  writeFileSync(path.join(configDir, "gitlab.token"), "glpat-legacy\n", { mode: 0o600 });
  writeFileSync(
    path.join(configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "main", glob: `${workspace}/**` }],
    }),
  );
  writeFileSync(
    path.join(home, ".cursor", "settings.json"),
    JSON.stringify({
      enabled_plugins: { workit: true, "unrelated-plugin": true },
      plugin_dirs: [pluginDir],
      theme: "dark",
    }),
  );
  writeFileSync(
    cursorMcp,
    JSON.stringify({
      mcpServers: {
        workit: {
          command: "npx",
          args: [
            "-y",
            "--prefer-online",
            "--package=@brainervirus/workit-cursor@latest",
            "workit-cursor-mcp",
            "${workspaceFolder}",
          ],
        },
        "keep-me": { command: "echo", args: ["ok"] },
      },
    }),
  );
  writeFileSync(
    opencodeConfig,
    JSON.stringify({ plugin: [`file://${dev}/packages/workit-opencode/src/plugin.ts`] }),
  );

  writeLegacyFlowRecords(workspace, opts.legacyFlows ?? 31);

  mk(workspace, ".workit", "tasks");
  writeFileSync(
    path.join(workspace, ".workit", "tasks", "task-1.json"),
    JSON.stringify({ id: "task-1", title: "v1 task referencing docs/legacy-flow-0/spec.md" }) + "\n",
  );

  return {
    root,
    home,
    configDir,
    stateDir,
    dev,
    workspace,
    opencodeConfig,
    cursorSettings,
    cursorMcp,
    pluginDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function installV1Skills(pluginDir: string) {
  for (const skill of WORKIT_METHOD_SKILLS) {
    const dir = mk(pluginDir, "skills", skill);
    writeFileSync(path.join(dir, "SKILL.md"), "# v1\n");
  }
}

export function removeLegacySkills(pluginDir: string) {
  for (const name of readdirSync(path.join(pluginDir, "skills"))) {
    if (name.startsWith("wk-")) rmSync(path.join(pluginDir, "skills", name), { recursive: true, force: true });
  }
}
