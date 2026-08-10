import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function bashAvailable(): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
}

// Stub monorepo (scripts copied in, tiny tree) so sync-runtime + the install
// script run without network or a full-repo rsync; HOME points into tmp so no
// real ~/.config/opencode is touched.
function makeStub(pluginTs: string) {
  const stub = mkdtempSync(path.join(os.tmpdir(), "wk-install-stub-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-install-home-"));
  spawnSync("git", ["init", "-q"], { cwd: stub });
  mkdirSync(path.join(stub, "packages/workit-core/scripts/lib"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-opencode/src"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-opencode-plugin.sh"),
    path.join(stub, "packages/workit-core/scripts/install-opencode-plugin.sh"),
  );
  writeFileSync(
    path.join(stub, "packages/workit-core/scripts/sync-runtime.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 },
  );
  writeFileSync(path.join(stub, "packages/workit-opencode/src/plugin.ts"), pluginTs);
  return { stub, home };
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
  mkdirSync(path.join(stub, "packages/workit-opencode/src"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-opencode-plugin.sh"),
    path.join(stub, "packages/workit-core/scripts/install-opencode-plugin.sh"),
  );
  writeFileSync(
    path.join(stub, "packages/workit-core/scripts/sync-runtime.sh"),
    '#!/usr/bin/env bash\nprintf "%s" "$WORKFLOW_TOOLKIT_DEV" > "$HOME/sync-dev"\n',
    { mode: 0o755 },
  );
  writeFileSync(path.join(stub, "packages/workit-opencode/src/plugin.ts"), "export default {};\n");
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
    expect(readFileSync(path.join(fixture.home, "sync-dev"), "utf8")).toBe(fixture.stub);
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
      `file://${fixture.stub}/packages/workit-opencode/src/plugin.ts`,
    ]);
  } finally {
    rmSync(fixture.stub, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
