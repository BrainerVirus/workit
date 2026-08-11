import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bashAvailable(): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
}

// flock is util-linux; macOS ships no flock, so lock/dependency fixtures that
// need a working sync only run where flock exists (the missing-flock test
// covers flock-absence platforms instead).
function flockAvailable(): boolean {
  return spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;
}

// Stub monorepo (scripts copied in, tiny tree) so sync-runtime + the install
// script run without network or a full-repo rsync; HOME points into tmp so no
// real ~/.config/opencode is touched. The installer imports the shared
// registration helper from src/core, so the stub must mirror it (doctor-check
// pulls the same core modules).
function copyCoreSources(stub: string) {
  for (const name of [
    "registration.ts",
    "doctor.ts",
    "doctor-check.ts",
    "config.ts",
    "boundary.ts",
    "logger.ts",
    "workspaces.ts",
    "support-matrix.ts",
  ]) {
    const src =
      name === "doctor-check.ts"
        ? path.join(repoRoot, "packages/workit-core/scripts/doctor-check.ts")
        : path.join(repoRoot, "packages/workit-core/src/core", name);
    const dest =
      name === "doctor-check.ts"
        ? path.join(stub, "packages/workit-core/scripts/doctor-check.ts")
        : path.join(stub, "packages/workit-core/src/core", name);
    cpSync(src, dest);
  }
}

function makeStub(pluginTs: string) {
  const stub = mkdtempSync(path.join(os.tmpdir(), "wk-install-stub-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-install-home-"));
  spawnSync("git", ["init", "-q"], { cwd: stub });
  mkdirSync(path.join(stub, "packages/workit-core/scripts/lib"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-core/src/core"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-opencode/src"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-opencode-plugin.sh"),
    path.join(stub, "packages/workit-core/scripts/install-opencode-plugin.sh"),
  );
  copyCoreSources(stub);
  writeFileSync(
    path.join(stub, "packages/workit-core/scripts/sync-runtime.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 },
  );
  writeFileSync(path.join(stub, "packages/workit-opencode/src/plugin.ts"), pluginTs);
  // A real sync-runtime copies the opencode assets into the checkout; the stub
  // sync is a no-op, so mirror the synced layout (AR-11 requires them present).
  writeSyncedOpencodeAssets(stub);
  return { stub, home };
}

// Asset files a completed sync-runtime leaves under the opencode package, so
// the post-install doctor (AR-11/CA-40) can pass on a healthy stub install.
function writeSyncedOpencodeAssets(stub: string) {
  const base = path.join(stub, "packages/workit-opencode/assets");
  const files = [
    "commands/wk-init.md",
    "skills/wk-init/SKILL.md",
    "templates/spec-template.md",
    "vendor/superpowers/skills/brainstorming/SKILL.md",
  ];
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), "# stub\n");
  }
}

function runInstall(s: ReturnType<typeof makeStub>) {
  return spawnSync("bash", ["packages/workit-core/scripts/install-opencode-plugin.sh"], {
    cwd: s.stub,
    env: { ...process.env, HOME: s.home, WORKFLOW_TOOLKIT_DEV: s.stub },
    encoding: "utf8",
  });
}

function makeNestedStub() {
  const stub = mkdtempSync(path.join(os.tmpdir(), "wk-install-nested-stub-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-install-nested-home-"));
  spawnSync("git", ["init", "-q"], { cwd: stub });
  mkdirSync(path.join(stub, "packages/workit-core/scripts/lib"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-core/src/core"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-opencode/src"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-opencode-plugin.sh"),
    path.join(stub, "packages/workit-core/scripts/install-opencode-plugin.sh"),
  );
  copyCoreSources(stub);
  writeFileSync(
    path.join(stub, "packages/workit-core/scripts/sync-runtime.sh"),
    '#!/usr/bin/env bash\nprintf "%s" "$WORKFLOW_TOOLKIT_DEV" > "$HOME/sync-dev"\n',
    { mode: 0o755 },
  );
  writeFileSync(path.join(stub, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
  writeSyncedOpencodeAssets(stub);
  mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  writeFileSync(
    path.join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      plugin: [
        "@dietrichgebert/ponytail",
        "@brainervirus/workit-opencode",
        `workflow-toolkit-opencode@git+file://${stub}`,
      ],
    }),
  );
  return { stub, home };
}

// Stub checkout for the cursor installer: needs a .cursor-plugin dir (the
// LOCAL_ROOT guard on line 25), a stub sync-runtime.sh that records the ROOT it
// was run against, and a .cursor home so the registration merge has a writable
// target.
function makeCursorStub() {
  const stub = mkdtempSync(path.join(os.tmpdir(), "wk-install-cursor-stub-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-install-cursor-home-"));
  spawnSync("git", ["init", "-q"], { cwd: stub });
  mkdirSync(path.join(stub, "packages/workit-core/scripts/lib"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-core/src/core"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-cursor-plugin.sh"),
    path.join(stub, "packages/workit-core/scripts/install-cursor-plugin.sh"),
  );
  copyCoreSources(stub);
  writeFileSync(
    path.join(stub, "packages/workit-core/scripts/sync-runtime.sh"),
    '#!/usr/bin/env bash\nprintf "%s" "$WORKFLOW_TOOLKIT_DEV" > "$HOME/sync-dev"\n',
    { mode: 0o755 },
  );
  // A real sync-runtime copies the cursor package (assets, mcp shims, hooks)
  // into the checkout; the stub sync is a no-op, so mirror the synced layout
  // (AR-11 requires the selected-host surfaces present).
  mkdirSync(path.join(stub, "packages/workit-cursor/assets/templates"), { recursive: true });
  writeFileSync(
    path.join(stub, "packages/workit-cursor/assets/templates/spec-template.md"),
    "# spec\n",
  );
  writeFileSync(
    path.join(stub, "packages/workit-cursor/mcp.json"),
    JSON.stringify({ mcpServers: { workit: { command: "node", args: ["dist/mcp-server.js"] } } }),
  );
  writeFileSync(
    path.join(stub, "packages/workit-cursor/marketplace.json"),
    JSON.stringify({ name: "workit", version: "0.4.0" }),
  );
  mkdirSync(path.join(stub, "packages/workit-cursor/mcp"), { recursive: true });
  writeFileSync(path.join(stub, "packages/workit-cursor/mcp/run-server.sh"), "#!/bin/sh\n");
  mkdirSync(path.join(stub, "packages/workit-cursor/hooks"), { recursive: true });
  writeFileSync(path.join(stub, "packages/workit-cursor/hooks/session-start"), "#!/bin/sh\n");
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  return { stub, home };
}

test("install-opencode-plugin.sh writes a file:// pin and fails loudly on an empty pinned entry", () => {
  if (!bashAvailable()) return;
  const good = makeStub("export default {};\n");
  const empty = makeStub("");
  try {
    const ok = runInstall(good);
    expect(ok.status, ok.stderr).toBe(0);
    const config = JSON.parse(
      readFileSync(path.join(good.home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(config.plugin).toEqual([`file://${good.stub}/packages/workit-opencode/src/plugin.ts`]);

    const bad = runInstall(empty);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("FATAL: pinned plugin entry missing or empty");
  } finally {
    rmSync(good.stub, { recursive: true, force: true });
    rmSync(good.home, { recursive: true, force: true });
    rmSync(empty.stub, { recursive: true, force: true });
    rmSync(empty.home, { recursive: true, force: true });
  }
});

test("install-opencode-plugin.sh uses the monorepo root and prioritizes one dev pin", () => {
  if (!bashAvailable()) return;
  const fixture = makeNestedStub();
  try {
    const installed = spawnSync(
      "bash",
      ["packages/workit-core/scripts/install-opencode-plugin.sh"],
      {
        cwd: fixture.stub,
        env: {
          ...process.env,
          HOME: fixture.home,
          WORKFLOW_TOOLKIT_DEV: fixture.stub,
        },
        encoding: "utf8",
      },
    );
    expect(installed.status, installed.stderr).toBe(0);
    expect(readFileSync(path.join(fixture.home, "sync-dev"), "utf8")).toBe(
      realpathSync(fixture.stub),
    );
    const config = JSON.parse(
      readFileSync(path.join(fixture.home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(config.plugin).toEqual([
      `file://${fixture.stub}/packages/workit-opencode/src/plugin.ts`,
      "@dietrichgebert/ponytail",
    ]);
  } finally {
    rmSync(fixture.stub, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("install-opencode-plugin.sh defaults to the checkout containing the script", () => {
  if (!bashAvailable()) return;
  const fixture = makeStub("export default {};\n");
  const share = path.join(fixture.home, ".local/share/workflow-toolkit");
  try {
    mkdirSync(path.join(share, ".git"), { recursive: true });
    mkdirSync(path.join(share, "packages/workit-opencode/src"), { recursive: true });
    writeFileSync(
      path.join(share, "packages/workit-opencode/src/plugin.ts"),
      "export default {};\n",
    );
    const { WORKFLOW_TOOLKIT_DEV: _ignored, ...env } = process.env;
    const installed = spawnSync(
      "bash",
      ["packages/workit-core/scripts/install-opencode-plugin.sh"],
      {
        cwd: fixture.stub,
        env: { ...env, HOME: fixture.home },
        encoding: "utf8",
      },
    );

    expect(installed.status, installed.stderr).toBe(0);
    const config = JSON.parse(
      readFileSync(path.join(fixture.home, ".config/opencode/opencode.json"), "utf8"),
    );
    expect(config.plugin).toEqual([
      `file://${realpathSync(fixture.stub)}/packages/workit-opencode/src/plugin.ts`,
    ]);
  } finally {
    rmSync(fixture.stub, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("installers clone from the public HTTPS URL, never SSH (RR-05)", () => {
  for (const name of [
    "install-cursor-plugin.sh",
    "install-opencode-plugin.sh",
    "sync-runtime.sh",
  ]) {
    const src = readFileSync(path.join(repoRoot, "packages/workit-core/scripts", name), "utf8");
    expect(src, name).not.toMatch(/git@github\.com:/);
    expect(src, name).toMatch(/https:\/\/github\.com\//);
  }
});

test("install-cursor-plugin.sh resolves the local checkout root and never falls back to GitHub", () => {
  if (!bashAvailable()) return;
  const fixture = makeCursorStub();
  try {
    // A share clone with a dead remote makes the FROM_GITHUB fallback
    // deterministically fail offline (no network). A green run therefore proves
    // the installer used the local checkout tree, and sync-dev records which
    // ROOT it synced from.
    const share = path.join(fixture.home, ".local/share/workflow-toolkit");
    mkdirSync(path.join(share, ".git"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: share });
    spawnSync("git", ["remote", "add", "origin", "https://127.0.0.1:1/workflow-toolkit.git"], {
      cwd: share,
    });

    const installed = spawnSync("bash", ["packages/workit-core/scripts/install-cursor-plugin.sh"], {
      cwd: fixture.stub,
      env: { ...process.env, HOME: fixture.home, WORKFLOW_TOOLKIT_DEV: fixture.stub },
      encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(readFileSync(path.join(fixture.home, "sync-dev"), "utf8")).toBe(
      realpathSync(fixture.stub),
    );
  } finally {
    rmSync(fixture.stub, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

function syncEnv(
  home: string,
  runtimeDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("WORKFLOW_") || k === "XDG_RUNTIME_DIR" || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.HOME = home;
  env.XDG_RUNTIME_DIR = runtimeDir;
  return { ...env, ...extra };
}

function runSyncScript(env: Record<string, string>) {
  const res = spawnSync(
    "bash",
    [path.join(repoRoot, "packages/workit-core/scripts/sync-runtime.sh")],
    { env, encoding: "utf8" },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("sync-runtime fails when the flock utility is missing (RR-05)", () => {
  if (!bashAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  try {
    const bashPath = spawnSync("bash", ["-c", "command -v bash"], {
      encoding: "utf8",
    }).stdout.trim();
    const dirnamePath = spawnSync("bash", ["-c", "command -v dirname"], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(bashPath, path.join(binDir, "bash"));
    symlinkSync(dirnamePath, path.join(binDir, "dirname"));
    const r = runSyncScript(syncEnv(home, runtimeDir, { PATH: binDir }));
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("flock");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("sync-runtime exits nonzero when the sync lock is already held (RR-05)", async () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const lock = path.join(runtimeDir, "workflow-toolkit-sync.lock");
  const marker = path.join(runtimeDir, "lock-held");
  const holder = spawn(
    "bash",
    ["-c", `exec 9>"$1"; flock -n 9 || exit 1; : >"$2"; sleep 30`, "holder", lock, marker],
    { stdio: "ignore" },
  );
  try {
    for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(25);
    expect(existsSync(marker), "test holder failed to acquire the sync lock").toBe(true);
    const r = runSyncScript(syncEnv(home, runtimeDir));
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("lock");
  } finally {
    holder.kill();
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("sync-runtime fails loudly when updating an existing share clone cannot fetch (RR-05)", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const share = path.join(home, ".local/share/workflow-toolkit");
  try {
    mkdirSync(path.join(share, ".git"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: share });
    spawnSync("git", ["remote", "add", "origin", "https://127.0.0.1:1/workflow-toolkit.git"], {
      cwd: share,
    });
    const r = runSyncScript(syncEnv(home, runtimeDir));
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("FATAL");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("sync-runtime does not report success when a dependency install fails (RR-05)", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  const dev = mkdtempSync(path.join(os.tmpdir(), "wk-sync-dev-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dev });
    mkdirSync(path.join(dev, "packages/workit-opencode/src"), { recursive: true });
    mkdirSync(path.join(dev, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
    mkdirSync(path.join(dev, "packages/workit-cursor/mcp"), { recursive: true });
    writeFileSync(path.join(dev, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
    writeFileSync(
      path.join(binDir, "npm"),
      "#!/usr/bin/env bash\necho 'npm unavailable' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const env = syncEnv(home, runtimeDir, {
      WORKFLOW_TOOLKIT_DEV: dev,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const r = runSyncScript(env);
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("npm");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});
