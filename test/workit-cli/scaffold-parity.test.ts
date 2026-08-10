import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldVcs, scaffoldYouTrack } from "../../packages/workit-cli/src/logic";
import { initApplyData } from "../../packages/workit-core/src/core/init";

// ponytail: pins parity between the wizard scaffolds (packages/workit-cli/src/logic.ts)
// and the initApplyData port of scripts/init/apply.sh writes — both must produce the
// same youtrack.json / vcs.json. initApplyData honors WORKFLOW_YT_*/WORKFLOW_VCS_*
// env overrides; the wizard ignores them (documented in logic.ts), so run it with a
// clean env.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_URL = "https://enghouseamg.youtrack.cloud";

function runApply(action: string, configDir: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^WORKFLOW_(YT|VCS|GITLAB|GITHUB)_/.test(key)) delete env[key]; // env overrides would break parity
  }
  env.WORKFLOW_TOOLKIT_CONFIG = configDir;
  const out = initApplyData(action, env);
  if (out.error) throw new Error(`${action} failed: ${out.error}`);
}

test("wizard scaffolds match initApplyData output (youtrack + vcs)", () => {
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
