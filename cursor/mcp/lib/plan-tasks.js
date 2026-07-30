import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PLUGIN_ROOT } from './plugin-root.js';
import { resolveWorkspaceRoot } from './resolve-workspace-root.js';

function runBashScript(scriptRel, args, workspaceRoot) {
  const cwd = resolveWorkspaceRoot(workspaceRoot);
  const script = path.join(PLUGIN_ROOT, scriptRel);
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return {
      error: (result.stderr || result.stdout || 'script failed').trim(),
      exitCode: result.status ?? 1,
    };
  }
  return { stdout: (result.stdout ?? '').trim() };
}

export function parsePlanTasks(planPath, workspaceRoot) {
  const cwd = resolveWorkspaceRoot(workspaceRoot);
  const resolved = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  const result = runBashScript('scripts/lib/parse-plan-tasks.sh', [resolved, '--format=json'], cwd);
  if (result.error) return result;
  return JSON.parse(result.stdout);
}

export function resolveHandoffBranch(specPath, planPath, workspaceRoot) {
  const cwd = resolveWorkspaceRoot(workspaceRoot);
  const spec = path.isAbsolute(specPath) ? specPath : path.join(cwd, specPath);
  const plan = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  const result = runBashScript('scripts/lib/resolve-handoff-branch.sh', [spec, plan], cwd);
  if (result.error) return result;
  return { branch: result.stdout };
}
