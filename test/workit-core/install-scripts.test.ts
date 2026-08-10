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
  mkdirSync(path.join(stub, "scripts"), { recursive: true });
  mkdirSync(path.join(stub, "scripts/lib"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-cursor/.cursor-plugin"), { recursive: true });
  mkdirSync(path.join(stub, "packages/workit-opencode/src"), { recursive: true });
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/install-opencode-plugin.sh"),
    path.join(stub, "scripts/install-opencode-plugin.sh"),
  );
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/sync-runtime.sh"),
    path.join(stub, "scripts/sync-runtime.sh"),
  );
  cpSync(
    path.join(repoRoot, "packages/workit-core/scripts/lib/config-dir.sh"),
    path.join(stub, "scripts/lib/config-dir.sh"),
  );
  writeFileSync(path.join(stub, "packages/workit-opencode/src/plugin.ts"), pluginTs);
  return { stub, home };
}

function runInstall(s: ReturnType<typeof makeStub>) {
  return spawnSync("bash", ["scripts/install-opencode-plugin.sh"], {
    cwd: s.stub,
    env: { ...process.env, HOME: s.home, WORKFLOW_TOOLKIT_DEV: s.stub },
    encoding: "utf8",
  });
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
