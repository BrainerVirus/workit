import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// C1: the release rewrite script must replace workspace:* core deps with the
// released version — a packed tarball with workspace:* silently drops the core
// dependency (npm pack and bun publish both leave the protocol untouched).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const core = (dir: string) => JSON.parse(readFileSync(path.join(dir, "packages/workit-core/package.json"), "utf8"));

test("rewrite-workspace-deps.ts: workspace:* → ^<core version> in all 3 platform packages", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "wf-rewrite-"));
  for (const pkg of ["workit-core", "workit-opencode", "workit-cursor", "workit-cli"]) {
    cpSync(path.join(repoRoot, `packages/${pkg}/package.json`), path.join(sandbox, `packages/${pkg}/package.json`));
  }
  for (const f of [".cursor-plugin/plugin.json", "marketplace.json"]) {
    cpSync(path.join(repoRoot, `packages/workit-cursor/${f}`), path.join(sandbox, `packages/workit-cursor/${f}`));
  }
  const script = path.join(repoRoot, "packages/workit-core/scripts/rewrite-workspace-deps.ts");
  const run = spawnSync("bun", [script, sandbox], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);

  const version = core(sandbox).version;
  for (const pkg of ["workit-opencode", "workit-cursor", "workit-cli"]) {
    const data = JSON.parse(readFileSync(path.join(sandbox, `packages/${pkg}/package.json`), "utf8"));
    expect(data.dependencies["@brainervirus/workit-core"]).toBe(`^${version}`);
    expect(JSON.stringify(data)).not.toContain("workspace:*");
  }
  expect(JSON.stringify(core(sandbox))).not.toContain("workspace:*");
  for (const f of [".cursor-plugin/plugin.json", "marketplace.json"]) {
    const data = JSON.parse(readFileSync(path.join(sandbox, `packages/workit-cursor/${f}`), "utf8"));
    expect(data.version).toBe(version);
  }
  const marketplace = JSON.parse(readFileSync(path.join(sandbox, "packages/workit-cursor/marketplace.json"), "utf8"));
  expect(marketplace.homepage).toBe("https://github.com/BrainerVirus/workit");
  expect(marketplace.repository).toBe("https://github.com/BrainerVirus/workit.git");
});

test("rewrite-workspace-deps.ts: repo package.jsons keep workspace:* for dev (script runs on sandbox only)", () => {
  for (const pkg of ["workit-opencode", "workit-cursor", "workit-cli"]) {
    const data = JSON.parse(readFileSync(path.join(repoRoot, `packages/${pkg}/package.json`), "utf8"));
    expect(data.dependencies["@brainervirus/workit-core"]).toBe("workspace:*");
  }
});
