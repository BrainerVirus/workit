import { spawnSync } from "node:child_process";
import path from "node:path";
import { PLUGIN_ROOT } from "./scripts";
import { runScript, runScriptJson } from "./scripts";

function runInitScript(script: string, args: string[], env: Record<string, string> = {}): Record<string, any> {
  const scriptPath = path.join(PLUGIN_ROOT, "scripts", "init", script);
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    return {
      error: (result.stderr || result.stdout || "init script failed").trim(),
    };
  }
  try {
    return { data: JSON.parse((result.stdout ?? "").trim()) };
  } catch {
    return { data: { raw: (result.stdout ?? "").trim() } };
  }
}

export function initStatus(): Record<string, any> {
  const result = runScriptJson("init/status.sh", [], PLUGIN_ROOT);
  if (result.error) return { error: result.error };
  return result.data;
}

export function toolkitStatus(): Record<string, any> {
  const result = runScriptJson("init/toolkit-status.sh", [], PLUGIN_ROOT);
  if (result.error) return { error: result.error };
  return result.data;
}

export function initApply({ action, confirmed, env }: { action: string; confirmed: boolean; env?: Record<string, string> }): Record<string, any> {
  if (!confirmed) return { error: "confirmed: true required" };

  const scriptPath = path.join(PLUGIN_ROOT, "scripts", "init", "apply.sh");
  const result = spawnSync("bash", [scriptPath, action, "true"], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  });
  if (result.status !== 0) {
    return { error: (result.stderr || result.stdout || "apply failed").trim() };
  }
  try {
    return { data: JSON.parse((result.stdout ?? "").trim()) };
  } catch {
    return { data: { action, ok: true } };
  }
}
