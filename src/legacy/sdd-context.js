import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runScript, runScriptJson } from "./run-script.js";
import { resolveWorkspaceRoot } from "./resolve-workspace-root.js";
import { parsePlanTasks } from "./plan-tasks.js";

export function slugFromPlan(planPath) {
  return path.basename(planPath, ".md");
}

/** Cursor TodoWrite payload — UI tracking. SDD ledger is persistence, not a UI substitute. */
export function todosFromTasks(tasks, completedTaskIds = []) {
  const done = new Set(
    (completedTaskIds ?? []).map((id) => Number(id)),
  );
  const todos = (tasks ?? []).map((t) => {
    const id = Number(t.id);
    return {
      id: `task-${id}`,
      content: `Task ${id}: ${t.title ?? ""}`.trim(),
      status: done.has(id) ? "completed" : "pending",
    };
  });
  const firstPending = todos.find((t) => t.status === "pending");
  if (firstPending) firstPending.status = "in_progress";
  return todos;
}

export function sddContext({ slug, plan_path, workspace_root }) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  let resolvedSlug = slug;
  let resolvedPlanPath = plan_path;
  if (!resolvedSlug && plan_path) {
    resolvedPlanPath = path.isAbsolute(plan_path)
      ? plan_path
      : path.join(cwd, plan_path);
    resolvedSlug = slugFromPlan(resolvedPlanPath);
  }
  if (!resolvedSlug) return { error: "slug or plan_path required" };

  const ws = runScript("sdd/sdd-workspace.sh", [resolvedSlug], cwd);
  if (ws.exitCode !== 0) {
    return { error: (ws.stderr || ws.stdout || "sdd-workspace failed").trim() };
  }

  const sdd_dir = ws.stdout.trim();
  const progress_path = path.join(sdd_dir, "progress.md");
  const manifest_path = path.join(sdd_dir, "manifest.json");

  const parsed = runScriptJson("sdd/parse-progress.sh", [progress_path], cwd);
  const progress = parsed.error
    ? { progress_lines: [], completed_task_ids: [] }
    : parsed.data;

  let manifest = {};
  const absManifest = path.join(cwd, manifest_path);
  if (fs.existsSync(absManifest)) {
    manifest = JSON.parse(fs.readFileSync(absManifest, "utf8"));
  }

  const legacy_path = path.join(cwd, ".superpowers/sdd");
  const legacy_exists = fs.existsSync(legacy_path);

  const completed_task_ids = progress.completed_task_ids ?? [];
  let todos = [];
  let task_count = 0;
  if (plan_path) {
    const tasksData = parsePlanTasks(plan_path, workspace_root);
    if (!tasksData.error && Array.isArray(tasksData.tasks)) {
      task_count = tasksData.task_count ?? tasksData.tasks.length;
      todos = todosFromTasks(tasksData.tasks, completed_task_ids);
    }
  }

  return {
    slug: resolvedSlug,
    sdd_dir,
    progress_path,
    manifest_path,
    progress_lines: progress.progress_lines ?? [],
    completed_task_ids,
    manifest,
    created: true,
    forbidden_legacy_path: ".superpowers/sdd",
    legacy_sdd_exists: legacy_exists,
    warning: legacy_exists
      ? "Ignore .superpowers/sdd — use sdd_dir from this tool only"
      : undefined,
    todos,
    task_count,
    todo_write_required: true,
    todo_write_hint:
      "REQUIRED: Call Cursor TodoWrite with todos from this result (merge: false) so the native task list UI shows progress. SDD ledger is persistence only — not a UI substitute. Before each task set status in_progress; after workflow_sdd_append_progress set that todo completed.",
  };
}

export function sddTaskBrief({ sdd_dir, task_id, section_text, workspace_root }) {
  const cwd = resolveWorkspaceRoot(workspace_root);
  const tmp = path.join(
    os.tmpdir(),
    `workflow-toolkit-task-${task_id}-${process.pid}.txt`,
  );
  fs.writeFileSync(tmp, section_text, "utf8");
  try {
    const out = runScript(
      "sdd/task-brief.sh",
      [sdd_dir, String(task_id), tmp],
      cwd,
    );
    if (out.exitCode !== 0) {
      return { error: (out.stderr || out.stdout || "task-brief failed").trim() };
    }
    return { brief_path: out.stdout.trim(), task_id };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ponytail: temp file already gone */
    }
  }
}

export function sddReviewPackage({
  sdd_dir,
  base_sha,
  head_sha,
  workspace_root,
}) {
  const out = runScript(
    "sdd/review-package.sh",
    [sdd_dir, base_sha, head_sha],
    workspace_root,
  );
  if (out.exitCode !== 0) {
    return { error: (out.stderr || out.stdout || "review-package failed").trim() };
  }
  try {
    return JSON.parse(out.stdout.trim());
  } catch {
    return { error: "invalid JSON from review-package" };
  }
}

export function sddAppendProgress({ progress_path, line, workspace_root }) {
  const out = runScriptJson(
    "sdd/append-progress.sh",
    [progress_path, line],
    workspace_root,
  );
  if (out.error) return { error: out.error };
  return out.data;
}
