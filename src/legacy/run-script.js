import { spawnSync } from "node:child_process";
import path from "node:path";
import { PLUGIN_ROOT } from "./plugin-root.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";

export function runScript(scriptName, args, workspaceRoot, extraEnv) {
  const cwd = resolveWorkspaceRoot(workspaceRoot);
  const scriptPath = path.join(PLUGIN_ROOT, "scripts", scriptName);
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
    scriptPath,
    cwd,
  };
}

export function runScriptJson(scriptName, args, workspaceRoot) {
  const { stdout, stderr, exitCode } = runScript(
    scriptName,
    args,
    workspaceRoot,
  );
  if (exitCode !== 0) {
    return { error: (stderr || stdout || "script failed").trim(), exitCode };
  }
  try {
    return { data: JSON.parse(stdout.trim()) };
  } catch {
    return { error: "invalid JSON from script", raw: stdout.trim() };
  }
}
