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
  for (const key of ["WORKFLOW_TOOLKIT_DEV", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
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

test("G Cursor settings register a plugin dir that is empty, W doctor runs, T plugin_files warns naming the dir and the install command", () => {
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
  expect(result.fix).toContain("workit init");
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

test("G Codex config enables a workit plugin whose cache is gone, W doctor runs, T plugin_files warns with the codex command; no workit plugin in config is not a warning", () => {
  const doctor = doctorFor("codex-missing");
  const codexHome = path.join(doctor.home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(path.join(codexHome, "config.toml"), `[plugins."workit@workit"]\nenabled = true\n`);
  const result = row(doctor.run());
  expect(result.status).toBe("warn");
  expect(result.detail).toContain("workit@workit");
  expect(result.fix).toContain("codex plugin add workit@workit");

  const bare = doctorFor("codex-none");
  mkdirSync(path.join(bare.home, ".codex"), { recursive: true });
  writeFileSync(path.join(bare.home, ".codex", "config.toml"), `model = "x"\n`);
  expect(row(bare.run()).status).toBe("pass");
});
