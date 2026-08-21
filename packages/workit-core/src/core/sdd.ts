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

/** SDD ledger completeness facts shared by lifecycle migration, completion,
 *  and active-plan detection (Task 2). */
export type LedgerCompletion = {
  /** True only when progress.md contains at least one `Task N:` record. */
  started: boolean;
  /** True only when every canonical plan task id appears completed. */
  complete: boolean;
  required: number[];
  completed: number[];
  missing: number[];
};

/**
 * Read the canonical `docs/<slug>/sdd/progress.md` ledger and the plan's
 * `### Task N:` headings. Fail-closed: a missing or unreadable ledger yields
 * `started: false`, and a missing/unreadable plan yields an empty `required`
 * set (never a partial trust of a stale ledger). `complete` requires a
 * non-empty required set fully covered by completed task ids, so an empty plan
 * can never read as "done".
 */
export function ledgerCompletion(root: string, slug: string): LedgerCompletion {
  let started = false;
  const completed: number[] = [];
  const absProgress = path.join(root, "docs", slug, "sdd", "progress.md");
  if (existsSync(absProgress)) {
    try {
      for (const line of readFileSync(absProgress, "utf8").split("\n")) {
        const match = /^Task\s+(\d+):/i.exec(line);
        if (match) {
          started = true;
          if (/^Task\s+\d+:\s*complete\b/i.test(line)) completed.push(Number(match[1]));
        }
      }
    } catch {
      // unreadable ledger: started stays false (fail-closed)
    }
  }
  const required: number[] = [];
  try {
    const absPlan = path.join(root, "docs", slug, "plan.md");
    if (existsSync(absPlan)) {
      for (const task of parseTasksFromPlan(readFileSync(absPlan, "utf8"))) required.push(task.id);
    }
  } catch {
    // unreadable/missing plan: required stays empty (fail-closed)
  }
  const completedSet = new Set(completed);
  const missing = required.filter((id) => !completedSet.has(id));
  return {
    started,
    complete: required.length > 0 && missing.length === 0,
    required,
    completed,
    missing,
  };
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
  // Empty-range guard (Phase 2): a review package over `base..head` where the
  // endpoints collapse to nothing is a contract error, not an artifact. Reject
  // BEFORE any diff file is created or written (Task 1's RED evidence watches
  // the guard, and the adapters only surface this core error — never a copy).
  if (base_sha === head_sha) {
    return {
      error: `empty commit range (base_sha ${base_sha} === head_sha ${head_sha}): nothing to review`,
      code: "empty_commit_range",
    };
  }
  const dir = contained.path;
  const base7 = base_sha.slice(0, 7);
  const head7 = head_sha.slice(0, 7);
  const diffPath = path.join(dir, `review-${base7}..${head7}.diff`);
  try {
    const diff = execFileSync("git", ["diff", base_sha, head_sha], {
      cwd: contained.base,
      encoding: "utf8",
      // AR-14: a failed diff (missing shas, non-repo fixture) must stay in the
      // captured error, never in the suite output.
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Distinct shas that still diff to nothing are an empty range too (the
    // "or a diff that is empty" clause): no artifact is written for it, and
    // the sdd/ dir is created only once a real diff survives (an empty-range
    // rejection must leave no directory behind).
    if (diff.trim() === "") {
      return {
        error: `empty commit range (${base_sha}..${head_sha}): diff is empty, nothing to review`,
        code: "empty_commit_range",
      };
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(diffPath, diff, "utf8");
    const rel = posix(path.relative(contained.base, diffPath));
    return { diff_path: rel, base_sha, head_sha, base7, head7 };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "git diff failed" };
  }
}

const PROGRESS_RE = /^Task\s+\d+:\s+complete\s+\(commits\s+([0-9a-f]{7,40})\.\.([0-9a-f]{7,40}),/i;

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
  const match = PROGRESS_RE.exec(trimmed);
  // A regex alone cannot compare two groups: reject identical base/head shas
  // after the format matches so `5db04ae..bd0a810` still passes while
  // `abcdef0123456789..abcdef0123456789` is rejected (Phase 2).
  if (!match || match[1].toLowerCase() === match[2].toLowerCase()) {
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

export type AdvisoryResult =
  | { ok: true; advisory: string; advisories_path: string }
  | { error: string; code: string };

export function sddAppendAdvisory({
  advisories_path,
  task_id,
  text,
  workspace_root,
}: {
  advisories_path: string;
  task_id: unknown;
  text: unknown;
  workspace_root: string;
}): AdvisoryResult {
  if (typeof task_id !== "number" || !Number.isInteger(task_id) || !Number.isSafeInteger(task_id) || task_id <= 0) {
    return { error: "task_id must be a positive safe integer", code: "advisory_task_invalid" };
  }
  if (typeof text !== "string") {
    return { error: "advisory text must be a string of 1-1000 characters after normalization", code: "advisory_text_invalid" };
  }
  if (text.includes("\r") || text.includes("\n")) {
    return { error: "advisory text must be a single line (no CR/LF)", code: "advisory_text_invalid" };
  }
  const collapsed = text.trim().replace(/[ \t]+/g, " ");
  if (collapsed.length === 0 || collapsed.length > 1000) {
    return { error: "advisory text must be 1-1000 characters after trim and horizontal-space collapse", code: "advisory_text_invalid" };
  }
  const advisoriesNorm = advisories_path.split(path.sep).join("/");
  if (advisoriesNorm !== posix(advisories_path)) {
    return { error: `advisories_path must be canonical docs/<slug>/sdd/advisories.md: ${advisories_path}`, code: "advisory_path_invalid" };
  }
  if (!/^docs\/[^/]+\/sdd\/advisories\.md$/.test(advisoriesNorm)) {
    return { error: `advisories_path must be docs/<slug>/sdd/advisories.md: ${advisories_path}`, code: "advisory_path_invalid" };
  }
  const contained = resolveDocsPath({ workspace_root, path: advisories_path });
  if (!contained.ok) return { error: contained.error, code: "advisory_path_invalid" };
  const abs = contained.path;
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return { error: `advisory target is a directory: ${advisories_path}`, code: "advisory_target_invalid" };
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  const line = `- Task ${task_id}: ${collapsed}\n`;
  appendFileSync(abs, line, "utf8");
  const rel = posix(path.relative(contained.base, abs));
  return { ok: true, advisory: collapsed, advisories_path: rel };
}
