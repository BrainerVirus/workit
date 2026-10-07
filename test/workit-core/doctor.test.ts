import { afterAll, expect, test } from "bun:test";
import { SLOW_TEST_TIMEOUT_MS } from "@/test/shared/helpers/packages";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkGithubIdentity,
  checkGitLabIdentity,
  githubHostFromRemote,
  githubIdentityFinding,
  gitlabIdentityFinding,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "@/packages/workit-cli/src/admin/doctor";
import { OPENCODE_NPM_PIN } from "@/packages/workit-cli/src/admin/registration";
import { SUPPORT_MATRIX } from "@/packages/workit-core/src/core/support-matrix";
import { readVcsConfig } from "@/packages/workit-core/src/core/vcs-config";
import { readSetupState } from "@/packages/workit-cli/src/admin/setup-state";
import { readWorkspacesResult } from "@/packages/workit-core/src/core/workspaces";
import { binDirWithRuntimes, makeDoctorFixture } from "@/test/shared/helpers/doctor-fixture";

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

const repoRoot = path.resolve(import.meta.dir, "..", "..");

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

test("reports stale_install when a local-dist install is behind the current runtime", () => {
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const originalHooks = readFileSync(hooksFile, "utf8");
  writeConfig(
    pluginPkg,
    JSON.stringify({
      name: "@brainervirus/workit-cursor",
      version: "0.3.0",
      dependencies: { "@brainervirus/workit-core": "workspace:*" },
    }),
  );
  // A local-dist install (node hook, no mcp.json selector) runs the installed
  // dir's own dist, so its version is compared against the current runtime.
  rmSync(path.join(fixture.pluginDir, "mcp.json"), { force: true });
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: `node ${path.join(fixture.pluginDir, "dist", "cursor-session-start.js")}`,
          },
        ],
      },
    }),
  );
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("0.3.0");
    expect(stale.fix).toBeTruthy();
  } finally {
    rmSync(pluginPkg, { force: true });
    writeConfig(hooksFile, originalHooks);
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("reports stale_install for a legacy exact npx pin in the plugin mcp.json", () => {
  const legacyMcp = path.join(fixture.pluginDir, "mcp.json");
  writeConfig(
    legacyMcp,
    JSON.stringify({
      mcpServers: {
        workit: {
          command: "npx",
          args: [
            "-y",
            "--prefer-online",
            "--package=@brainervirus/workit-cursor@0.8.5",
            "workit-cursor-mcp",
            "${workspaceFolder}",
          ],
        },
      },
    }),
  );
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("0.8.5");
    expect(stale.fix).toBeTruthy();
  } finally {
    rmSync(legacyMcp, { force: true });
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("healthy fixture: canonical install yields no stale_install finding", () => {
  const report = run();
  const stale = check(report, "stale_install");
  expect(stale.status).toBe("pass");
  expect(stale.detail).not.toMatch(/stale/i);
});

test("reports stale_install when a same-version local-dist install runs different bytes", () => {
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const hookBundle = path.join(fixture.pluginDir, "dist", "cursor-session-start.js");
  const devBundle = path.join(
    fixture.dev,
    "packages",
    "workit-cursor",
    "dist",
    "cursor-session-start.js",
  );
  const originalHooks = readFileSync(hooksFile, "utf8");
  const originalHookBundle = readFileSync(hookBundle, "utf8");
  const originalDevBundle = readFileSync(devBundle, "utf8");
  // Same version both sides: version strings cannot see the difference, the
  // bundle hash can.
  writeConfig(
    pluginPkg,
    JSON.stringify({
      name: "@brainervirus/workit-cursor",
      version: "1.0.0",
      dependencies: { "@brainervirus/workit-core": "workspace:*" },
    }),
  );
  rmSync(path.join(fixture.pluginDir, "mcp.json"), { force: true });
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: `node ${hookBundle}` }] },
    }),
  );
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toMatch(/different bytes|hash mismatch/);
    // Byte-identical install heals without touching versions.
    writeConfig(hookBundle, originalDevBundle);
    const healed = run({
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.0" },
    });
    expect(check(healed, "stale_install").status).toBe("pass");
  } finally {
    rmSync(pluginPkg, { force: true });
    writeConfig(hooksFile, originalHooks);
    writeConfig(hookBundle, originalHookBundle);
    writeConfig(devBundle, originalDevBundle);
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("reports stale_install when the cursor plugin dir is a symlink into a package cache", () => {
  const cachePkg = path.join(fixture.root, "Library", "Caches", "pnpm", "dlx", "abc", "pkg");
  mkdirSync(cachePkg, { recursive: true });
  writeFileSync(path.join(cachePkg, "package.json"), JSON.stringify({ version: "1.0.3" }));
  const backup = `${fixture.pluginDir}.bak-real`;
  rmSync(backup, { recursive: true, force: true });
  renameSync(fixture.pluginDir, backup);
  try {
    symlinkSync(cachePkg, fixture.pluginDir);
    const stale = check(run(), "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toMatch(/symlink.*cache/i);
  } finally {
    rmSync(fixture.pluginDir, { force: true });
    renameSync(backup, fixture.pluginDir);
  }
});

test("reports stale_install when the installed preToolUse matcher drifts from canonical", () => {
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const originalHooks = readFileSync(hooksFile, "utf8");
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command:
              "npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
          },
        ],
        preToolUse: [
          {
            command:
              "npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest workit-cursor-hook",
            matcher: "Write|Edit|Delete|Shell",
            failClosed: true,
          },
        ],
      },
    }),
  );
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("preToolUse");
    expect(stale.fix).toBeTruthy();
  } finally {
    writeConfig(hooksFile, originalHooks);
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("canonical @latest install with an old plugin package.json version is not stale", () => {
  // CA-01/CA-04: a canonical `@latest` install resolves fresh at launch, so the
  // installed package.json version is metadata — never a `stale_install` fail.
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  writeConfig(pluginPkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "0.0.1" }));
  try {
    const report = run();
    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("pass");
    expect(stale.detail).not.toMatch(/stale/i);
  } finally {
    rmSync(pluginPkg, { force: true });
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("offline flag reflects the registry probe: false for local-dist installs, true otherwise", () => {
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const hookBundle = path.join(fixture.pluginDir, "dist", "cursor-session-start.js");
  const devBundle = path.join(
    fixture.dev,
    "packages",
    "workit-cursor",
    "dist",
    "cursor-session-start.js",
  );
  const originalHooks = readFileSync(hooksFile, "utf8");
  const originalHookBundle = readFileSync(hookBundle, "utf8");
  const originalDevBundle = readFileSync(devBundle, "utf8");
  // Same version means same bytes: the bundle-hash check compares content.
  // The synced bytes keep a valid node launcher entry (shebang + syntax).
  writeConfig(hookBundle, "#!/usr/bin/env node\n// bundle\n");
  writeConfig(devBundle, "#!/usr/bin/env node\n// bundle\n");
  writeConfig(pluginPkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "1.0.0" }));
  rmSync(path.join(fixture.pluginDir, "mcp.json"), { force: true });
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: `node ${path.join(fixture.pluginDir, "dist", "cursor-session-start.js")}`,
          },
        ],
      },
    }),
  );
  try {
    const report = runDoctor({
      host: "cli",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      dev: fixture.dev,
      cwd: fixture.cwd,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.0" },
    });
    expect(report.offline).toBe(false);
    expect(check(report, "stale_install").status).toBe("pass");
  } finally {
    rmSync(pluginPkg, { force: true });
    writeConfig(hooksFile, originalHooks);
    writeConfig(hookBundle, originalHookBundle);
    writeConfig(devBundle, originalDevBundle);
  }
  expect(run().offline).toBe(true);
});

test("local-dist install behind the published runtime is stale_install fail when the probe succeeds", () => {
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const originalHooks = readFileSync(hooksFile, "utf8");
  writeConfig(pluginPkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "0.4.0" }));
  // A local-dist install (node hook, no mcp.json selector) is the only shape
  // that consults the registry; the version seam keeps the probe spawn-free.
  rmSync(path.join(fixture.pluginDir, "mcp.json"), { force: true });
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: `node ${path.join(fixture.pluginDir, "dist", "cursor-session-start.js")}`,
          },
        ],
      },
    }),
  );
  try {
    const report = runDoctor({
      host: "cli",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      dev: fixture.dev,
      cwd: fixture.cwd,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.0" },
    });
    expect(report.exitCode).not.toBe(0);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("0.4.0");
    expect(stale.detail).toContain("1.0.0");
    expect(stale.fix).toBeTruthy();
  } finally {
    rmSync(pluginPkg, { force: true });
    writeConfig(hooksFile, originalHooks);
  }
  expect(check(run(), "stale_install").status).toBe("pass");
});

test("registry-unreachable staleness comparison yields registry_unreachable, not stale_install", () => {
  const pluginPkg = path.join(fixture.pluginDir, "package.json");
  const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
  const hookBundle = path.join(fixture.pluginDir, "dist", "cursor-session-start.js");
  const devBundle = path.join(
    fixture.dev,
    "packages",
    "workit-cursor",
    "dist",
    "cursor-session-start.js",
  );
  const originalHooks = readFileSync(hooksFile, "utf8");
  const originalHookBundle = readFileSync(hookBundle, "utf8");
  const originalDevBundle = readFileSync(devBundle, "utf8");
  // Same version means same bytes: the bundle-hash check compares content.
  // The synced bytes keep a valid node launcher entry (shebang + syntax).
  writeConfig(hookBundle, "#!/usr/bin/env node\n// bundle\n");
  writeConfig(devBundle, "#!/usr/bin/env node\n// bundle\n");
  writeConfig(pluginPkg, JSON.stringify({ name: "@brainervirus/workit-cursor", version: "1.0.0" }));
  rmSync(path.join(fixture.pluginDir, "mcp.json"), { force: true });
  writeConfig(
    hooksFile,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: `node ${path.join(fixture.pluginDir, "dist", "cursor-session-start.js")}`,
          },
        ],
      },
    }),
  );
  const report = runDoctor({
    host: "cli",
    home: fixture.home,
    configDir: fixture.configDir,
    stateDir: fixture.stateDir,
    dev: fixture.dev,
    cwd: fixture.cwd,
    env: {
      ...process.env,
      WORKIT_DOCTOR_STALE_REGISTRY_CMD: path.join(fixture.root, "no-registry-bin", "npm-fail"),
    },
  });
  try {
    const stale = check(report, "registry_unreachable");
    expect(stale.status).toBe("warn");
    expect(stale.detail).toContain("registry_unreachable");
    expect(stale.fix).toBeTruthy();
    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.id === "stale_install" && c.status === "fail")).toBe(false);
  } finally {
    rmSync(pluginPkg, { force: true });
    writeConfig(hooksFile, originalHooks);
    writeConfig(hookBundle, originalHookBundle);
    writeConfig(devBundle, originalDevBundle);
  }
});

test("opencode @latest cache behind published runtime is stale_install fail", () => {
  const cacheRoot = path.join(
    fixture.home,
    ".cache",
    "opencode",
    "packages",
    "@brainervirus",
    "workit-opencode@latest",
  );
  const pkgDir = path.join(cacheRoot, "node_modules", "@brainervirus", "workit-opencode");
  mkdirSync(pkgDir, { recursive: true });
  writeConfig(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: OPENCODE_NPM_PIN, version: "0.11.0" }),
  );
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [OPENCODE_NPM_PIN] }));
  try {
    const report = runDoctor({
      host: "opencode",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      cwd: fixture.cwd,
      opencodePackageCacheDir: cacheRoot,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.4" },
    });
    expect(report.offline).toBe(false);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("0.11.0");
    expect(stale.detail).toContain("1.0.4");
    expect(stale.fix).toContain(cacheRoot);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("opencode @latest cache matching published runtime passes", () => {
  const cacheRoot = path.join(fixture.root, "oc-cache-ok");
  const pkgDir = path.join(cacheRoot, "node_modules", "@brainervirus", "workit-opencode");
  mkdirSync(pkgDir, { recursive: true });
  writeConfig(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: OPENCODE_NPM_PIN, version: "1.0.4" }),
  );
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [`${OPENCODE_NPM_PIN}@latest`] }));
  try {
    const report = runDoctor({
      host: "opencode",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      cwd: fixture.cwd,
      opencodePackageCacheDir: cacheRoot,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.4" },
    });
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("pass");
    expect(stale.detail).toContain("1.0.4");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("opencode exact version pin skips registry comparison", () => {
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [`${OPENCODE_NPM_PIN}@1.0.4`] }));
  try {
    const report = runDoctor({
      host: "opencode",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      cwd: fixture.cwd,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "9.9.9" },
    });
    expect(report.offline).toBe(true);
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("pass");
    expect(stale.detail).toContain("exact version");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("opencode cache registry-unreachable yields warning, not stale_install", () => {
  const cacheRoot = path.join(fixture.root, "oc-cache-unreachable");
  const pkgDir = path.join(cacheRoot, "node_modules", "@brainervirus", "workit-opencode");
  mkdirSync(pkgDir, { recursive: true });
  writeConfig(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: OPENCODE_NPM_PIN, version: "0.11.0" }),
  );
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [OPENCODE_NPM_PIN] }));
  try {
    const report = runDoctor({
      host: "opencode",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      cwd: fixture.cwd,
      opencodePackageCacheDir: cacheRoot,
      env: {
        ...process.env,
        WORKIT_DOCTOR_STALE_REGISTRY_CMD: path.join(fixture.root, "no-registry-bin", "npm-fail"),
      },
    });
    expect(check(report, "registry_unreachable").status).toBe("warn");
    expect(report.checks.some((c) => c.id === "stale_install" && c.status === "fail")).toBe(false);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("cli host reports OpenCode @latest cache lag after cursor checks pass", () => {
  const cacheRoot = path.join(fixture.root, "oc-cache-cli");
  const pkgDir = path.join(cacheRoot, "node_modules", "@brainervirus", "workit-opencode");
  mkdirSync(pkgDir, { recursive: true });
  writeConfig(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: OPENCODE_NPM_PIN, version: "0.11.0" }),
  );
  writeConfig(fixture.opencodeConfig, JSON.stringify({ plugin: [OPENCODE_NPM_PIN] }));
  try {
    const report = runDoctor({
      host: "cli",
      home: fixture.home,
      configDir: fixture.configDir,
      stateDir: fixture.stateDir,
      dev: fixture.dev,
      cwd: fixture.cwd,
      opencodePackageCacheDir: cacheRoot,
      env: { ...process.env, WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "1.0.4" },
    });
    const stale = check(report, "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("OpenCode @latest cache");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("detects a stale opencode pin and clears once re-pinned", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: ["workit-opencode@git+file:///nonexistent/stale"],
    }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "stale_pin").status).toBe("fail");
  expect(check(report, "stale_pin").fix).toBeTruthy();

  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
    }),
  );
  expect(check(run(), "stale_pin").status).toBe("pass");
});

test("detects a stale git+file workit pin and clears once re-pinned", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: ["workflow-toolkit-opencode@git+file:///legacy"],
    }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  const stale = check(report, "stale_pin");
  expect(stale.status).toBe("fail");
  expect(stale.detail).toContain("stale workit pin");
  expect(stale.fix).toBeTruthy();

  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
    }),
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
    JSON.stringify({
      plugin: `file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`,
    }),
  );
  try {
    expect(check(run(), "stale_pin").status).toBe("pass");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({
        plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
      }),
    );
  }
});

test("cursor host never inspects the opencode config for stale pins", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: ["workflow-toolkit-opencode@git+file:///legacy"],
    }),
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
      JSON.stringify({
        plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
      }),
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
        dependencies: {
          ...original.dependencies,
          "@brainervirus/workit-core": "^0.3.0",
        },
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
        dependencies: {
          ...original.dependencies,
          "@opencode/plugin": "0.9.0",
        },
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
  const asset = path.join(
    fixture.dev,
    "packages/workit-opencode/assets/skills/workit-shape/SKILL.md",
  );
  rmSync(asset, { force: true });
  try {
    const report = run();
    expect(report.exitCode).not.toBe(0);
    expect(check(report, "assets").status).toBe("fail");
    expect(check(report, "assets").fix).toBeTruthy();
  } finally {
    writeConfig(asset, "# workit-shape\n");
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

test(
  "cursor launcher rejects empty or non-Node installed dist entries",
  () => {
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
  },
  SLOW_TEST_TIMEOUT_MS,
);

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
  // The real installed plugin ships package.json with type:module; without
  // it node --check parses the ESM dist as CJS and the precondition is void.
  writeConfig(
    path.join(fixture.pluginDir, "package.json"),
    JSON.stringify({ name: "@brainervirus/workit-cursor", version: "1.0.0", type: "module" }),
  );
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
    rmSync(path.join(fixture.pluginDir, "package.json"), { force: true });
    writeConfig(installed, "#!/usr/bin/env node\n// bundle\n");
  }
});

test("cursor launcher validates the canonical registered MCP target", () => {
  const registered = path.join(fixture.root, "registered", "workit-server.js");
  writeConfig(registered, "#!/usr/bin/env node\nconst broken = ;\n");
  writeConfig(
    fixture.cursorMcp,
    JSON.stringify({
      mcpServers: { workit: { command: "node", args: [registered] } },
    }),
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

test(
  "cursor launcher npx shape matches exact tokens, never substrings (CA-17)",
  () => {
    const canonical = JSON.stringify({
      mcpServers: {
        workit: {
          command: "npx",
          args: [
            "-y",
            "--prefer-online",
            "--min-release-age=0",
            "--package=@brainervirus/workit-cursor@latest",
            "workit-cursor-mcp",
            "${workspaceFolder}",
          ],
        },
      },
    });
    const variants: Array<[string, string[]]> = [
      [
        "exact pin @0.8.5",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@0.8.5",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
      [
        "bare @latest without --prefer-online",
        [
          "-y",
          "--package=@brainervirus/workit-cursor@latest",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
      [
        "@latest-alpha",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@latest-alpha",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
      [
        "@0.8.5-alpha",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@0.8.5-alpha",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
      [
        "@0.8.50",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@0.8.50",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
      [
        "missing ${workspaceFolder}",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@latest",
          "workit-cursor-mcp",
        ],
      ],
      [
        "extra args",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@latest",
          "workit-cursor-mcp",
          "${workspaceFolder}",
          "extra",
        ],
      ],
      [
        "executable lookalike",
        [
          "-y",
          "--prefer-online",
          "--package=@brainervirus/workit-cursor@latest",
          "workit-cursor-mcp-foo",
          "${workspaceFolder}",
        ],
      ],
      [
        "wrong position: --prefer-online after --package",
        [
          "-y",
          "--package=@brainervirus/workit-cursor@latest",
          "--prefer-online",
          "workit-cursor-mcp",
          "${workspaceFolder}",
        ],
      ],
    ];
    try {
      for (const [label, args] of variants) {
        writeConfig(
          fixture.cursorMcp,
          JSON.stringify({ mcpServers: { workit: { command: "npx", args } } }),
        );
        const report = run();
        expect(check(report, "launcher").status, label).toBe("fail");
        expect(check(report, "launcher").detail, label).toContain("canonical");
      }
    } finally {
      writeConfig(fixture.cursorMcp, canonical);
    }
    expect(check(run(), "launcher").status).toBe("pass");
  },
  SLOW_TEST_TIMEOUT_MS,
);

test(
  "cursor session-start hook command matches exact canonical string (CA-17)",
  () => {
    const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
    const canonical = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            command:
              "npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
          },
        ],
      },
    };
    const hookVariants: Array<[string, string]> = [
      [
        "exact pin @0.8.5",
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@0.8.5 workit-cursor-session-start",
      ],
      [
        "bare @latest without --prefer-online",
        "npx -y --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
      ],
      [
        "@latest-alpha",
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest-alpha workit-cursor-session-start",
      ],
      [
        "@0.8.5-alpha",
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@0.8.5-alpha workit-cursor-session-start",
      ],
      [
        "@0.8.50",
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@0.8.50 workit-cursor-session-start",
      ],
      [
        "extra-token",
        "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start extra",
      ],
      ["missing-executable", "npx -y --prefer-online --package=@brainervirus/workit-cursor@latest"],
    ];
    try {
      for (const [label, command] of hookVariants) {
        writeConfig(
          hooksFile,
          JSON.stringify({ version: 1, hooks: { sessionStart: [{ command }] } }),
        );
        const report = run();
        expect(check(report, "launcher").status, label).toBe("fail");
        expect(check(report, "launcher").detail, label).toContain("canonical");
        expect(check(report, "launcher").detail, label).toContain("hooks-cursor.json");
      }
    } finally {
      writeConfig(hooksFile, JSON.stringify(canonical));
    }
    expect(check(run(), "launcher").status).toBe("pass");
  },
  SLOW_TEST_TIMEOUT_MS,
);

test(
  "accepts a local-dist node session-start hook pointing at the installed dist (CA-17)",
  () => {
    const hooksFile = path.join(fixture.pluginDir, "hooks", "hooks-cursor.json");
    const distHook = `node ${path.join(fixture.pluginDir, "dist", "cursor-session-start.js")}`;
    const write = (command: string) =>
      writeConfig(
        hooksFile,
        JSON.stringify({ version: 1, hooks: { sessionStart: [{ command }] } }),
      );
    try {
      write(distHook);
      expect(check(run(), "launcher").status, "local dist").toBe("pass");
      // The node form must point at the plugin's own valid dist entry: an
      // unrelated node command or a missing dist file stays a failure.
      write("node /elsewhere/cursor-session-start.js");
      expect(check(run(), "launcher").status).toBe("fail");
      write(`node ${path.join(fixture.pluginDir, "dist", "missing.js")}`);
      expect(check(run(), "launcher").status).toBe("fail");
      write(
        "npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
      );
      expect(check(run(), "launcher").status).toBe("pass");
    } finally {
      writeConfig(
        hooksFile,
        JSON.stringify({
          version: 1,
          hooks: {
            sessionStart: [
              {
                command:
                  "npx -y --prefer-online --min-release-age=0 --package=@brainervirus/workit-cursor@latest workit-cursor-session-start",
              },
            ],
          },
        }),
      );
    }
  },
  SLOW_TEST_TIMEOUT_MS,
);

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
    JSON.stringify({
      plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
    }),
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
        workit: {
          command: "node",
          args: [path.join(fixture.pluginDir, "dist/mcp-server.js")],
        },
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
        workit: {
          command: "node",
          args: [path.join(fixture.pluginDir, "dist/mcp-server.js")],
        },
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

test(
  "AR-07: non-object config shapes are flagged malformed, never healthy",
  () => {
    const configFile = path.join(fixture.configDir, "config.json");
    for (const content of ["null", '"just a string"', "42", "[]", "[1, 2, 3]"]) {
      writeConfig(configFile, content);
      const report = run();
      expect(check(report, "malformed_config").status, content).toBe("fail");
      expect(check(report, "malformed_config").detail, content).toContain("config.json");
    }
    rmSync(configFile, { force: true });
    expect(check(run(), "malformed_config").status).toBe("pass");
  },
  SLOW_TEST_TIMEOUT_MS,
);

test(
  "AR-07: doctor agrees with the readers on malformed shapes",
  () => {
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
  },
  SLOW_TEST_TIMEOUT_MS,
);

test(
  "AR-07: doctor agrees with the readers on malformed youtrack.json shapes",
  () => {
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
  },
  SLOW_TEST_TIMEOUT_MS,
);

test("detects a workspace mismatch and clears once the glob matches", () => {
  const workspacesFile = path.join(fixture.configDir, "workspaces.json");
  writeConfig(
    workspacesFile,
    JSON.stringify({
      workspaces: [{ name: "other", glob: `${fixture.root}/elsewhere/**` }],
    }),
  );
  const report = run();
  expect(report.exitCode).not.toBe(0);
  expect(check(report, "workspace_mismatch").status).toBe("fail");
  expect(check(report, "workspace_mismatch").fix).toBeTruthy();

  writeConfig(
    workspacesFile,
    JSON.stringify({
      workspaces: [{ name: "current", glob: `${fixture.cwd}/**` }],
    }),
  );
  expect(check(run(), "workspace_mismatch").status).toBe("pass");
});

test("doctor surfaces typed workspace errors without throwing through identity checks", () => {
  const workspacesFile = path.join(fixture.configDir, "workspaces.json");
  writeConfig(
    workspacesFile,
    JSON.stringify({
      workspaces: [
        { name: "current", glob: `${fixture.cwd}/**`, branchPolicy: { preset: "not-a-preset" } },
      ],
    }),
  );
  const report = run();
  expect(check(report, "workspace_mismatch").status).toBe("fail");
  expect(check(report, "workspace_mismatch").detail).toContain("unsupported branch preset");
  const identity = checkGithubIdentity(
    { cwd: fixture.cwd, configDir: fixture.configDir, env: {} },
    identityProbes(),
  );
  expect(identity.status).toBe("fail");
  expect(identity.detail).toContain("unsupported branch preset");
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

test("credential metadata ignores inactive VCS provider token files", () => {
  const vcsFile = path.join(fixture.configDir, "vcs.json");
  const githubToken = path.join(fixture.configDir, "github.token");
  writeConfig(
    vcsFile,
    JSON.stringify({
      provider: "github",
      github: { tokenFile: "github.token" },
      gitlab: { tokenFile: "gitlab.token" },
    }),
  );
  writeConfig(githubToken, "ghp-ok-11\n", 0o600);
  // gitlab.token intentionally missing — must not fail when provider is github
  try {
    expect(check(run(), "credential_metadata").status).toBe("pass");
  } finally {
    rmSync(vcsFile, { force: true });
    rmSync(githubToken, { force: true });
  }
});

test("stale_pin fails fragile pnpm dlx file:// pins", () => {
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: [
        "file:///Users/me/Library/Caches/pnpm/dlx/abc/node_modules/@brainervirus/workit-opencode/dist/plugin.js",
      ],
    }),
  );
  const report = run();
  expect(check(report, "stale_pin").status).toBe("fail");
  expect(check(report, "stale_pin").detail).toContain("cache path");
  writeConfig(
    fixture.opencodeConfig,
    JSON.stringify({ plugin: ["@brainervirus/workit-opencode"] }),
  );
  expect(check(run(), "stale_pin").status).toBe("pass");
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
  const failing = report.checks.find((c) => c.id === id)!;
  expect(failing.status).toBe("fail");
  expect(failing.fix).toBeTruthy();
  expect(failing.fix, id).toContain(fixKeyword);
  expect(report.fixes.some((f) => f.id === id)).toBe(true);
};

test("installer fails when a selected-host asset is missing", () => {
  const asset = path.join(
    fixture.dev,
    "packages/workit-opencode/assets/skills/workit-shape/SKILL.md",
  );
  rmSync(asset, { force: true });
  try {
    expectInstallerFailure("assets", "Reinstall or rebuild");
  } finally {
    writeConfig(asset, "# workit-shape\n");
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
    JSON.stringify({
      plugin: ["workit-opencode@git+file:///nonexistent/stale"],
    }),
  );
  try {
    expectInstallerFailure("stale_pin", "workit init");
  } finally {
    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({
        plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`],
      }),
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
        dependencies: {
          ...original.dependencies,
          "@brainervirus/workit-core": "^0.3.0",
        },
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
    // Suites whose fixtures run git against missing revisions and non-repos.
    const noisy = ["test/workit-core/repo.test.ts", "test/workit-core/repo-context.test.ts"];
    for (const file of noisy) expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
    const r = spawnSync("bun", ["test", ...noisy.map((file) => `./${file}`)], {
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

test("codex pin passes when absent, warns on drift, passes on match", () => {
  const emptyBin = path.join(fixture.root, "codex-empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  expect(check(run({ env: { ...process.env, PATH: emptyBin } }), "codex_pin").status).toBe("pass");
  // Stub executables only run on POSIX; Windows asserts the absent case above.
  if (process.platform === "win32") return;
  const bin = path.join(fixture.root, "codex-stub-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "codex"),
    '#!/usr/bin/env bash\necho "codex-cli ${CODEX_STUB_VERSION:-0.154.0}"\n',
    { mode: 0o755 },
  );
  const drifted = run({
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  expect(check(drifted, "codex_pin").status).toBe("warn");
  expect(check(drifted, "codex_pin").detail).toContain(SUPPORT_MATRIX.codex.cli);
  expect(check(drifted, "codex_pin").fix).toBeTruthy();
  const matched = run({
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_STUB_VERSION: SUPPORT_MATRIX.codex.cli,
    },
  });
  expect(check(matched, "codex_pin").status).toBe("pass");
});

// github_identity: divergent authenticated identities warn naming logins only;
// agreement, empty surfaces, and missing remotes pass without any probing.
const identityProbes = (overrides: Record<string, () => string | null> = {}) => ({
  origin: () => "git@github.com:owner/repo.git",
  ghLogin: () => "personal",
  sshLogin: () => "work",
  ...overrides,
});

const identityConfigDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "workit-doctor-identity-"));
  writeFileSync(
    path.join(dir, "vcs.json"),
    JSON.stringify({ provider: "github", github: { host: "github.com" } }),
  );
  return dir;
};

test("github_identity warns on divergent surfaces without leaking secrets", () => {
  const found = githubIdentityFinding([
    { surface: "gh CLI", login: "personal" },
    { surface: "SSH", login: "work" },
  ]);
  expect(found).toMatchObject({ id: "github_identity", status: "warn" });
  expect(found.detail).toContain('"personal"');
  expect(found.detail).toContain('"work"');
  expect(found.detail).not.toContain("secrettoken");
  expect(found.fix).toContain("gh auth");
  expect(found.fix).not.toContain('"personal"');
  expect(found.fix).not.toContain('"work"');
});

test("github_identity passes on agreement, emptiness, and unparseable remotes", () => {
  expect(githubIdentityFinding([{ surface: "gh CLI", login: "a" }]).status).toBe("pass");
  expect(githubIdentityFinding([]).status).toBe("pass");
  expect(githubHostFromRemote("git@github.com:o/r.git")).toBe("github.com");
  expect(githubHostFromRemote("https://ghe.example.com/o/r")).toBe("ghe.example.com");
  expect(githubHostFromRemote("not a remote")).toBe(null);
});

test("checkGithubIdentity passes without a remote and warns on stubbed divergence", () => {
  const dir = identityConfigDir();
  try {
    const noRemote = checkGithubIdentity(
      { cwd: dir, configDir: dir, env: {} },
      { ...identityProbes(), origin: () => null },
    );
    expect(noRemote).toMatchObject({ id: "github_identity", status: "pass" });
    const divergent = checkGithubIdentity({ cwd: dir, configDir: dir, env: {} }, identityProbes());
    expect(divergent.status).toBe("warn");
    expect(divergent.detail).toContain("SSH");
    const agreed = checkGithubIdentity(
      { cwd: dir, configDir: dir, env: {} },
      { ...identityProbes(), sshLogin: () => "personal" },
    );
    expect(agreed.status).toBe("pass");
    expect(
      checkGithubIdentity(
        { cwd: dir, configDir: dir, env: {} },
        { ...identityProbes(), ghLogin: () => null },
      ).status,
    ).toBe("fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitLab doctor uses glab identity and never probes gh for a GitLab checkout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workit-doctor-gitlab-identity-"));
  const previous = process.env.WORKFLOW_VCS_CONFIG;
  writeFileSync(
    path.join(dir, "vcs.json"),
    JSON.stringify({ provider: "gitlab", gitlab: { host: "gitlab.example.test" } }),
  );
  process.env.WORKFLOW_VCS_CONFIG = path.join(dir, "vcs.json");
  try {
    let ghCalls = 0;
    let gitlabHost = "";
    const probes = {
      origin: () => "git@gitlab.example.test:group/repo.git",
      ghLogin: () => {
        ghCalls += 1;
        return "wrong-cli";
      },
      glabLogin: (env: NodeJS.ProcessEnv) => {
        gitlabHost = env.GITLAB_HOST ?? "";
        return "work";
      },
      sshLogin: () => "work",
    };
    expect(checkGithubIdentity({ cwd: dir, configDir: dir, env: {} }, probes)).toMatchObject({
      id: "github_identity",
      status: "pass",
    });
    expect(checkGitLabIdentity({ cwd: dir, configDir: dir, env: {} }, probes)).toMatchObject({
      id: "gitlab_identity",
      status: "pass",
    });
    expect(gitlabHost).toBe("gitlab.example.test");
    expect(ghCalls).toBe(0);
    expect(
      gitlabIdentityFinding([
        { surface: "glab CLI", login: "work" },
        { surface: "SSH", login: "personal" },
      ]),
    ).toMatchObject({ id: "gitlab_identity", status: "warn" });
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor uses a workspace provider for custom SSH-host aliases", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workit-doctor-workspace-provider-"));
  const previous = process.env.WORKFLOW_VCS_CONFIG;
  const configPath = path.join(dir, "vcs.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: "gitlab",
      github: { host: "github.com" },
      gitlab: { host: "gitlab.com" },
    }),
  );
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "personal", glob: `${dir}/**`, vcs: { provider: "github" } }],
    }),
  );
  process.env.WORKFLOW_VCS_CONFIG = configPath;
  try {
    let githubHost = "";
    let glabCalls = 0;
    const probes = {
      origin: () => "git@github-work:owner/repo.git",
      ghLogin: (env: NodeJS.ProcessEnv) => {
        githubHost = env.GH_HOST ?? "";
        return "work";
      },
      glabLogin: () => {
        glabCalls += 1;
        return "wrong";
      },
      sshLogin: () => "work",
    };
    expect(checkGithubIdentity({ cwd: dir, configDir: dir, env: {} }, probes)).toMatchObject({
      id: "github_identity",
      status: "pass",
    });
    expect(checkGitLabIdentity({ cwd: dir, configDir: dir, env: {} }, probes)).toMatchObject({
      id: "gitlab_identity",
      status: "pass",
    });
    expect(githubHost).toBe("github.com");
    expect(glabCalls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor uses the default GitHub API host when the SSH alias has no host config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workit-doctor-github-alias-default-"));
  const previous = process.env.WORKFLOW_VCS_CONFIG;
  const configPath = path.join(dir, "vcs.json");
  writeFileSync(configPath, JSON.stringify({ provider: "github" }));
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [{ name: "personal", glob: `${dir}/**`, vcs: { provider: "github" } }],
    }),
  );
  process.env.WORKFLOW_VCS_CONFIG = configPath;
  try {
    let apiHost = "";
    const result = checkGithubIdentity(
      { cwd: dir, configDir: dir, env: {} },
      {
        origin: () => "git@github-work:owner/repo.git",
        ghLogin: (env) => {
          apiHost = env.GH_HOST ?? "";
          return "work";
        },
        sshLogin: () => "work",
      },
    );
    expect(result).toMatchObject({ id: "github_identity", status: "pass" });
    expect(apiHost).toBe("github.com");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_VCS_CONFIG;
    else process.env.WORKFLOW_VCS_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Workit 3 ships only the OpenCode V2 plugin entry: an OpenCode 1.x CLI fails
// with the pin-to-2.x / upgrade fix; 2.x passes; no CLI skips.
test.skipIf(process.platform === "win32")(
  "opencode_version fails an OpenCode 1.x host with the stay-on-2.x fix",
  () => {
    const bin = binDirWithRuntimes(fixture.root);
    const opencode = path.join(bin, "opencode");
    const withVersion = (version: string) => {
      writeFileSync(opencode, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
      return check(run({ env: { ...process.env, PATH: bin } }), "opencode_version");
    };
    try {
      const old = withVersion("1.18.34");
      expect(old.status).toBe("fail");
      expect(old.detail).toContain(
        `older than the supported minimum ${SUPPORT_MATRIX.opencode.minimum}`,
      );
      expect(old.fix).toContain('"@brainervirus/workit-opencode@2"');
      expect(old.fix).toContain('"plugin" array');
      expect(withVersion("opencode v2.0.21").status).toBe("pass");
    } finally {
      rmSync(opencode, { force: true });
    }
    expect(check(run({ env: { ...process.env, PATH: bin } }), "opencode_version").status).toBe(
      "pass",
    );
  },
  { timeout: 60_000 },
);

test("doctor reads Workit pins from both the `plugins` (2.x) and `plugin` keys", () => {
  const original = readFileSync(fixture.opencodeConfig, "utf8");
  const checkoutPin = `file://${fixture.dev}/packages/workit-opencode`;
  try {
    writeConfig(fixture.opencodeConfig, JSON.stringify({ plugins: [checkoutPin, "other"] }));
    expect(check(run(), "stale_pin").status).toBe("pass");
    expect(check(run(), "duplicate_registration").status).toBe("pass");

    writeConfig(
      fixture.opencodeConfig,
      JSON.stringify({ plugins: [checkoutPin], plugin: [OPENCODE_NPM_PIN] }),
    );
    expect(check(run(), "duplicate_registration").status).toBe("fail");
  } finally {
    writeConfig(fixture.opencodeConfig, original);
  }
});

test(
  "workit_on_path: warns without failing when workit is missing or older than a host plugin",
  () => {
    const opencodeCachePkg = path.join(
      fixture.home,
      ".cache/opencode/packages/@brainervirus/workit-opencode@latest/node_modules/@brainervirus/workit-opencode/package.json",
    );
    const fakeRoot = mkdtempSync(path.join(tmpdir(), "wk-doctor-workit-"));
    const pathWithout = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(
        (dir) =>
          dir && !["workit", "workit.cmd", "workit.exe"].some((n) => existsSync(path.join(dir, n))),
      )
      .join(path.delimiter);
    // Each fake lives in its own dir: the doctor probes a binary once per identity.
    // win32 gets the `workit.cmd` shim npm installs; elsewhere a shell script.
    const win = process.platform === "win32";
    const withScript = (name: string, body: string) => {
      const dir = path.join(fakeRoot, name);
      mkdirSync(dir, { recursive: true });
      const script = win ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`;
      writeFileSync(path.join(dir, win ? "workit.cmd" : "workit"), script, { mode: 0o755 });
      return run({ env: { ...process.env, PATH: `${dir}${path.delimiter}${pathWithout}` } });
    };
    const withFake = (version: string) => withScript(version, `echo ${version}`);
    try {
      writeConfig(
        opencodeCachePkg,
        JSON.stringify({ name: "@brainervirus/workit-opencode", version: "9.2.0" }),
      );
      const baseline = withFake("9.2.0");
      const current = check(baseline, "workit_on_path");
      expect(current.status).toBe("pass");
      expect(current.detail).toContain("workit 9.2.0");

      // A CLI newer than the plugin is normal: plugins republish only on payload change.
      expect(check(withFake("9.3.0"), "workit_on_path").status).toBe("pass");

      const older = withFake("9.1.4");
      const stale = check(older, "workit_on_path");
      expect(stale.status).toBe("warn");
      expect(stale.detail).toContain("9.1.4");
      expect(stale.fix).toContain("npm i -g @brainervirus/workit-cli@9.2.0");
      expect(stale.fix).toContain("npx -y @brainervirus/workit-cli@9.2.0");
      expect(older.exitCode).toBe(baseline.exitCode);
      expect(older.fixes.map((f) => f.id)).not.toContain("workit_on_path");

      const missing = run({ env: { ...process.env, PATH: pathWithout } });
      const absent = check(missing, "workit_on_path");
      expect(absent.status).toBe("warn");
      expect(absent.detail).toBe("no workit on PATH");
      expect(absent.fix).toContain("npm i -g @brainervirus/workit-cli@9.2.0");
      expect(missing.exitCode).toBe(baseline.exitCode);

      const broken = withScript("broken", win ? "exit /b 3" : "exit 3");
      expect(check(broken, "workit_on_path").status).toBe("warn");
      expect(check(broken, "workit_on_path").detail).toContain("does not run");
    } finally {
      rmSync(path.join(fixture.home, ".cache/opencode"), { recursive: true, force: true });
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  },
  SLOW_TEST_TIMEOUT_MS,
);
