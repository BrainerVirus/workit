import { readFileSync } from "node:fs";
import path from "node:path";

export type DocError = { code: string; message: string; path?: string };

const BRANCH_RE = /^\s*\*+Branch:\*+\s*`?((?:feature|bugfix)\/[^`\s|]+)`?\s*$/im;
const SPEC_LINK_RE = /^\s*\*+Spec:\*+\s*(?:`([^`]+)`|(\S+))\s*$/im;
const TASK_RE = /^###\s+Task\s+(\d+):\s*(.*)$/i;

const err = (code: string, message: string, path?: string): DocError => {
  const item: DocError = { code, message };
  if (path) item.path = path;
  return item;
};

const failValidate = (
  errors: DocError[],
): { ok: false; errors: DocError[]; error: string } => ({
  ok: false,
  errors,
  error: errors.map((e) => e.message).filter(Boolean).join("; ") || "docs validation failed",
});

const readBranch = (text: string, label: string): [string | null, DocError | null] => {
  const match = text.match(BRANCH_RE);
  if (!match) return [null, err("missing_branch", `**Branch:** feature/* or bugfix/* required in ${label}`)];
  return [match[1].trim().replace(/`/g, ""), null];
};

const scanTaskHeadings = (planText: string): [number[], string[], DocError | null] => {
  const ids: number[] = [];
  const titles: string[] = [];
  let inFence = false;
  for (const line of planText.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(TASK_RE);
    if (match) { ids.push(Number(match[1])); titles.push(match[2].trim()); }
  }
  if (ids.length === 0) return [ids, titles, err("task_order", "no ### Task N sections found outside fences")];
  const expected = ids.map((_, i) => i + 1);
  const sorted = [...ids].sort((a, b) => a - b);
  if (JSON.stringify(sorted) !== JSON.stringify(expected) || new Set(ids).size !== ids.length) {
    return [ids, titles, err("task_order", `task headings must be contiguous from 1..${ids.length}; found ${ids}`)];
  }
  return [ids, titles, null];
};

// Port of scripts/lib/parse-plan-tasks.sh (JSON mode)
export const parseTasksFromPlan = (planText: string): { id: number; title: string; section_text: string }[] => {
  const tasks: { id: number; title: string; section_text: string }[] = [];
  let current: { id: number; title: string; body: string[] } | null = null;
  let inFence = false;
  for (const line of planText.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = line.match(TASK_RE);
    if (match) {
      if (current) tasks.push({ id: current.id, title: current.title, section_text: current.body.join("\n") });
      current = { id: Number(match[1]), title: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) tasks.push({ id: current.id, title: current.title, section_text: current.body.join("\n") });
  return tasks;
};

export const docsValidate = ({
  spec_path,
  plan_path,
  workspace_root,
}: {
  spec_path: string;
  plan_path: string;
  workspace_root: string;
}):
  | { ok: true; spec: string; plan: string; branch: string; task_count: number; quality: QualityFinding[] }
  | { ok: false; errors: DocError[]; error: string } => {
  const cwd = path.resolve(workspace_root);
  const specAbs = path.isAbsolute(spec_path) ? spec_path : path.join(cwd, spec_path);
  const planAbs = path.isAbsolute(plan_path) ? plan_path : path.join(cwd, plan_path);
  const errors: DocError[] = [];

  const read = (p: string): string | null => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  };

  const specText = read(specAbs);
  const planText = read(planAbs);
  if (specText === null) errors.push(err("missing_file", `spec not found: ${spec_path}`, spec_path));
  if (planText === null) errors.push(err("missing_file", `plan not found: ${plan_path}`, plan_path));
  if (errors.length) return failValidate(errors);

  const [specBranch, specErr] = readBranch(specText!, "spec");
  if (specErr) errors.push(specErr);
  const [planBranch, planErr] = readBranch(planText!, "plan");
  if (planErr) errors.push(planErr);

  const linkMatch = planText!.match(SPEC_LINK_RE);
  if (!linkMatch) {
    errors.push(err("missing_spec_link", "**Spec:** link required in plan", plan_path));
  } else {
    const linked = (linkMatch[1] ?? linkMatch[2] ?? "").trim();
    const linkedAbs = path.isAbsolute(linked) ? linked : path.join(cwd, linked);
    if (path.resolve(linkedAbs) !== path.resolve(specAbs)) {
      errors.push(err("spec_mismatch", `plan **Spec:** ${linked} does not match spec_path ${spec_path}`, plan_path));
    }
  }

  if (specBranch && planBranch && specBranch !== planBranch) {
    errors.push(err("branch_mismatch", `spec branch ${JSON.stringify(specBranch)} != plan branch ${JSON.stringify(planBranch)}`, plan_path));
  }

  const [, , taskErr] = scanTaskHeadings(planText!);
  if (taskErr) errors.push(taskErr);

  if (errors.length) return failValidate(errors);

  const tasks = parseTasksFromPlan(planText!);
  const [headingIds, headingTitles, headingErr] = scanTaskHeadings(planText!);
  if (headingErr) return failValidate([headingErr]);
  if (tasks.length !== headingIds.length) {
    return failValidate([err("task_order", `parse count ${tasks.length} != heading count ${headingIds.length}`, plan_path)]);
  }
  for (let i = 0; i < tasks.length; i++) {
    if (String(tasks[i].id) !== String(headingIds[i]) || tasks[i].title.trim() !== headingTitles[i]) {
      return failValidate([err("task_order", `task mismatch at position ${i + 1}`, plan_path)]);
    }
  }

  const relSpec = path.isAbsolute(spec_path) ? path.relative(cwd, specAbs) : spec_path;
  const relPlan = path.isAbsolute(plan_path) ? path.relative(cwd, planAbs) : plan_path;
  return {
    ok: true,
    spec: relSpec,
    plan: relPlan,
    branch: specBranch!,
    task_count: tasks.length,
    quality: qualitySpec(specText!),
  };
};

export type QualityFinding = {
  code: string;
  message: string;
  severity: "warning" | "hard";
};

const REQUIRED_SECTIONS = [
  "## Context",
  "## Goals",
  "## Non-goals",
  "## Architecture",
  "## Acceptance criteria",
];

const UI_KEYWORDS = [/\bui\b/, /\binterface\b/, /\bscreen\b/, /\bmodal\b/, /\bform\b/, /\bcomponent\b/];
const FLOW_KEYWORDS = [/\bflow\b/, /\bpipeline\b/, /\bsequence\b/, /\bdiagram\b/];
const GLOSSARY_KEYWORDS = [/\bglossary\b/, /\bcontracts?\b/, /\bscope\b/];

const finding = (code: string, message: string, severity: "warning" | "hard"): QualityFinding =>
  ({ code, message, severity });

// Replace fenced code blocks with a single marker line so their content cannot
// satisfy the checks, but the fence itself (and its language) stays detectable.
const stripFences = (text: string): string => {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inFence) out.push(line); // opening fence: keep the ```lang marker
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
};

export const qualitySpec = (text: string): QualityFinding[] => {
  const findings: QualityFinding[] = [];
  const body = stripFences(text);
  const lower = body.toLowerCase();

  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(section)) {
      findings.push(finding("missing_section", `required section ${section} missing`, "hard"));
    }
  }

  const hasCa = /^\s*(?:- CA-\d+|CA-\d+[.:])/m.test(body); // M1: ^ with /m covers line starts
  if (!hasCa) {
    findings.push(finding("missing_acceptance_criteria", "no enumerable CA-XX acceptance criteria found", "hard"));
  }

  const hasAsciiFence = /```(?:text|ascii)/.test(body);
  const mentionsUi = UI_KEYWORDS.some((k) => k.test(lower));
  if (mentionsUi && !hasAsciiFence) {
    findings.push(finding("missing_ascii_for_ui", "spec mentions UI but has no ASCII wireframe fence", "warning"));
  }

  const hasMermaid = /```mermaid/.test(body);
  const explicitlyNoFlow = /\bno (?:flow|pipeline|sequence|diagram)\b/.test(lower);
  const mentionsFlow = FLOW_KEYWORDS.some((k) => k.test(lower));
  if (mentionsFlow && !hasMermaid && !explicitlyNoFlow) {
    findings.push(finding("missing_mermaid_for_flow", "spec describes a flow/pipeline/sequence but has no mermaid fence", "warning"));
  }

  const hasTable = /^\s*\|.+\|.+\|/m.test(body);
  const mentionsGlossary = GLOSSARY_KEYWORDS.some((k) => k.test(lower));
  const onlyOutOfScope = /\bout of scope\b/.test(lower) && !/\bglossary\b/.test(lower) && !/\bcontracts?\b/.test(lower);
  if (mentionsGlossary && !hasTable && !onlyOutOfScope) {
    findings.push(finding("missing_table", "spec has glossary/contract/scope content but no markdown table", "warning"));
  }

  return findings;
};
