import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type FlowStatus = "draft" | "self_reviewed" | "approved";
export type FlowDocState = { path: string; status: FlowStatus };
export type FlowState = {
  slug: string;
  spec: FlowDocState;
  plan: FlowDocState;
  menu: { presented: boolean; chosen: string };
  updated_at: number;
};

type Result = { ok: true } | { ok: false; error: string };

const flowPath = (root: string, slug: string) =>
  path.join(root, "docs/superpowers/sdd", slug, "flow.json");

export const readFlowState = (root: string, slug: string): FlowState => {
  const file = flowPath(root, slug);
  if (!existsSync(file)) {
    return {
      slug,
      spec: { path: "", status: "draft" },
      plan: { path: "", status: "draft" },
      menu: { presented: false, chosen: "" },
      updated_at: Date.now(),
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<FlowState>;
    return {
      slug: parsed.slug ?? slug,
      spec: { path: parsed.spec?.path ?? "", status: parsed.spec?.status ?? "draft" },
      plan: { path: parsed.plan?.path ?? "", status: parsed.plan?.status ?? "draft" },
      menu: { presented: Boolean(parsed.menu?.presented), chosen: parsed.menu?.chosen ?? "" },
      updated_at: parsed.updated_at ?? Date.now(),
    };
  } catch {
    return {
      slug,
      spec: { path: "", status: "draft" },
      plan: { path: "", status: "draft" },
      menu: { presented: false, chosen: "" },
      updated_at: Date.now(),
    };
  }
};

export const writeFlowState = (root: string, state: FlowState) => {
  const file = flowPath(root, state.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
};

const nextStatus = (current: FlowStatus, confirmed: boolean): Result & { next?: FlowStatus } => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  if (current === "draft") return { ok: true, next: "self_reviewed" };
  if (current === "self_reviewed") return { ok: true, next: "approved" };
  return { ok: false, error: "already approved; no further transitions" };
};

export const transitionSpec = (
  root: string,
  slug: string,
  specPath: string,
  confirmed: boolean,
): Result => {
  const state = readFlowState(root, slug);
  const step = nextStatus(state.spec.status, confirmed);
  if (!step.ok || !step.next) return { ok: false, error: step.error };
  writeFlowState(root, {
    ...state,
    spec: { path: specPath, status: step.next },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const transitionPlan = (
  root: string,
  slug: string,
  planPath: string,
  confirmed: boolean,
): Result => {
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return { ok: false, error: "spec must be approved before the plan can be approved" };
  }
  const step = nextStatus(state.plan.status, confirmed);
  if (!step.ok || !step.next) return { ok: false, error: step.error };
  writeFlowState(root, {
    ...state,
    plan: { path: planPath, status: step.next },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const recordMenuChoice = (
  root: string,
  slug: string,
  planPath: string,
  choice: string,
  confirmed: boolean,
): Result => {
  if (!confirmed) return { ok: false, error: "confirmed: true required" };
  const state = readFlowState(root, slug);
  writeFlowState(root, {
    ...state,
    plan: state.plan.path ? state.plan : { path: planPath, status: state.plan.status },
    menu: { presented: true, chosen: choice },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const slugFromPath = (p: string) =>
  path.basename(p, ".md").replace(/-design$/, "");

export const assertFlowGates = (
  root: string,
  planPath: string,
  opts: { requireMenu?: boolean } = {},
): Result => {
  const slug = slugFromPath(planPath);
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return {
      ok: false,
      error: `spec not approved (status: ${state.spec.status}). Run workflow_spec_approve after the user's approval.`,
    };
  }
  if (state.plan.status !== "approved") {
    return {
      ok: false,
      error: `plan not approved (status: ${state.plan.status}). Run workflow_plan_approve after the user's approval.`,
    };
  }
  if (opts.requireMenu && !state.menu.presented) {
    return {
      ok: false,
      error:
        "post-plan menu not presented. Ask the native question menu (Subagent-driven/Inline/Handoff/Review spec/Review plan) and record the answer with workflow_plan_menu.",
    };
  }
  return { ok: true };
};
