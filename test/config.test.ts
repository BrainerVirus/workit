import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configDir, readConfig, writeConfig, resolveBranchPolicy, PRESETS,
  type ToolkitConfig,
} from "../src/core/config";

const cfgDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-config-"));
  process.env.WORKFLOW_TOOLKIT_CONFIG_DIR = dir;
  return dir;
};

const cleanupEnv = () => { delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR; };

test("readConfig returns defaults when config.json missing", () => {
  const dir = cfgDir();
  try {
    const cfg = readConfig();
    expect(cfg.locale).toBe("en");
    expect(cfg.branchPolicy.preset).toBe("gitflow");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("writeConfig + readConfig round trip", () => {
  const dir = cfgDir();
  try {
    const cfg: ToolkitConfig = {
      locale: "es-CL",
      localeOptions: ["en", "es-CL"],
      timezone: "America/Santiago",
      branchPolicy: { preset: "custom", allowed: ["feature/*", "codex/*"], protected: ["main"] },
    };
    writeConfig(cfg);
    expect(readConfig()).toEqual(cfg);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid locale falls back to en", () => {
  const dir = cfgDir();
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ locale: "not-valid!" }), "utf8");
    expect(readConfig().locale).toBe("en");
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});

test("presets define allowed/protected lists", () => {
  expect(PRESETS.gitflow.allowed).toContain("feature/*");
  expect(PRESETS.gitflow.allowed).toContain("bugfix/*");
  expect(PRESETS.gitflow.protected).toContain("develop");
  expect(PRESETS["github-flow"].allowed).toContain("*");
});

test("resolveBranchPolicy honors preset and custom overrides", () => {
  const dir = cfgDir();
  try {
    const gitflow = resolveBranchPolicy(readConfig());
    expect(gitflow.allowed.some((r) => r.test("feature/x"))).toBe(true);
    expect(gitflow.allowed.some((r) => r.test("codex/feature/x"))).toBe(false);
    expect(gitflow.protected.has("main")).toBe(true);

    writeConfig({
      locale: "en", localeOptions: ["en"], timezone: "UTC",
      branchPolicy: { preset: "custom", allowed: ["codex/*"], protected: ["main"] },
    });
    const custom = resolveBranchPolicy(readConfig());
    expect(custom.allowed.some((r) => r.test("codex/feature/x"))).toBe(true);
    expect(custom.allowed.some((r) => r.test("feature/x"))).toBe(false);
  } finally { cleanupEnv(); rmSync(dir, { recursive: true, force: true }); }
});
