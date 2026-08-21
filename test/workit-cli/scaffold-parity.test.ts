import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("wizard is a sequential state machine: one reducer owns all draft transitions", () => {
  const stepsSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/steps.tsx"),
    "utf8",
  );
  const stateSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/wizard-state.ts"),
    "utf8",
  );

  expect(stateSource).toContain("type WizardDraft");
  expect(stateSource).toContain("screen: WizardScreen");
  expect(stateSource).toContain("values: SetupValues");
  expect(stateSource).toContain("errors: Record<string, string>");
  expect(stateSource).toContain("cancelled: boolean");
  // The reducer is the single source of Back/Next/Cancel/Apply transitions.
  expect(stateSource).toMatch(/export function reducer\(/);
  expect(stateSource).toMatch(/case "next"/);
  expect(stateSource).toMatch(/case "back"/);
  expect(stateSource).toMatch(/case "cancel"/);
  expect(stateSource).toMatch(/case "apply"/);
  // The wizard dispatches to the reducer and mounts one screen at a time.
  expect(stepsSource).toMatch(/useReducer\(reducer, undefined, createInitialDraft\)/);
  expect(stepsSource).toMatch(/<Screen key=\{draft\.screen\}/);
});

test("wizard writes nothing before Apply; index exits nonzero until configuration completed (WZ-10)", () => {
  const stepsSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/steps.tsx"),
    "utf8",
  );

  // No filesystem application inside the wizard — that is deferred to Apply
  // (Tasks 13-14); the screens only accumulate an in-memory draft.
  for (const write of [
    "writeConfig",
    "scaffoldYouTrack",
    "scaffoldVcs",
    "writeWorkspaces",
    "runProjectSetup",
    "writeFileSync",
  ]) {
    expect(stepsSource).not.toContain(write);
  }

  const indexSource = readFileSync(
    path.join(repoRoot, "packages/workit-cli/src/index.tsx"),
    "utf8",
  );
  expect(indexSource).toMatch(/process\.exit\(exit !== undefined && exit\.complete \? 0 : 1\)/);
});

test("CLI scaffold ships the execution-reliability contract surface", () => {
  const template = readFileSync(
    path.join(repoRoot, "packages/workit-cli/assets/templates/execution-contract.md"),
    "utf8",
  );
  const flow = readFileSync(path.join(repoRoot, "packages/workit-cli/src/flow.ts"), "utf8");

  for (const phrase of ["Change model first", "delegation_lineage_denied", "workflow_sdd_append_advisory"]) {
    expect(template).toContain(phrase);
  }
  expect(flow).toContain("append-advisory");
});

// Task 14 Step 7 (CA-13): initApplyData token writes must use the same wx +
// EEXIST-as-preserved semantics as the wizard's ensureToken — an existing real
// token is never clobbered by a scaffold/placeholder write.
test("initApplyData never clobbers existing credentials (wx + EEXIST, CA-13)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-parity-token-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_TOOLKIT_CONFIG: dir };
    for (const key of Object.keys(env)) {
      if (/^WORKFLOW_(YT|VCS|GITLAB|GITHUB)_/.test(key)) delete env[key]; // env overrides would break parity
    }

    const ytToken = path.join(dir, "youtrack.token");
    writeFileSync(ytToken, "perm_yt_123\n", { mode: 0o600 });
    const placeholder = initApplyData("youtrack_token_placeholder", env);
    expect(placeholder.preserved).toBe(true);
    expect(readFileSync(ytToken, "utf8")).toBe("perm_yt_123\n");

    const scaffold = initApplyData("youtrack_scaffold", env);
    expect(scaffold.preserved).toBe(true);
    expect(readFileSync(ytToken, "utf8")).toBe("perm_yt_123\n");

    const glToken = path.join(dir, "gitlab.token");
    const ghToken = path.join(dir, "github.token");
    writeFileSync(glToken, "glpat-secret\n", { mode: 0o600 });
    writeFileSync(ghToken, "ghp_secret\n", { mode: 0o600 });
    const vcs = initApplyData("vcs_scaffold", env);
    expect(vcs.preserved_tokens).toContain(path.resolve(glToken));
    expect(vcs.preserved_tokens).toContain(path.resolve(ghToken));
    expect(readFileSync(glToken, "utf8")).toBe("glpat-secret\n");
    expect(readFileSync(ghToken, "utf8")).toBe("ghp_secret\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
