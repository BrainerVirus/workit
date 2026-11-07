import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, type DoctorReport } from "@/packages/workit-cli/src/admin/doctor";

// Workit restarted at 1.0.0 under @workit-dev. A machine that still runs the
// 14.x @brainervirus packages must not read as "newer than published": the
// doctor names each old-scope install and the one command that migrates them.

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-legacy-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const OLD = "@brainervirus";
const MIGRATE = `npx -y ${OLD}/workit-cli@latest upgrade`;

const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

const doctorAt = (name: string): { home: string; run: () => DoctorReport } => {
  const home = path.join(base, name, "home");
  const cwd = path.join(base, name, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: path.join(home, "bin"),
    // The registry serves the new scope's first release.
    WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.0",
  };
  for (const key of [
    "WORKIT_DEV",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
  ])
    delete env[key];
  return {
    home,
    run: () =>
      runDoctor({
        host: "cli",
        home,
        cwd,
        workspaceRoot: cwd,
        configDir: path.join(home, ".config", "workit"),
        stateDir: path.join(home, ".local", "state", "workit"),
        env,
      }),
  };
};

const row = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id)!;

test.skipIf(process.platform === "win32")(
  "Given a machine with 14.x @brainervirus installs, When the @workit-dev doctor runs, Then it reports each one with one migration command instead of a version comparison",
  () => {
    const doctor = doctorAt("old-scope");
    const { home } = doctor;
    // Workit-owned CLI: current -> versions/14.6.0 holding the old package.
    const root = path.join(home, ".local", "share", "workit");
    const cli = path.join(root, "versions", "14.6.0", "node_modules", OLD, "workit-cli");
    writeJson(path.join(cli, "package.json"), { name: `${OLD}/workit-cli`, version: "14.6.0" });
    symlinkSync(path.join(root, "versions", "14.6.0"), path.join(root, "current"));
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      plugin: [`${OLD}/workit-opencode@latest`],
    });
    writeJson(path.join(home, ".pi", "agent", "settings.json"), {
      packages: [`npm:${OLD}/workit-pi`],
    });
    writeJson(path.join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        workit: { command: "npx", args: ["-y", `--package=${OLD}/workit-cursor@latest`] },
      },
    });
    const plugin = path.join(home, ".claude", "plugins", "cache", "workit", "workit", "14.6.0");
    writeJson(path.join(plugin, "package.json"), {
      name: `${OLD}/workit-claude-code`,
      version: "14.6.0",
    });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "workit",
      repository: "https://github.com/BrainerVirus/workit",
    });
    writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
      plugins: { "workit@workit": [{ installPath: plugin, version: "14.6.0", scope: "user" }] },
    });

    const report = doctor.run();
    const legacy = row(report, "legacy_scope");
    expect(legacy.status).toBe("warn");
    expect(legacy.fix).toBe(MIGRATE);
    for (const what of [
      `Workit-owned CLI ${cli}`,
      `OpenCode plugin ${OLD}/workit-opencode@latest`,
      `Pi package npm:${OLD}/workit-pi`,
      `Cursor MCP server ${OLD}/workit-cursor@latest`,
      `Claude Code plugin workit@workit ${plugin} (14.6.0)`,
    ])
      expect(legacy.detail).toContain(what);
    // 14.6.0 is not "current" against the published 1.0.0.
    const claude = row(report, "claude_plugin");
    expect(claude.status).toBe("warn");
    expect(claude.detail).not.toContain("is current");
    expect(claude.detail).not.toContain("behind");
    expect(claude.fix).toBe(MIGRATE);
    expect(row(report, "cli_installs").detail).not.toContain("14.6.0");
  },
);

test.skipIf(process.platform === "win32")(
  "Given no @brainervirus install, When the doctor runs, Then legacy_scope passes",
  () => {
    const legacy = row(doctorAt("clean").run(), "legacy_scope");
    expect(legacy.status).toBe("pass");
    expect(legacy.fix).toBeUndefined();
  },
);
