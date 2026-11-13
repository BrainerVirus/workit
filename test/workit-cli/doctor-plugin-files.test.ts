import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, type DoctorReport } from "@/packages/workit-cli/src/admin/doctor";

// A host config that registers the Workit plugin while the plugin's files are
// gone (Cursor's plugin dir emptied, Codex's cache removed) loads nothing and
// says nothing. The doctor reads the config and the directory, and names the
// command that puts the files back.

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-plugin-files-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const doctorFor = (name: string) => {
  const home = path.join(base, name, "home");
  const cwd = path.join(base, name, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of ["WORKIT_DEV", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
  const run = (): DoctorReport =>
    runDoctor({
      host: "cli",
      home,
      cwd,
      workspaceRoot: cwd,
      configDir: path.join(home, ".config", "workit"),
      stateDir: path.join(home, ".local", "state", "workit"),
      env,
    });
  return { home, run };
};

const row = (report: DoctorReport) => report.checks.find((c) => c.id === "plugin_files")!;

test("G Cursor settings register a plugin dir that is empty, W doctor runs, T plugin_files warns naming the dir and `workit install --hosts=cursor`", () => {
  const doctor = doctorFor("cursor-empty");
  const pluginDir = path.join(doctor.home, ".cursor", "plugins", "local", "workit");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(doctor.home, ".cursor", "settings.json"),
    JSON.stringify({ plugin_dirs: [pluginDir] }),
  );
  const result = row(doctor.run());
  expect(result.status).toBe("warn");
  expect(result.detail).toContain(pluginDir);
  expect(result.detail).toContain("empty");
  expect(result.fix).toContain("workit install --hosts=cursor");
  expect(result.fix).toContain("Cursor");
});

test("G Cursor settings register a plugin dir that holds the plugin, W doctor runs, T plugin_files passes", () => {
  const doctor = doctorFor("cursor-ok");
  const pluginDir = path.join(doctor.home, ".cursor", "plugins", "local", "workit");
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(path.join(pluginDir, "package.json"), "{}");
  writeFileSync(
    path.join(doctor.home, ".cursor", "settings.json"),
    JSON.stringify({ plugin_dirs: [pluginDir] }),
  );
  expect(row(doctor.run()).status).toBe("pass");
});

test("G Codex config enables a workit plugin whose cache is gone, W doctor runs, T plugin_files warns with `workit install --hosts=codex`; no workit plugin in config is not a warning", () => {
  const doctor = doctorFor("codex-missing");
  const codexHome = path.join(doctor.home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, "config.toml"), `[plugins."workit@workit"]\nenabled = true\n`);
  const result = row(doctor.run());
  expect(result.status).toBe("warn");
  expect(result.detail).toContain("workit@workit");
  expect(result.fix).toBe("workit install --hosts=codex");

  const bare = doctorFor("codex-none");
  mkdirSync(path.join(bare.home, ".codex"), { recursive: true });
  writeFileSync(path.join(bare.home, ".codex", "config.toml"), `model = "x"\n`);
  expect(row(bare.run()).status).toBe("pass");
});

test("G `workit upgrade` ends verified, W doctor runs with only: upgrade, T it runs the version, asset, agent, permission, native-deny and grant-seal checks and nothing else", () => {
  const doctor = doctorFor("upgrade-only");
  const report = runDoctor({
    host: "cli",
    home: doctor.home,
    cwd: doctor.home,
    workspaceRoot: doctor.home,
    configDir: path.join(doctor.home, ".config", "workit"),
    stateDir: path.join(doctor.home, ".local", "state", "workit"),
    env: { ...process.env, HOME: doctor.home, WORKIT_DEV: "" },
    only: "upgrade",
  });
  expect(report.checks.map((check): string => check.id).toSorted()).toEqual(
    [
      "versions",
      "codex_pin",
      "codex_agents",
      "pi_extension",
      "opencode_version",
      "claude_plugin",
      "assets",
      "launcher",
      "plugin_files",
      "stale_pin",
      "stale_install",
      "claude_permissions",
      "codex_permissions",
      "cursor_permissions",
      "claude_grant_rules",
      "codex_grant_rules",
      "cursor_grant_rules",
      "grant_seal",
      "native_deny",
    ].toSorted(),
  );
});

test("G a Cursor host whose launcher entries are missing, W doctor runs for cursor from an installed package, T launcher fails naming `workit install --hosts=cursor`", () => {
  const doctor = doctorFor("cursor-launcher");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: doctor.home };
  delete env.WORKIT_DEV;
  const report = runDoctor({
    host: "cursor",
    home: doctor.home,
    cwd: doctor.home,
    workspaceRoot: doctor.home,
    configDir: path.join(doctor.home, ".config", "workit"),
    stateDir: path.join(doctor.home, ".local", "state", "workit"),
    env,
  });
  const launcher = report.checks.find((check) => check.id === "launcher")!;
  expect(launcher.status).toBe("fail");
  expect(launcher.fix).toStartWith("workit install --hosts=cursor");
});
