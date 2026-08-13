import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "../../packages/workit-core/src/core/doctor";
import { readVcsConfig } from "../../packages/workit-core/src/core/vcs-config";
import { readSetupState } from "../../packages/workit-core/src/core/setup-state";
import { readWorkspacesResult } from "../../packages/workit-core/src/core/workspaces";
import { binDirWithRuntimes, makeDoctorFixture } from "../shared/helpers/doctor-fixture";

// The offline doctor engine (DG-07/DG-08, CA-09): one fixture tree, one broken
// surface at a time, assert the typed check + nonzero exitCode, then repair the
// fixture and assert it clears.

const check = (report: DoctorReport, id: string): DoctorCheck =>
  report.checks.find((c) => c.id === id)!;

const fixture = makeDoctorFixture();

const run = (overrides: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: overrides.cwd ?? fixture.cwd,
    env: overrides.env,
  });

// Installer mode (DG-09/AR-11): the installers enforce an explicit required set
// — selected-host runtime/assets/launcher/registration, malformed config, and
// required utilities — while optional parity checks may downgrade to warnings.
const runInstaller = (overrides: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: overrides.cwd ?? fixture.cwd,
    env: overrides.env,
    installer: true,
  });

const repoRoot = path.resolve(path.dirname(import.meta.dir), "..", "..");

// Fix helpers mutate a file then restore the original content at teardown.
const writeConfig = (p: string, content: string, mode?: number) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
};

afterAll(() => fixture.cleanup());

test("doctor is offline and a healthy fixture is fully green with exitCode 0", () => {
  const report = run();
  expect(report.offline).toBe(true);
  expect(report.ok).toBe(true);
  expect(report.exitCode).toBe(0);
  expect(report.summary.failed).toBe(0);
  expect(report.host).toBe("cli");
  expect(report.checks.length).toBeGreaterThanOrEqual(11);
  for (const c of report.checks) {
    expect(c.status, c.id).not.toBe("fail");
  }
  expect(report.fixes).toEqual([]);
});

test("detects a stale opencode pin and clears once re-pinned", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["workit-opencode@git+file:///nonexistent/stale"] }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "stale_pin").status).toBe("fail");
  expect(check(report, "stale_pin").fix).toBeTruthy();

  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
  );
  expect(check(run(), "stale_pin").status).toBe("pass");
});

test("detects a stale git+file workit pin and clears once re-pinned", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["workflow-toolkit-opencode@git+file:///legacy"] }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  const stale = check(report, "stale_pin");
  expect(stale.status).toBe("fail");
  expect(stale.detail).toContain("stale workit pin");
  expect(stale.fix).toBeTruthy();

  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
  );
  expect(check(run(), "stale_pin").status).toBe("pass");
});

test("detects a workit pin pointing at a deleted file and clears once restored", () => {
  const plugin = path.join(fixture.dev, "packages/workit-opencode/src/plugin.ts");
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [`file://${plugin}`] }));
  rmSync(plugin, { force: true });
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_pin");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("missing file");
    expect(stale.fix).toBeTruthy();
  } finally {
    writeConfig(plugin, "export default {};\n");
  }
  expect(check(run(), "stale_pin").status).toBe("pass");
});

test("accepts a string plugin entry (not just an array) when checking the pin", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: `file://${fixture.dev}/packages/workit-opencode/src/plugin.ts` }),
  );
  try {
    expect(check(run(), "stale_pin").status).toBe("pass");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("cursor host never inspects the opencode config for stale pins", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["workflow-toolkit-opencode@git+file:///legacy"] }),
  );
  try {
    const report = runDoctor({
      host: "cursor",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      dev: fixture.dev,
      cwd: fixture.cwd,
    });
    expect(report.exitCode).toBe(0);
    expect(check(report, "stale_pin").status).toBe("pass");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("detects mixed core versions across adapters and clears once aligned", () => {
  const opencodePkg = path.join(fixture.dev, "packages/workit-opencode/package.json");
  const good = opencodePkg;
  const original = JSON.parse(readFileSync(good, "utf8"));
  try {
    writeConfig(
      good,
      JSON.stringify({
        ...original,
        dependencies: { ...original.dependencies, "@brainervirus/workit-core": "^0.3.0" },
      }),
    );
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "versions").status).toBe("fail");
    expect(check(report, "versions").fix).toBeTruthy();
  } finally {
    writeConfig(good, JSON.stringify(original));
  }
  expect(check(run(), "versions").status).toBe("pass");
});

test("detects an out-of-matrix opencode SDK pin as mixed versions", () => {
  const opencodePkg = path.join(fixture.dev, "packages/workit-opencode/package.json");
  const original = JSON.parse(readFileSync(opencodePkg, "utf8"));
  try {
    writeConfig(
      opencodePkg,
      JSON.stringify({
        ...original,
        dependencies: { ...original.dependencies, "@opencode-ai/plugin": "0.9.0" },
      }),
    );
    const report = run();
    expect(check(report, "versions").status).toBe("fail");
    expect(report.exitCode).not.toBe(0);
  } finally {
    writeConfig(opencodePkg, JSON.stringify(original));
  }
  expect(check(run(), "versions").status).toBe("pass");
});

test("detects missing assets and clears once restored", () => {
  const asset = path.join(fixture.dev, "packages/workit-opencode/assets/commands/wk-init.md");
  rmSync(asset, { force: true });
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "assets").status).toBe("fail");
    expect(check(report, "assets").fix).toBeTruthy();
  } finally {
    writeConfig(asset, "# wk-init\n");
  }
  expect(check(run(), "assets").status).toBe("pass");
});

test("detects a missing cursor launcher and clears once restored", () => {
  const removed = [
    path.join(fixture.pluginDir, "dist/mcp-server.js"),
    path.join(fixture.pluginDir, "dist/cursor-session-start.js"),
  ];
  for (const p of removed) rmSync(p, { force: true });
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "launcher").status).toBe("fail");
    expect(check(report, "launcher").fix).toBeTruthy();
  } finally {
    for (const p of removed) writeConfig(p, "#!/usr/bin/env node\n// bundle\n");
  }
  expect(check(run(), "launcher").status).toBe("pass");
});

test("cursor launcher checks use the installed registered runtime", () => {
  const launcher = path.join(fixture.pluginDir, "dist", "mcp-server.js");
  rmSync(launcher, { force: true });
  try {
    for (const host of ["cursor", "cli"] as const) {
      const report = runDoctor({
        host,
        home: fixture.home,
        configDir: fixture.configDir,
        stateDir: fixture.stateDir,
        dev: fixture.dev,
        cwd: fixture.cwd,
        cursorPluginDir: fixture.pluginDir,
      });
      expect(check(report, "launcher").status, host).toBe("fail");
      expect(check(report, "launcher").detail, host).toContain(launcher);
    }
  } finally {
    writeConfig(launcher, "#!/usr/bin/env node\n// installed bundle\n");
  }
});

test("cursor launcher rejects empty or non-Node installed dist entries", () => {
  const entries = ["mcp-server.js", "cursor-session-start.js"];
  for (const entry of entries) {
    const installed = path.join(fixture.pluginDir, "dist", entry);
    for (const invalid of ["", "console.log('not a Node launcher');\n"]) {
      writeConfig(installed, invalid);
      try {
        for (const host of ["cursor", "cli"] as const) {
          const report = runDoctor({
            host,
            home: fixture.home,
            configDir: fixture.configDir,
            stateDir: fixture.stateDir,
            dev: fixture.dev,
            cwd: fixture.cwd,
            cursorPluginDir: fixture.pluginDir,
          });
          const launcher = check(report, "launcher");
          expect(launcher.status, `${host}/${entry}/${JSON.stringify(invalid)}`).toBe("fail");
          expect(launcher.detail).toContain(installed);
          expect(launcher.fix).toContain("Rebuild");
        }
      } finally {
        writeConfig(installed, "#!/usr/bin/env node\n// bundle\n");
      }
    }
  }
});

test("cursor launcher rejects shebang-valid JavaScript syntax errors without executing them", () => {
  const marker = path.join(fixture.root, "must-not-execute");
  const installed = path.join(fixture.pluginDir, "dist", "mcp-server.js");
  writeConfig(
    installed,
    `#!/usr/bin/env node\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nconst broken = ;\n`,
  );
  try {
    for (const host of ["cursor", "cli"] as const) {
      const report = runDoctor({
        host,
        home: fixture.home,
        configDir: fixture.configDir,
        stateDir: fixture.stateDir,
        dev: fixture.dev,
        cwd: fixture.cwd,
        cursorPluginDir: fixture.pluginDir,
      });
      expect(check(report, "launcher").status, host).toBe("fail");
      expect(check(report, "launcher").detail, host).toContain(installed);
    }
    expect(existsSync(marker)).toBe(false);
  } finally {
    writeConfig(installed, "#!/usr/bin/env node\n// bundle\n");
  }
});

test("cursor launcher syntax validation never executes valid plugin code", () => {
  const marker = path.join(fixture.root, "valid-code-must-not-execute");
  const installed = path.join(fixture.pluginDir, "dist", "mcp-server.js");
  writeConfig(
    installed,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
  );
  try {
    const report = runDoctor({
      host: "cursor",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      dev: fixture.dev,
      cwd: fixture.cwd,
      cursorPluginDir: fixture.pluginDir,
    });
    expect(check(report, "launcher").status).toBe("pass");
    expect(existsSync(marker)).toBe(false);
  } finally {
    writeConfig(installed, "#!/usr/bin/env node\n// bundle\n");
  }
});

test("cursor launcher validates the canonical registered MCP target", () => {
  const registered = path.join(fixture.root, "registered", "workit-server.js");
  writeConfig(registered, "#!/usr/bin/env node\nconst broken = ;\n");
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({ mcpServers: { workit: { command: "node", args: [registered] } } }),
  );
  try {
    for (const host of ["cursor", "cli"] as const) {
      const report = runDoctor({
        host,
        home: fixture.home,
        configDir: fixture.configDir,
        stateDir: fixture.stateDir,
        dev: fixture.dev,
        cwd: fixture.cwd,
        cursorPluginDir: fixture.pluginDir,
      });
      expect(check(report, "launcher").status, host).toBe("fail");
      expect(check(report, "launcher").detail, host).toContain(registered);
    }
  } finally {
    writeConfig(
      fixture.cursorMcp,
      JSON.stringify({
        mcpServers: {
          workit: {
            command: "node",
            args: [path.join(fixture.pluginDir, "dist", "mcp-server.js")],
          },
        },
      }),
    );
  }
});

test("detects an unavailable runtime (no node/bun on PATH) and clears with a full PATH", () => {
  const emptyBin = path.join(fixture.root, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const report = run({ env: { ...process.env, PATH: emptyBin } });
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "runtime").status).toBe("fail");
  expect(check(report, "runtime").fix).toBeTruthy();

  expect(check(run(), "runtime").status).toBe("pass");
});

test(
  "detects a missing utility (git absent) and warns when flock is absent",
  () => {
    const bin = binDirWithRuntimes(fixture.root);
    const report = run({ env: { ...process.env, PATH: bin } });
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "utility").status).toBe("fail");
    expect(check(report, "utility").fix).toBeTruthy();

    const full = run();
    expect(check(full, "utility").status).not.toBe("fail");
    // binDirWithRuntimes copies node+bun on win32 (no symlinks); the copy of
    // both runtimes can exceed the default 5s per-test budget.
  },
  { timeout: 60_000 },
);

test("detects duplicate opencode registration and clears once deduplicated", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: [
        "workflow-toolkit-opencode@git+file:///legacy",
        `file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`,
      ],
    }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "duplicate_registration").status).toBe("fail");
  expect(check(report, "duplicate_registration").fix).toBeTruthy();

  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
  );
  expect(check(run(), "duplicate_registration").status).toBe("pass");
});

test("detects duplicate cursor registration in settings and mcp and clears once deduplicated", () => {
  writeConfig(
    fixture.cursorSettings,
    JSON.stringify({
      enabled_plugins: { workit: true, "workflow-toolkit": true },
      plugin_dirs: [
        fixture.pluginDir,
        path.join(fixture.home, ".cursor", "plugins", "local", "workflow-toolkit"),
      ],
    }),
  );
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({
      mcpServers: {
        workit: { command: "node", args: [path.join(fixture.pluginDir, "dist/mcp-server.js")] },
        "workflow-toolkit": { command: "node", args: ["legacy.js"] },
      },
    }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "duplicate_registration").status).toBe("fail");
  expect(check(report, "duplicate_registration").fix).toBeTruthy();

  writeConfig(
    fixture.cursorSettings,
    JSON.stringify({
      enabled_plugins: { workit: true },
      plugin_dirs: [fixture.pluginDir],
    }),
  );
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({
      mcpServers: {
        workit: { command: "node", args: [path.join(fixture.pluginDir, "dist/mcp-server.js")] },
      },
    }),
  );
  expect(check(run(), "duplicate_registration").status).toBe("pass");
});

test("detects malformed config files and clears once repaired", () => {
  writeConfig(path.join(fixture.configDir, "config.json"), "{not valid json");
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "malformed_config").status).toBe("fail");
    expect(check(report, "malformed_config").fix).toBeTruthy();
  } finally {
    rmSync(path.join(fixture.configDir, "config.json"), { force: true });
  }
  expect(check(run(), "malformed_config").status).toBe("pass");
});

test("AR-07: non-object config shapes are flagged malformed, never healthy", () => {
  const configFile = path.join(fixture.configDir, "config.json");
  for (const content of ["null", '"just a string"', "42", "[]", "[1, 2, 3]"]) {
    writeConfig(configFile, content);
    const report = run();
    expect(check(report, "malformed_config").status, content).toBe("fail");
    expect(check(report, "malformed_config").detail, content).toContain("config.json");
  }
  rmSync(configFile, { force: true });
  expect(check(run(), "malformed_config").status).toBe("pass");
});

test("AR-07: doctor agrees with the readers on malformed shapes", () => {
  const vcsFile = path.join(fixture.configDir, "vcs.json");
  const wsFile = path.join(fixture.configDir, "workspaces.json");
  const prev = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = fixture.configDir;
  try {
    for (const content of ["null", "42"]) {
      writeConfig(vcsFile, content);
      expect(check(run(), "malformed_config").status, content).toBe("fail");
      expect(readVcsConfig().status).toBe("malformed");
      expect(readVcsConfig().error).toContain(vcsFile);
      expect(readSetupState(fixture.configDir).vcs.status).toBe("malformed");

      writeConfig(wsFile, content);
      expect(readWorkspacesResult(fixture.configDir).status).toBe("malformed");
      expect(readWorkspacesResult(fixture.configDir).error).toContain(wsFile);
      expect(readSetupState(fixture.configDir).workspaces.status).toBe("malformed");
    }
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = prev;
    rmSync(vcsFile, { force: true });
    rmSync(wsFile, { force: true });
  }
  expect(check(run(), "malformed_config").status).toBe("pass");
});

test("AR-07: doctor agrees with the readers on malformed youtrack.json shapes", () => {
  const ytFile = path.join(fixture.configDir, "youtrack.json");
  try {
    for (const content of ["null", "42"]) {
      writeConfig(ytFile, content);
      expect(check(run(), "malformed_config").status, content).toBe("fail");
      expect(check(run(), "malformed_config").detail, content).toContain("youtrack.json");
      expect(readSetupState(fixture.configDir).youtrack.status, content).toBe("malformed");
      expect(readSetupState(fixture.configDir).youtrack.error, content).toContain(ytFile);
    }
  } finally {
    rmSync(ytFile, { force: true });
  }
  expect(check(run(), "malformed_config").status).toBe("pass");
});

test("detects a workspace mismatch and clears once the glob matches", () => {
  const workspacesFile = path.join(fixture.configDir, "workspaces.json");
  writeConfig(
    workspacesFile,
    JSON.stringify({ workspaces: [{ name: "other", glob: `${fixture.root}/elsewhere/**` }] }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "workspace_mismatch").status).toBe("fail");
  expect(check(report, "workspace_mismatch").fix).toBeTruthy();

  writeConfig(
    workspacesFile,
    JSON.stringify({ workspaces: [{ name: "current", glob: `${fixture.cwd}/**` }] }),
  );
  expect(check(run(), "workspace_mismatch").status).toBe("pass");
});

test("credential metadata flags missing/unsafe-mode/placeholder token files", () => {
  const youtrackJson = path.join(fixture.configDir, "youtrack.json");
  const tokenFile = path.join(fixture.configDir, "youtrack.token");
  writeConfig(youtrackJson, JSON.stringify({ tokenFile }));
  rmSync(tokenFile, { force: true });
  const missing = run();
  expect(check(missing, "credential_metadata").status).toBe("fail");

  writeConfig(tokenFile, "sk-live-11\n", 0o600);
  writeConfig(youtrackJson, JSON.stringify({ tokenFile }));
  const okRun = run();
  expect(check(okRun, "credential_metadata").status).toBe("pass");
  // the token value never leaves the engine
  expect(JSON.stringify(okRun)).not.toContain("sk-live-11");

  writeConfig(tokenFile, "YOUR_TOKEN_HERE\n", 0o600);
  const placeholder = run();
  expect(check(placeholder, "credential_metadata").status).toBe("fail");
  expect(JSON.stringify(placeholder)).not.toContain("YOUR_TOKEN_HERE");

  rmSync(youtrackJson, { force: true });
  rmSync(tokenFile, { force: true });
});

test("credential metadata only flags providers actually configured in vcs.json", () => {
  const vcsFile = path.join(fixture.configDir, "vcs.json");
  const gitlabToken = path.join(fixture.configDir, "gitlab.token");
  writeConfig(vcsFile, JSON.stringify({ gitlab: { tokenFile: "gitlab.token" } }));
  writeConfig(gitlabToken, "glpat-ok-11\n", 0o600);
  try {
    expect(check(run(), "credential_metadata").status).toBe("pass");
  } finally {
    rmSync(vcsFile, { force: true });
    rmSync(gitlabToken, { force: true });
  }
  expect(check(run(), "credential_metadata").status).toBe("pass");
});

test("detects unwritable log dir and clears once writable", () => {
  const logsBlocker = path.join(fixture.stateDir, "logs");
  rmSync(logsBlocker, { recursive: true, force: true });
  writeConfig(logsBlocker, "a file where the logs dir should be");
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "log_writable").status).toBe("fail");
    expect(check(report, "log_writable").fix).toBeTruthy();
  } finally {
    rmSync(logsBlocker, { force: true });
  }
  expect(check(run(), "log_writable").status).toBe("pass");
});

test("log writability probe leaves no stray file behind", () => {
  const logsDir = path.join(fixture.stateDir, "logs");
  writeConfig(path.join(logsDir, "doctor-probe.tmp"), '{"probe":true}\n');
  const report = run();
  expect(check(report, "log_writable").status).toBe("pass");
  expect(readdirSync(logsDir).filter((f) => f.startsWith("doctor-probe"))).toEqual([]);
});

test("no network code path runs: the report marks offline and never spawns network tools", () => {
  const report = run();
  expect(report.offline).toBe(true);
  expect(report).not.toHaveProperty("network");
});

// Installer-health fixtures (AR-11/CA-40): removing any required selected-host
// surface must fail the installer run with a specific fix, never a warning.
// Each removal maps to its own typed check/fix.
const expectInstallerFailure = (id: string, fixKeyword: string) => {
  const report = runInstaller();
  expect(report.ok, JSON.stringify(report.checks)).toBe(false);
  expect(report.exitCode).toBe(1);
  const check = report.checks.find((c) => c.id === id)!;
  expect(check.status).toBe("fail");
  expect(check.fix).toBeTruthy();
  expect(check.fix, id).toContain(fixKeyword);
  expect(report.fixes.some((f) => f.id === id)).toBe(true);
};

test("installer fails when a selected-host asset is missing", () => {
  const asset = path.join(fixture.dev, "packages/workit-opencode/assets/commands/wk-init.md");
  rmSync(asset, { force: true });
  try {
    expectInstallerFailure("assets", "Reinstall or rebuild");
  } finally {
    writeConfig(asset, "# wk-init\n");
  }
  expect(check(runInstaller(), "assets").status).toBe("pass");
});

test("installer fails when a selected-host launcher entry is missing", () => {
  const removed = [
    path.join(fixture.pluginDir, "dist/mcp-server.js"),
    path.join(fixture.pluginDir, "dist/cursor-session-start.js"),
  ];
  for (const p of removed) rmSync(p, { force: true });
  try {
    expectInstallerFailure("launcher", "Rebuild and reinstall");
  } finally {
    for (const p of removed) writeConfig(p, "#!/usr/bin/env node\n// bundle\n");
  }
  expect(check(runInstaller(), "launcher").status).toBe("pass");
});

test("installer fails when the runtime is unavailable", () => {
  const emptyBin = path.join(fixture.root, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  const report = runInstaller({ env: { ...process.env, PATH: emptyBin } });
  expect(report.ok).toBe(false);
  expect(report.exitCode).toBe(1);
  expect(check(report, "runtime").status).toBe("fail");
  expect(check(report, "runtime").fix).toContain("Install Node");
});

test(
  "installer fails when a required utility (git) is missing",
  () => {
    const bin = binDirWithRuntimes(fixture.root);
    const report = runInstaller({ env: { ...process.env, PATH: bin } });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(check(report, "utility").status).toBe("fail");
    expect(check(report, "utility").fix).toContain("Install git");
    // binDirWithRuntimes copies node+bun on win32 (no symlinks); the copy of
    // both runtimes can exceed the default 5s per-test budget.
  },
  { timeout: 60_000 },
);

test("installer fails on a broken selected-host registration", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["workit-opencode@git+file:///nonexistent/stale"] }),
  );
  try {
    expectInstallerFailure("stale_pin", "install-opencode-plugin.sh");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
  expect(check(runInstaller(), "stale_pin").status).toBe("pass");
});

test("installer fails on malformed config", () => {
  const configFile = path.join(fixture.configDir, "config.json");
  writeConfig(configFile, "{not valid json");
  try {
    expectInstallerFailure("malformed_config", "Repair the malformed config");
  } finally {
    rmSync(configFile, { force: true });
  }
  expect(check(runInstaller(), "malformed_config").status).toBe("pass");
});

test("installer downgrades optional parity checks to warnings, not failures", () => {
  const opencodePkg = path.join(fixture.dev, "packages/workit-opencode/package.json");
  const original = JSON.parse(readFileSync(opencodePkg, "utf8"));
  try {
    writeConfig(
      opencodePkg,
      JSON.stringify({
        ...original,
        dependencies: { ...original.dependencies, "@brainervirus/workit-core": "^0.3.0" },
      }),
    );
    const report = runInstaller();
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(check(report, "versions").status).toBe("warn");
  } finally {
    writeConfig(opencodePkg, JSON.stringify(original));
  }
  expect(check(runInstaller(), "versions").status).toBe("pass");
});

test(
  "AR-14: negative fixtures never leak raw git usage/fatal dumps into the suite output",
  () => {
    const noisy = [
      "test/workit-core/handoff.test.ts",
      "test/workit-core/sdd.test.ts",
      "test/workit-core/repo.test.ts",
    ];
    const r = spawnSync("bun", ["test", ...noisy], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 300_000,
    });
    expect(r.status, r.stderr.slice(0, 2000)).toBe(0);
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(output).not.toMatch(/usage: git diff/);
    expect(output).not.toMatch(/fatal: /);
  },
  { timeout: 300_000 },
);
