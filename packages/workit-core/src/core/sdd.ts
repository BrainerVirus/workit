import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseTasksFromPlan } from "./docs-validate";
import { docsValidate } from "./docs-validate";
import { readFlowState } from "./flow-state";
import { resolveCanonicalLayout, resolveDocsPath } from "./docs-layout";

const posix = (p: string) => p.split(path.sep).join("/");

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
  // One shared contained path contract (DC-01, DC-02): slug and/or plan_path
  // resolve to a canonical layout or the call fails before anything is read.
  const resolved = resolveCanonicalLayout({ workspace_root, slug, plan_path });
  if (!resolved.ok) return { error: resolved.error };
  const cwd = resolved.layout.workspace;
  const resolvedSlug = resolved.layout.slug;
  if (!resolvedSlug) return { error: "slug or plan_path required" };

  const sdd_dir = path.posix.join("docs", resolvedSlug, "sdd");
  const progress_path = path.posix.join(sdd_dir, "progress.md");
  const manifest_path = path.posix.join(sdd_dir, "manifest.json");

  let progress_lines: string[] = [];
  let completed_task_ids: number[] = [];
  const absProgress = path.join(resolved.layout.sdd, "progress.md");
  if (existsSync(absProgress)) {
    progress_lines = readFileSync(absProgress, "utf8")
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean);
    const pat = /^Task\s+(\d+):\s+complete\b/i;
    completed_task_ids = progress_lines
      .map((ln) => pat.exec(ln)?.[1])
      .filter(Boolean)
      .map(Number);
  }

  let manifest: Record<string, unknown> = {};
  const absManifest = path.join(resolved.layout.sdd, "manifest.json");
  if (existsSync(absManifest)) {
    try {
      manifest = JSON.parse(readFileSync(absManifest, "utf8"));
    } catch {
      manifest = {};
    }
  }

  const legacy_path = path.join(cwd, ".superpowers/sdd");
  const legacy_exists = existsSync(legacy_path);

  let todos: { id: string; content: string; status: string }[] = [];
  let task_count = 0;
  if (plan_path) {
    const planText = readFileSync(resolved.layout.plan, "utf8");
    const specMatch = planText.match(/^\*\*Spec:\*\*\s*(?:`([^`]+)`|(\S+))/m);
    const spec_path = specMatch?.[1] ?? specMatch?.[2] ?? "";
    if (spec_path) {
      const validated = docsValidate({
        spec_path,
        plan_path: path.relative(cwd, resolved.layout.plan),
        workspace_root: cwd,
      });
      if (validated.ok === false)
        return { ok: false, errors: validated.errors, error: validated.error };
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
  const contained = resolveDocsPath({ workspace_root, path: sdd_dir });
  if (!contained.ok) return { error: contained.error };
  const dir = contained.path;
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `task-${task_id}-brief.md`);
  writeFileSync(out, `# Task ${task_id} brief\n\n${section_text}\n`, "utf8");
  const rel = posix(path.relative(contained.base, out));
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
  const contained = resolveDocsPath({ workspace_root, path: sdd_dir });
  if (!contained.ok) return { error: contained.error };
  const dir = contained.path;
  mkdirSync(dir, { recursive: true });
  const base7 = base_sha.slice(0, 7);
  const head7 = head_sha.slice(0, 7);
  const diffPath = path.join(dir, `review-${base7}..${head7}.diff`);
  try {
    const diff = execFileSync("git", ["diff", base_sha, head_sha], {
      cwd: contained.base,
      encoding: "utf8",
    });
    writeFileSync(diffPath, diff, "utf8");
    const rel = posix(path.relative(contained.base, diffPath));
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
  const contained = resolveDocsPath({ workspace_root, path: progress_path });
  if (!contained.ok) return { error: contained.error };
  const path_ = contained.path;
  const trimmed = line.trim();
  if (!PROGRESS_RE.test(trimmed)) {
    return { error: "invalid progress line format" };
  }
  if (existsSync(path_) && statSync(path_).isDirectory()) {
    return { error: `progress path is a directory: ${progress_path}` };
  }
  mkdirSync(path.dirname(path_), { recursive: true });
  appendFileSync(path_, trimmed + "\n", "utf8");
  const rel = posix(path.relative(contained.base, path_));
  return { ok: true, line: trimmed, progress_path: rel };
}
