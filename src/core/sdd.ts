import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseTasksFromPlan } from "./docs-validate";
import { docsValidate } from "./docs-validate";
import { readFlowState } from "./flow-state";

export function slugFromPlan(planPath: string) {
  return path.basename(planPath, ".md");
}

/** OpenCode todowrite payload. SDD ledger is persistence, not a UI substitute. */
export function todosFromTasks(
  tasks: { id: number | string; title: string }[],
  completedTaskIds: (number | string)[] = [],
) {
  const done = new Set((completedTaskIds ?? []).map((id) => Number(id)));
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

export function sddContext({
  slug,
  plan_path,
  workspace_root,
}: {
  slug?: string;
  plan_path?: string;
  workspace_root: string;
}) {
  const cwd = path.resolve(workspace_root);
  let resolvedSlug = slug;
  let resolvedPlanPath = plan_path;
  if (!resolvedSlug && plan_path) {
    resolvedPlanPath = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
    resolvedSlug = slugFromPlan(resolvedPlanPath);
  }
  if (!resolvedSlug) return { error: "slug or plan_path required" };

  const sdd_dir = path.join("docs/superpowers/sdd", resolvedSlug);
  const progress_path = path.join(sdd_dir, "progress.md");
  const manifest_path = path.join(sdd_dir, "manifest.json");

  let progress_lines: string[] = [];
  let completed_task_ids: number[] = [];
  const absProgress = path.join(cwd, progress_path);
  if (existsSync(absProgress)) {
    progress_lines = readFileSync(absProgress, "utf8").split("\n").map((ln) => ln.trim()).filter(Boolean);
    const pat = /^Task\s+(\d+):\s+complete\b/i;
    completed_task_ids = progress_lines
      .map((ln) => pat.exec(ln)?.[1])
      .filter(Boolean)
      .map(Number);
  }

  let manifest: Record<string, unknown> = {};
  const absManifest = path.join(cwd, manifest_path);
  if (existsSync(absManifest)) {
    try { manifest = JSON.parse(readFileSync(absManifest, "utf8")); } catch { manifest = {}; }
  }

  const legacy_path = path.join(cwd, ".superpowers/sdd");
  const legacy_exists = existsSync(legacy_path);

  let todos: { id: string; content: string; status: string }[] = [];
  let task_count = 0;
  if (plan_path) {
    const absPlan = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
    const planText = readFileSync(absPlan, "utf8");
    const specMatch = planText.match(/^\*\*Spec:\*\*\s*(?:`([^`]+)`|(\S+))/m);
    const spec_path = specMatch?.[1] ?? specMatch?.[2] ?? "";
    if (spec_path) {
      const validated = docsValidate({ spec_path, plan_path, workspace_root: cwd });
      if (validated.ok === false) return { ok: false, errors: validated.errors, error: validated.error };
    }
    const tasks = parseTasksFromPlan(planText);
    if (tasks.length > 0) {
      task_count = tasks.length;
      todos = todosFromTasks(tasks, completed_task_ids);
    }
  }

  const flow = readFlowState(cwd, resolvedSlug);

  return {
    slug: resolvedSlug,
    sdd_dir,
    progress_path,
    manifest_path,
    progress_lines,
    completed_task_ids,
    manifest,
    created: existsSync(path.join(cwd, sdd_dir)),
    forbidden_legacy_path: ".superpowers/sdd",
    legacy_sdd_exists: legacy_exists,
    warning: legacy_exists
      ? "Ignore .superpowers/sdd — use sdd_dir from this tool only"
      : undefined,
    todos,
    task_count,
    flow: { spec: flow.spec, plan: flow.plan, menu: flow.menu },
    todowrite_required: true,
    todowrite_hint:
      "REQUIRED: Call OpenCode todowrite with todos from this result so the native task list shows progress. Before each task set status in_progress; after workflow_sdd_append_progress set it completed.",
  };
}

export function sddTaskBrief({
  sdd_dir,
  task_id,
  section_text,
  workspace_root,
}: {
  sdd_dir: string;
  task_id: number;
  section_text: string;
  workspace_root: string;
}) {
  const cwd = path.resolve(workspace_root);
  const dir = path.isAbsolute(sdd_dir) ? sdd_dir : path.join(cwd, sdd_dir);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `task-${task_id}-brief.md`);
  writeFileSync(out, `# Task ${task_id} brief\n\n${section_text}\n`, "utf8");
  const rel = path.relative(cwd, out);
  return { brief_path: rel, task_id };
}

export function sddReviewPackage({
  sdd_dir,
  base_sha,
  head_sha,
  workspace_root,
}: {
  sdd_dir: string;
  base_sha: string;
  head_sha: string;
  workspace_root: string;
}) {
  const cwd = path.resolve(workspace_root);
  const dir = path.isAbsolute(sdd_dir) ? sdd_dir : path.join(cwd, sdd_dir);
  mkdirSync(dir, { recursive: true });
  const base7 = base_sha.slice(0, 7);
  const head7 = head_sha.slice(0, 7);
  const diffPath = path.join(dir, `review-${base7}..${head7}.diff`);
  try {
    const diff = execFileSync("git", ["diff", base_sha, head_sha], { cwd, encoding: "utf8" });
    writeFileSync(diffPath, diff, "utf8");
    const rel = path.relative(cwd, diffPath);
    return { diff_path: rel, base_sha, head_sha, base7, head7 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "git diff failed" };
  }
}

const PROGRESS_RE = /^Task\s+\d+:\s+complete\s+\(commits\s+[0-9a-f]{7,40}\.\.[0-9a-f]{7,40},/i;

export function sddAppendProgress({
  progress_path,
  line,
  workspace_root,
}: {
  progress_path: string;
  line: string;
  workspace_root: string;
}) {
  const cwd = path.resolve(workspace_root);
  const path_ = path.isAbsolute(progress_path) ? progress_path : path.join(cwd, progress_path);
  const trimmed = line.trim();
  if (!PROGRESS_RE.test(trimmed)) {
    return { error: "invalid progress line format" };
  }
  mkdirSync(path.dirname(path_), { recursive: true });
  appendFileSync(path_, trimmed + "\n", "utf8");
  const rel = path.relative(cwd, path_);
  return { ok: true, line: trimmed, progress_path: rel };
}
