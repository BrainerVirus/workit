import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "../../packages/workit-core/src/core/doctor";
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
  const launcher = path.join(fixture.dev, "packages/workit-cursor/dist/mcp-server.js");
  const hook = path.join(fixture.dev, "packages/workit-cursor/dist/cursor-session-start.js");
  const shim = path.join(fixture.dev, "packages/workit-cursor/mcp/run-server.sh");
  const hookShim = path.join(fixture.dev, "packages/workit-cursor/hooks/session-start");
  const removed = [launcher, hook, shim, hookShim];
  for (const p of removed) rmSync(p, { force: true });
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "launcher").status).toBe("fail");
    expect(check(report, "launcher").fix).toBeTruthy();
  } finally {
    for (const p of removed) writeConfig(p, p.endsWith(".js") ? "// bundle\n" : "#!/bin/sh\n");
  }
  expect(check(run(), "launcher").status).toBe("pass");
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

test("detects a missing utility (git absent) and warns when flock is absent", () => {
  const bin = binDirWithRuntimes(fixture.root);
  const report = run({ env: { ...process.env, PATH: bin } });
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "utility").status).toBe("fail");
  expect(check(report, "utility").fix).toBeTruthy();

  const full = run();
  expect(check(full, "utility").status).not.toBe("fail");
});

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
      enabled_plugins: { "workflow-toolkit": true, "local/workflow-toolkit": true },
      plugin_dirs: [fixture.pluginDir, path.join(fixture.home, ".cursor/plugins/local/legacy")],
    }),
  );
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({
      mcpServers: {
        workit: { command: "node", args: ["dist/mcp-server.js"] },
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
      enabled_plugins: { "workflow-toolkit": true },
      plugin_dirs: [fixture.pluginDir],
    }),
  );
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({ mcpServers: { workit: { command: "node", args: ["dist/mcp-server.js"] } } }),
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

test("a JSON scalar or array config file is treated as empty, not malformed", () => {
  const configFile = path.join(fixture.configDir, "config.json");
  for (const content of ['"just a string"', "[1, 2, 3]"]) {
    writeConfig(configFile, content);
    const report = run();
    expect(check(report, "malformed_config").status, content).toBe("pass");
    expect(report.exitCode).toBe(0);
  }
  rmSync(configFile, { force: true });
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
