import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Temp HOME with ~/.config/workflow-toolkit populated from the given files, so
// config.sh defaults ($HOME/.config/workflow-toolkit/*) stay isolated.
export const withConfigDir = (files: Record<string, string>) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wk-test-home-"));
  const cfgDir = path.join(home, ".config", "workflow-toolkit");
  mkdirSync(cfgDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(cfgDir, name), content, "utf8");
  }
  return { home, cfgDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
};

// Spawn env with HOME overridden and config env vars stripped (so scripts fall
// back to their HOME defaults).
export const envWithHome = (
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^WORKFLOW_(VCS|TOOLKIT_CONFIG)/.test(k) || k === "XDG_CONFIG_HOME")
      continue;
    env[k] = v;
  }
  env.HOME = home;
  return { ...env, ...extra };
};

// WORKFLOW_TOOLKIT_CONFIG -> dir; restored afterwards; dir removed.
export const withIsolatedConfig = (dir: string, fn: () => void) => {
  const previous = process.env.WORKFLOW_TOOLKIT_CONFIG;
  process.env.WORKFLOW_TOOLKIT_CONFIG = dir;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_TOOLKIT_CONFIG;
    else process.env.WORKFLOW_TOOLKIT_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

// Temp dir as WORKFLOW_TOOLKIT_CONFIG; restored afterwards; dir removed.
export const withTempConfigDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-config-"));
  withIsolatedConfig(dir, () => fn(dir));
};

// XDG_CONFIG_HOME -> dir with WORKFLOW_TOOLKIT_CONFIG* unset; restored
// afterwards; dir removed. Async-aware (config-guard awaits it).
export const withIsolatedXDG = (dir: string, fn: () => void | Promise<void>): Promise<void> => {
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
    WORKFLOW_TOOLKIT_CONFIG_DIR: process.env.WORKFLOW_TOOLKIT_CONFIG_DIR,
  };
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG;
  delete process.env.WORKFLOW_TOOLKIT_CONFIG_DIR;
  const run = () => {
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return Promise.resolve(run());
};
