import { readFileSync } from "node:fs";
import path from "node:path";
import { parseTasksFromPlan } from "./docs-validate";
import { resolveBranch } from "./branch";

const readSafe = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

export function parsePlanTasks(
  planPath: string,
  workspaceRoot: string,
): { task_count: number; tasks: { id: number; title: string; section_text: string }[] } | { error: string } {
  const cwd = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  const text = readSafe(resolved);
  if (text === null) return { error: `plan file not found: ${planPath}` };
  const tasks = parseTasksFromPlan(text);
  if (tasks.length === 0) {
    return { error: "no ### Task N sections found — plan must follow writing-plans format" };
  }
  return { task_count: tasks.length, tasks };
}

export function resolveHandoffBranch(
  specPath: string,
  planPath: string,
  workspaceRoot: string,
): { branch: string } | { error: string } {
  const resolved = resolveBranch({ spec_path: specPath, plan_path: planPath, workspace_root: workspaceRoot });
  if ("error" in resolved) return { error: resolved.error as string };
  return { branch: resolved.branch };
}
