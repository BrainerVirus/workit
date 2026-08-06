import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(dirname, "../..");

export const resolveWorkspaceRoot = (explicit?: string) => explicit || process.cwd();

export function runScript(
  scriptName: string,
  args: string[],
  workspaceRoot: string,
  extraEnv?: Record<string, string>,
) {
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

export function runScriptJson(scriptName: string, args: string[], workspaceRoot: string) {
  const { stdout, stderr, exitCode } = runScript(scriptName, args, workspaceRoot);
  if (exitCode !== 0) {
    return { error: (stderr || stdout || "script failed").trim(), exitCode };
  }
  try {
    return { data: JSON.parse(stdout.trim()) };
  } catch {
    return { error: "invalid JSON from script", raw: stdout.trim() };
  }
}
