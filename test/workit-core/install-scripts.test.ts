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
import { CANONICAL_SKILLS } from "../../packages/workit-core/src/core/skill-manifests";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bashAvailable(): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
}

// flock is util-linux; macOS ships no flock, so sync fixtures that
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
    "skill-manifests.ts",
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
  for (const [root, skills] of [
    ["vendor/superpowers/skills", CANONICAL_SKILLS.superpowers],
    ["skills", CANONICAL_SKILLS.workit],
  ] as const) {
    for (const skill of skills) {
      const dir = path.join(home, ".cursor/plugins/local/workit", root, skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "# skill\n");
    }
  }
  const installedDist = path.join(home, ".cursor/plugins/local/workit/dist");
  mkdirSync(installedDist, { recursive: true });
  writeFileSync(path.join(installedDist, "mcp-server.js"), "#!/usr/bin/env node\n// bundle\n");
  writeFileSync(
    path.join(installedDist, "cursor-session-start.js"),
    "#!/usr/bin/env node\n// hook bundle\n",
  );
  const installedHooks = path.join(home, ".cursor/plugins/local/workit/hooks");
  mkdirSync(installedHooks, { recursive: true });
  writeFileSync(
    path.join(installedHooks, "hooks-cursor.json"),
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          {
            command:
              "npx -y --package=@brainervirus/workit-cursor@0.8.0 workit-cursor-session-start",
          },
        ],
      },
    }),
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
    path.join(stub, "packages/workit-cursor/marketplace.json"),
    JSON.stringify({ name: "workit", version: "0.4.0" }),
  );
  mkdirSync(path.join(stub, "packages/workit-cursor/mcp"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-cursor/hooks"), { recursive: true });
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

test("install-cursor-plugin.sh removes the legacy dir after success, carrying user rules forward", () => {
  if (!bashAvailable()) return;
  const fixture = makeCursorStub();
  const legacyDir = path.join(fixture.home, ".cursor", "plugins", "local", "workflow-toolkit");
  const otherDir = path.join(fixture.home, ".cursor", "plugins", "local", "workflow-toolkit-extra");
  try {
    mkdirSync(path.join(legacyDir, "rules"), { recursive: true });
    writeFileSync(
      path.join(legacyDir, "rules", "user-managed.mdc"),
      "---\nalwaysApply: true\n---\n# User rule\n",
    );
    mkdirSync(path.join(legacyDir, "skills"), { recursive: true });
    writeFileSync(path.join(legacyDir, "skills", "stale-skill.md"), "# legacy\n");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, "marker"), "unrelated\n");

    const installed = spawnSync("bash", ["packages/workit-core/scripts/install-cursor-plugin.sh"], {
      cwd: fixture.stub,
      env: { ...process.env, HOME: fixture.home, WORKFLOW_TOOLKIT_DEV: fixture.stub },
      encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);

    // The legacy identity is removed only after a successful install; the
    // user-compiled rule is carried forward, unrelated sibling dirs survive.
    expect(existsSync(legacyDir)).toBe(false);
    expect(
      readFileSync(
        path.join(
          fixture.home,
          ".cursor",
          "plugins",
          "local",
          "workit",
          "rules",
          "user-managed.mdc",
        ),
        "utf8",
      ),
    ).toContain("# User rule");
    expect(readFileSync(path.join(otherDir, "marker"), "utf8")).toBe("unrelated\n");
  } finally {
    rmSync(fixture.stub, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
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

function makeDependencyFreeCheckout() {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "wk-sync-checkout-"));
  for (const file of ["package.json", "bun.lock"]) {
    cpSync(path.join(repoRoot, file), path.join(checkout, file));
  }
  for (const pkg of ["workit-core", "workit-cursor", "workit-opencode"]) {
    cpSync(path.join(repoRoot, "packages", pkg), path.join(checkout, "packages", pkg), {
      recursive: true,
      filter: (src) =>
        !src.split(path.sep).some((part) => part === "node_modules" || part === "dist"),
    });
  }
  const dist = path.join(checkout, "packages/workit-cursor/dist");
  mkdirSync(dist, { recursive: true });
  for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
    writeFileSync(path.join(dist, entry), "stale\n");
  }
  return checkout;
}

function writeOfflineBunWrapper(binDir: string, name = "selected-runtime") {
  const wrapper = path.join(binDir, name);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--version" ]; then exec "$REAL_BUN" --version; fi
if [ "\${1:-}" = "install" ]; then
  [ "\${2:-}" = "--frozen-lockfile" ] || exit 41
  printf 'install\n' >> "$BUN_LOG"
  [ "\${FAIL_INSTALL:-0}" = "0" ] || exit 42
  mkdir -p "$PWD/node_modules/@brainervirus" "$PWD/node_modules/@modelcontextprotocol"
  ln -s "$PWD/packages/workit-core" "$PWD/node_modules/@brainervirus/workit-core"
  ln -s "$REAL_NODE_MODULES/@modelcontextprotocol/sdk" "$PWD/node_modules/@modelcontextprotocol/sdk"
  ln -s "$REAL_NODE_MODULES/zod" "$PWD/node_modules/zod"
  exit 0
fi
case "\${1:-}" in
  */packages/workit-cursor/scripts/build.ts)
    grep -qx install "$BUN_LOG" || exit 43
    printf 'build\n' >> "$BUN_LOG"
    [ "\${FAIL_BUILD:-0}" = "0" ] || exit 44
    "$REAL_BUN" "$@"
    if [ "\${BAD_OUTPUT:-0}" = "1" ]; then printf '#!/usr/bin/env bun\n' > "$PWD/packages/workit-cursor/dist/mcp-server.js"; fi
    exit 0
    ;;
esac
exec "$REAL_BUN" "$@"
`,
    { mode: 0o755 },
  );
  return wrapper;
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

test("sync-runtime installs frozen dependencies before rebuilding and replacing stale Cursor dist", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  const dev = makeDependencyFreeCheckout();
  const log = path.join(binDir, "bun.log");
  try {
    const bun = writeOfflineBunWrapper(binDir);
    const env = syncEnv(home, runtimeDir, {
      WORKFLOW_TOOLKIT_DEV: dev,
      BUN: bun,
      BUN_LOG: log,
      REAL_BUN: process.execPath,
      REAL_NODE_MODULES: path.join(repoRoot, "node_modules"),
      PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    });
    const r = runSyncScript(env);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("install\nbuild\n");
    for (const entry of ["mcp-server.js", "cursor-session-start.js"]) {
      const installed = path.join(home, ".cursor/plugins/local/workit/dist", entry);
      expect(existsSync(installed), entry).toBe(true);
      expect(readFileSync(installed, "utf8")).toStartWith("#!/usr/bin/env node");
      expect(readFileSync(installed, "utf8")).not.toBe("stale\n");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});

test("sync-runtime fails loudly when a dist-less Cursor adapter cannot find Bun", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  const dev = mkdtempSync(path.join(os.tmpdir(), "wk-sync-dev-"));
  try {
    for (const tool of ["bash", "chmod", "dirname", "flock", "mkdir", "rm", "rsync"]) {
      symlinkSync(
        spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(),
        path.join(binDir, tool),
      );
    }
    mkdirSync(path.join(dev, "packages/workit-opencode/src"), { recursive: true });
    mkdirSync(path.join(dev, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
    mkdirSync(path.join(dev, "packages/workit-cursor/scripts"), { recursive: true });
    writeFileSync(path.join(dev, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
    writeFileSync(path.join(dev, "packages/workit-cursor/scripts/build.ts"), "// build entry\n");

    const r = runSyncScript(syncEnv(home, runtimeDir, { WORKFLOW_TOOLKIT_DEV: dev, PATH: binDir }));
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("Bun");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});

test("sync-runtime does not fall back when configured BUN is invalid", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  const dev = makeDependencyFreeCheckout();
  const fallback = path.join(binDir, "fallback-used");
  try {
    writeFileSync(path.join(binDir, "bun"), `#!/usr/bin/env bash\ntouch "${fallback}"\nexit 0\n`, {
      mode: 0o755,
    });
    const configured = path.join(binDir, "missing-bun");
    const r = runSyncScript(
      syncEnv(home, runtimeDir, {
        WORKFLOW_TOOLKIT_DEV: dev,
        BUN: configured,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
    );
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain(`BUN is set but unusable: ${configured}`);
    expect(existsSync(fallback)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});

test("sync-runtime treats empty BUN as unset and does not skip a broken home Bun", () => {
  if (!bashAvailable() || !flockAvailable()) return;
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-xdg-"));
  const binDir = mkdtempSync(path.join(os.tmpdir(), "wk-sync-bin-"));
  const dev = makeDependencyFreeCheckout();
  const pathBunUsed = path.join(binDir, "path-bun-used");
  const makeHome = (brokenHomeBun: boolean) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "wk-sync-home-"));
    if (brokenHomeBun) {
      mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
      writeFileSync(path.join(home, ".bun/bin/bun"), "#!/usr/bin/env bash\nexit 9\n", {
        mode: 0o755,
      });
    }
    return home;
  };
  const pathBun = path.join(binDir, "bun");
  writeFileSync(pathBun, `#!/usr/bin/env bash\ntouch "${pathBunUsed}"\nexit 0\n`, { mode: 0o755 });
  const emptyHome = makeHome(false);
  const brokenHome = makeHome(true);
  try {
    const empty = runSyncScript(
      syncEnv(emptyHome, runtimeDir, {
        WORKFLOW_TOOLKIT_DEV: dev,
        BUN: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
    );
    expect(existsSync(pathBunUsed), empty.stderr).toBe(true);

    rmSync(pathBunUsed, { force: true });
    const broken = runSyncScript(
      syncEnv(brokenHome, runtimeDir, {
        WORKFLOW_TOOLKIT_DEV: dev,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      }),
    );
    expect(broken.status).not.toBe(0);
    expect(existsSync(pathBunUsed)).toBe(false);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(brokenHome, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});
