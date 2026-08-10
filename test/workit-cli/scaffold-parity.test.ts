import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldVcs, scaffoldYouTrack } from "../../packages/workit-cli/src/logic";

// ponytail: pins parity between the wizard scaffolds (packages/workit-cli/src/logic.ts) and the bash
// scripts/init/apply.sh writes — both must produce the same youtrack.json / vcs.json.
// apply.sh honors WORKFLOW_YT_*/WORKFLOW_VCS_* env overrides; the wizard ignores them
// (documented in logic.ts), so run apply.sh with a clean env.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = "https://enghouseamg.youtrack.cloud";

function bashAvailable(): boolean {
  // win32 CI has no bash — skip the parity check there
  if (process.platform === "win32") return false;
  for (const [cmd, args] of [
    ["bash", ["--version"]],
    ["python3", ["--version"]],
  ] as const) {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.status !== 0) return false;
  }
  return true;
}

function runApply(action: string, configDir: string): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^WORKFLOW_(YT|VCS|GITLAB|GITHUB)_/.test(k)) continue; // env overrides would break parity
    env[k] = v;
  }
  env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  const r = spawnSync("bash", ["packages/workit-core/scripts/init/apply.sh", action, "true"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  expect(r.status, `${action} failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

test("wizard scaffolds match scripts/init/apply.sh output (youtrack + vcs)", () => {
  if (!bashAvailable()) return; // no bash/python3 (e.g. win32 CI) — skip gracefully

  const tsDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-ts-"));
  const shDir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-sh-"));
  try {
    const tsYt = scaffoldYouTrack(tsDir, BASE_URL, {
      locale: "es-CL",
      timezone: "America/Santiago",
    });
    const tsVcs = scaffoldVcs(tsDir, "gitlab");

    runApply("youtrack_scaffold", shDir);
    runApply("vcs_scaffold", shDir);

    const shYt = JSON.parse(readFileSync(path.join(shDir, "youtrack.json"), "utf8"));
    const shVcs = JSON.parse(readFileSync(path.join(shDir, "vcs.json"), "utf8"));

    // deep-equal on parsed JSON, with the temp-dir prefix normalized: tokenFile/token paths embed the
    // config dir, and the two scaffolds run into different temp dirs by construction
    const normalizePaths = (cfg: unknown, dir: string): unknown =>
      JSON.parse(
        JSON.stringify(cfg, (k, v) => (typeof v === "string" ? v.replace(dir, "<config-dir>") : v)),
      );

    expect(normalizePaths(JSON.parse(readFileSync(tsYt.youtrackJson, "utf8")), tsDir)).toEqual(
      normalizePaths(shYt, shDir),
    );
    expect(normalizePaths(JSON.parse(readFileSync(tsVcs.vcsJson, "utf8")), tsDir)).toEqual(
      normalizePaths(shVcs, shDir),
    );
  } finally {
    rmSync(tsDir, { recursive: true, force: true });
    rmSync(shDir, { recursive: true, force: true });
  }
});

test("wizard summary keeps nested output indented", () => {
  const source = readFileSync(path.join(repoRoot, "packages/workit-cli/src/steps.tsx"), "utf8");

  expect(source.match(/\{"  "\}token placeholder/g)).toHaveLength(2);
  expect(source.match(/\{"  "\}create token/g)).toHaveLength(2);
  expect(source).toContain('{"  "}+ {file}');
});

test("wizard summary suppresses success and index exits nonzero until configuration completed (WZ-10)", () => {
  const stepsSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/steps.tsx"),
    "utf8",
  );
  expect(stepsSource).toMatch(/complete \? "Setup complete" : "Setup incomplete"/);
  expect(stepsSource).toMatch(/\{complete &&[\s\S]*Paste the token/);
  expect(stepsSource).toContain("Blocked");

  const indexSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/index.tsx"),
    "utf8",
  );
  expect(indexSource).toMatch(/process\.exit\(complete \? 0 : 1\)/);
});
