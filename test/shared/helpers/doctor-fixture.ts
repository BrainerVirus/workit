import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CANONICAL_SKILLS } from "../../../packages/workit-core/src/core/skill-manifests";

// Shared fixture builder for the offline doctor (DG-07/DG-08). Builds an
// isolated HOME + fake monorepo (dev) + config/state dirs so every check runs
// against disposable files, never the real user config. Tests mutate files and
// re-run; cleanup removes the whole tree.

export type DoctorFixture = {
  root: string;
  home: string;
  configDir: string;
  stateDir: string;
  dev: string;
  cwd: string;
  opencodeConfig: string;
  cursorSettings: string;
  cursorMcp: string;
  pluginDir: string;
  cleanup: () => void;
};

const mk = (dir: string, ...parts: string[]): string => {
  const p = path.join(dir, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

export const makeDoctorFixture = (): DoctorFixture => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-"));
  const home = mk(root, "home");
  const configDir = mk(root, "config");
  const stateDir = mk(root, "state");
  const dev = mk(root, "dev");
  const cwd = mk(root, "work");

  const opencodeConfig = path.join(home, ".config", "opencode", "opencode.json");
  const cursorSettings = path.join(home, ".cursor", "settings.json");
  const cursorMcp = path.join(home, ".cursor", "mcp.json");
  const pluginDir = path.join(home, ".cursor", "plugins", "local", "workit");
  mkdirSync(path.dirname(opencodeConfig), { recursive: true });
  mkdirSync(path.dirname(cursorSettings), { recursive: true });

  // Fake monorepo: core + three adapters with version/asset/launcher layout.
  mk(dev, "packages", "workit-core");
  for (const skill of CANONICAL_SKILLS.superpowers) {
    mk(dev, "packages", "workit-core", "vendor", "superpowers", "skills", skill);
    mk(pluginDir, "vendor", "superpowers", "skills", skill);
  }
  for (const skill of CANONICAL_SKILLS.workit) mk(pluginDir, "skills", skill);
  mk(dev, "packages", "workit-opencode", "src");
  mk(dev, "packages", "workit-opencode", "assets", "commands");
  mk(dev, "packages", "workit-opencode", "assets", "skills", "wk-init");
  mk(dev, "packages", "workit-opencode", "assets", "templates");
  mk(
    dev,
    "packages",
    "workit-opencode",
    "assets",
    "vendor",
    "superpowers",
    "skills",
    "brainstorming",
  );
  mk(dev, "packages", "workit-cursor", "dist");
  mk(dev, "packages", "workit-cursor", "assets", "templates");
  mk(dev, "packages", "workit-cursor", "mcp");
  mk(dev, "packages", "workit-cursor", "hooks");
  mk(dev, "packages", "workit-cursor", ".cursor-plugin");
  mk(dev, "packages", "workit-cli", "src");
  mk(dev, "packages", "workit-cli", "assets", "templates");

  writeFileSync(
    path.join(dev, "packages", "workit-core", "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-core", version: "0.4.0" }),
  );
  for (const skill of CANONICAL_SKILLS.superpowers) {
    writeFileSync(
      path.join(dev, "packages/workit-core/vendor/superpowers/skills", skill, "SKILL.md"),
      "# skill\n",
    );
    writeFileSync(
      path.join(pluginDir, "vendor/superpowers/skills", skill, "SKILL.md"),
      "# skill\n",
    );
  }
  for (const skill of CANONICAL_SKILLS.workit) {
    writeFileSync(path.join(pluginDir, "skills", skill, "SKILL.md"), "# skill\n");
  }
  mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(pluginDir, "dist", "mcp-server.js"),
    "#!/usr/bin/env node\n// installed bundle\n",
  );
  writeFileSync(
    path.join(pluginDir, "dist", "cursor-session-start.js"),
    "#!/usr/bin/env node\n// installed hook bundle\n",
  );
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(
    path.join(pluginDir, "hooks", "hooks-cursor.json"),
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          { command: "npx -y --package=@brainervirus/workit-cursor@0.8.0 workit-cursor-session-start" },
        ],
      },
    }),
  );
  const adapter = (name: string, extra: Record<string, string> = {}) =>
    JSON.stringify({
      name,
      version: "0.4.0",
      dependencies: { "@brainervirus/workit-core": "workspace:*", ...extra },
    });
  writeFileSync(
    path.join(dev, "packages", "workit-opencode", "package.json"),
    adapter("@brainervirus/workit-opencode", { "@opencode-ai/plugin": "1.17.7" }),
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "package.json"),
    adapter("@brainervirus/workit-cursor"),
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cli", "package.json"),
    adapter("@brainervirus/workit-cli"),
  );

  writeFileSync(
    path.join(dev, "packages", "workit-opencode", "src", "plugin.ts"),
    "export default {};\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-opencode", "assets", "commands", "wk-init.md"),
    "# wk-init\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-opencode", "assets", "skills", "wk-init", "SKILL.md"),
    "# skill\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-opencode", "assets", "templates", "spec-template.md"),
    "# spec\n",
  );
  writeFileSync(
    path.join(
      dev,
      "packages",
      "workit-opencode",
      "assets",
      "vendor",
      "superpowers",
      "skills",
      "brainstorming",
      "SKILL.md",
    ),
    "# b\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "dist", "mcp-server.js"),
    "// bundle\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "dist", "cursor-session-start.js"),
    "// bundle\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "assets", "templates", "spec-template.md"),
    "# spec\n",
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        workit: {
          command: "npx",
          args: [
            "-y",
            "--package=@brainervirus/workit-cursor@0.8.0",
            "workit-cursor-mcp",
            "${workspaceFolder}",
          ],
        },
      },
    }),
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", "marketplace.json"),
    JSON.stringify({ name: "workit", version: "0.4.0" }),
  );
  writeFileSync(
    path.join(dev, "packages", "workit-cursor", ".cursor-plugin", "manifest.json"),
    JSON.stringify({ name: "workit" }),
  );
  writeFileSync(path.join(dev, "packages", "workit-cli", "src", "index.tsx"), "export {};\n");
  writeFileSync(
    path.join(dev, "packages", "workit-cli", "assets", "templates", "spec-template.md"),
    "# spec\n",
  );

  // Healthy registration surfaces: one opencode pin, one cursor identity.
  writeFileSync(
    opencodeConfig,
    JSON.stringify({ plugin: [`file://${dev}/packages/workit-opencode/src/plugin.ts`] }),
  );
  writeFileSync(
    cursorSettings,
    JSON.stringify({
      enabled_plugins: { workit: true },
      plugin_dirs: [pluginDir],
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
            "--package=@brainervirus/workit-cursor@0.8.0",
            "workit-cursor-mcp",
            "${workspaceFolder}",
          ],
        },
      },
    }),
  );

  return {
    root,
    home,
    configDir,
    stateDir,
    dev,
    cwd,
    opencodeConfig,
    cursorSettings,
    cursorMcp,
    pluginDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

// A PATH-scoped bin dir carrying only node+bun (no git/flock), for the
// runtime/utility detection fixtures.
export const binDirWithRuntimes = (root: string): string => {
  const bin = mk(root, "path-bin");
  for (const name of ["node", "bun"]) {
    if (process.platform === "win32") {
      // git-bash `command -v` yields msys paths symlinks cannot use; resolve
      // via `where` and symlink the real executable (copy as a fallback when
      // symlink creation is unavailable — copying node+bun is ~200MB, so it
      // is the last resort).
      const which = spawnSync("where", [name], { encoding: "utf8" });
      const target = which.stdout?.split("\n")[0]?.trim();
      if (target && existsSync(target)) {
        try {
          require("node:fs").symlinkSync(target, path.join(bin, `${name}.exe`));
          continue;
        } catch {
          try {
            copyFileSync(target, path.join(bin, `${name}.exe`));
          } catch {
            /* keep going */
          }
        }
      }
      continue;
    }
    const real = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
    const target = real.stdout?.trim();
    if (target) {
      try {
        require("node:fs").symlinkSync(target, path.join(bin, name));
      } catch {
        /* already linked */
      }
    }
  }
  return bin;
};
