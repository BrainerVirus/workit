import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { docsValidate, parseTasksFromPlan, qualitySpec, stripFences } from "./docs-validate";
import { resolveCanonicalLayout } from "./docs-layout";

export type FlowHost = "opencode" | "cursor";
export type FlowStatus = "draft" | "self_reviewed" | "approved";

/**
 * The only acceptable approval / execution-menu evidence (FG-04, CA-19): an
 * answered native question result. Host adapters record the host, the question
 * identifier, the exact label the user selected, and when it was answered.
 * Bare booleans and agent-typed confirmations are never evidence.
 */
export type NativeChoiceEvidence = {
  host: FlowHost;
  questionId: string;
  selectedLabel: string;
  recordedAt: number;
};

export type FlowDocState = {
  path: string;
  status: FlowStatus;
  evidence?: NativeChoiceEvidence | null;
};

export type FlowMenuState = {
  presented: boolean;
  chosen: string;
  evidence?: NativeChoiceEvidence | null;
};

export type FlowState = {
  slug: string;
  /** Recorded when flow preparation began (FG-01): canonical paths + activation. */
  activated: boolean;
  spec: FlowDocState;
  plan: FlowDocState;
  menu: FlowMenuState;
  updated_at: number;
};

/** One shared result shape for every flow transition and mutation gate (FG-09). */
export type FlowError = { ok: false; error: string; code: string };
export type FlowGateResult = { ok: true } | FlowError;
export type EvidenceResult =
  | { ok: true; evidence: NativeChoiceEvidence }
  | { ok: false; error: string };
export type StatusTransition = { ok: true; next: FlowStatus } | FlowError;

export const MENU_CHOICES = [
  "subagent-driven",
  "inline",
  "handoff",
  "review-spec",
  "review-plan",
] as const;
export type MenuChoice = (typeof MENU_CHOICES)[number];

const err = (code: string, error: string): FlowError => ({ ok: false, code, error });

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const flowPath = (root: string, slug: string) => {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  return path.join(root, "docs", slug, "sdd", "flow.json");
};

// Resolve one spec/plan doc path under the shared contained contract (DC-01,
// DC-02): the caller-supplied slug must match the slug derived from the path.
const resolveDoc = (
  root: string,
  slug: string,
  docPath: string,
  kind: "spec" | "plan",
): { ok: true; path: string } | { ok: false; error: string } => {
  const resolved = resolveCanonicalLayout({
    workspace_root: root,
    ...(slug ? { slug } : {}),
    [kind === "spec" ? "spec_path" : "plan_path"]: docPath,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, path: resolved.layout[kind === "spec" ? "spec" : "plan"] };
};

// A flow.json that exists was activated when preparation began; the field is
// kept for forward compatibility but a present file is always treated as
// activated. Missing state is NOT silently activated (FG-01).
const normalizeState = (parsed: unknown, slug: string): FlowState => {
  const p = (parsed ?? {}) as Partial<FlowState>;
  const spec = (p.spec ?? {}) as Partial<FlowDocState>;
  const plan = (p.plan ?? {}) as Partial<FlowDocState>;
  const menu = (p.menu ?? {}) as Partial<FlowMenuState>;
  return {
    slug: p.slug ?? slug,
    activated: p.activated ?? true,
    spec: {
      path: spec.path ?? "",
      status: spec.status ?? "draft",
      evidence: spec.evidence ?? null,
    },
    plan: {
      path: plan.path ?? "",
      status: plan.status ?? "draft",
      evidence: plan.evidence ?? null,
    },
    menu: {
      presented: Boolean(menu.presented),
      chosen: menu.chosen ?? "",
      evidence: menu.evidence ?? null,
    },
    updated_at: p.updated_at ?? Date.now(),
  };
};

const emptyState = (slug: string): FlowState => ({
  slug,
  activated: false,
  spec: { path: "", status: "draft", evidence: null },
  plan: { path: "", status: "draft", evidence: null },
  menu: { presented: false, chosen: "", evidence: null },
  updated_at: Date.now(),
});

export const readFlowState = (root: string, slug: string): FlowState => {
  const file = flowPath(root, slug);
  if (!existsSync(file)) return emptyState(slug);
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")), slug);
  } catch {
    return emptyState(slug);
  }
};

// Strict read for transitions and guards: missing or corrupt state is a
// structured error, never a silent draft fallback (CA-18).
type StrictRead = { ok: true; state: FlowState } | { ok: false; error: string; code: string };

const readFlowStrict = (root: string, slug: string): StrictRead => {
  const file = flowPath(root, slug);
  if (!existsSync(file)) {
    return err(
      "flow_not_activated",
      `flow not activated for ${slug} — run workflow_docs_layout prepare or workflow_flow_status first`,
    );
  }
  try {
    return { ok: true, state: normalizeState(JSON.parse(readFileSync(file, "utf8")), slug) };
  } catch (error) {
    return err(
      "flow_corrupt",
      `corrupt flow state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const writeFlowState = (root: string, state: FlowState) => {
  const file = flowPath(root, state.slug);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
};

/**
 * The shared transition matrix (FG-09): draft -> self_reviewed -> approved for
 * both the spec and the plan. Errors use the same FlowGateResult shape as
 * every mutation guard.
 */
export const nextFlowStatus = (current: FlowStatus): StatusTransition => {
  if (current === "draft") return { ok: true, next: "self_reviewed" };
  if (current === "self_reviewed") return { ok: true, next: "approved" };
  return err("flow_already_approved", "already approved; no further transitions");
};

const MAX_CLOCK_SKEW_MS = 60_000;
const EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const createNativeChoiceEvidence = (input: unknown): EvidenceResult => {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      error:
        "native choice evidence required — bare booleans and other primitives are not approval evidence",
    };
  }
  const { host, questionId, selectedLabel, recordedAt } = input as Record<string, unknown>;
  if (host !== "opencode" && host !== "cursor") {
    return {
      ok: false,
      error: `evidence host must be 'opencode' or 'cursor', got ${JSON.stringify(host)}`,
    };
  }
  if (typeof questionId !== "string" || questionId.trim() === "") {
    return { ok: false, error: "evidence questionId must be a non-empty string" };
  }
  if (typeof selectedLabel !== "string" || selectedLabel.trim() === "") {
    return {
      ok: false,
      error:
        "evidence selectedLabel must be the exact label the user selected on the native question",
    };
  }
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt) || recordedAt <= 0) {
    return { ok: false, error: "evidence recordedAt must be a positive epoch-ms timestamp" };
  }
  const now = Date.now();
  if (recordedAt > now + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "evidence recordedAt is in the future — forged evidence is rejected",
    };
  }
  if (now - recordedAt > EVIDENCE_WINDOW_MS) {
    return {
      ok: false,
      error:
        "evidence recordedAt is too old — ask the native question again and re-record the answer",
    };
  }
  return {
    ok: true,
    evidence: { host, questionId, selectedLabel: selectedLabel.trim(), recordedAt },
  };
};

/** Shared host-adapter entry point: both hosts call this with their own tag. */
export const createFlowEvidence = (
  host: FlowHost,
  questionId: string,
  selectedLabel: string,
  recordedAt: number = Date.now(),
): EvidenceResult => createNativeChoiceEvidence({ host, questionId, selectedLabel, recordedAt });

/** Host provenance binding: OpenCode only accepts opencode evidence, and vice versa. */
export const assertHostEvidence = (host: FlowHost, evidence: unknown): FlowGateResult => {
  if (typeof evidence !== "object" || evidence === null) {
    return err(
      "evidence_invalid",
      "native choice evidence required — bare booleans and other primitives are not approval evidence",
    );
  }
  const { host: recorded } = evidence as Record<string, unknown>;
  if (recorded !== host) {
    return err(
      "evidence_host_mismatch",
      `evidence was recorded on ${JSON.stringify(recorded)}, not ${host} — forged or misattributed evidence is rejected`,
    );
  }
  return { ok: true };
};

/**
 * Record flow activation and the canonical spec/plan paths when preparation
 * begins. The flow store lives under the canonical docs/<slug>/sdd/ layout
 * (Task 18 contract). Re-runs keep existing statuses while recording paths.
 */
export const prepareFlowState = (
  root: string,
  slug: string,
  opts: { spec_path?: string; plan_path?: string } = {},
): FlowGateResult => {
  const resolved = resolveCanonicalLayout({
    workspace_root: root,
    slug,
    spec_path: opts.spec_path,
    plan_path: opts.plan_path,
  });
  if (!resolved.ok) return err("flow_prepare_failed", resolved.error);
  const specPath = path.posix.join("docs", slug, "spec.md");
  const planPath = path.posix.join("docs", slug, "plan.md");
  const current = readFlowState(root, slug);
  const state: FlowState = current.activated
    ? {
        ...current,
        spec: { ...current.spec, path: specPath },
        plan: { ...current.plan, path: planPath },
        updated_at: Date.now(),
      }
    : {
        slug,
        activated: true,
        spec: { path: specPath, status: "draft", evidence: null },
        plan: { path: planPath, status: "draft", evidence: null },
        menu: { presented: false, chosen: "", evidence: null },
        updated_at: Date.now(),
      };
  writeFlowState(root, state);
  return { ok: true };
};

export const transitionSpec = (
  root: string,
  slug: string,
  specPath: string,
  evidence: unknown,
): FlowGateResult => {
  const recorded = createNativeChoiceEvidence(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  const doc = resolveDoc(root, slug, specPath, "spec");
  if (!doc.ok) return err("path_invalid", doc.error);
  const strict = readFlowStrict(root, slug);
  if (!strict.ok) return strict;
  if (!existsSync(doc.path)) return err("spec_missing", `spec not found: ${specPath}`);
  const state = strict.state;
  if (state.spec.status === "draft") {
    let text: string;
    try {
      text = readFileSync(doc.path, "utf8");
    } catch (error) {
      return err(
        "spec_self_review_failed",
        `spec self-review failed: unreadable spec: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const hard = qualitySpec(text).filter((f) => f.severity === "hard");
    const missing: string[] = [];
    if (!/^\s*\*+Branch:\*+/im.test(stripFences(text))) missing.push("**Branch:** header missing");
    if (hard.length > 0 || missing.length > 0) {
      return err(
        "spec_self_review_failed",
        "spec self-review failed: " +
          hard
            .map((f) => `${f.code} — ${f.message}`)
            .concat(missing)
            .join("; ") +
          " — see templates/spec-template.md for the required structure",
      );
    }
  }
  const step = nextFlowStatus(state.spec.status);
  if (!step.ok) return step;
  writeFlowState(root, {
    ...state,
    spec: {
      path: path.posix.join("docs", slug, "spec.md"),
      status: step.next,
      evidence: recorded.evidence,
    },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const transitionPlan = (
  root: string,
  slug: string,
  planPath: string,
  evidence: unknown,
): FlowGateResult => {
  const recorded = createNativeChoiceEvidence(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  const strict = readFlowStrict(root, slug);
  if (!strict.ok) return strict;
  if (!existsSync(doc.path)) return err("plan_missing", `plan not found: ${planPath}`);
  const state = strict.state;
  if (state.spec.status !== "approved") {
    return err("spec_not_approved", "spec must be approved before the plan can be approved");
  }
  if (state.plan.status === "draft") {
    let text: string;
    try {
      text = readFileSync(doc.path, "utf8");
    } catch (error) {
      return err(
        "plan_self_review_failed",
        `plan self-review failed: unreadable plan: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const missing: string[] = [];
    const stripped = stripFences(text);
    if (parseTasksFromPlan(text).length === 0)
      missing.push("no ### Task N: sections outside fences");
    if (!/^\s*\*+Spec:\*+/im.test(stripped)) missing.push("**Spec:** header missing");
    if (!/^\s*\*+Branch:\*+/im.test(stripped)) missing.push("**Branch:** header missing");
    if (missing.length > 0)
      return err("plan_self_review_failed", "plan self-review failed: " + missing.join("; "));
  }
  const step = nextFlowStatus(state.plan.status);
  if (!step.ok) return step;
  writeFlowState(root, {
    ...state,
    plan: {
      path: path.posix.join("docs", slug, "plan.md"),
      status: step.next,
      evidence: recorded.evidence,
    },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const recordMenuChoice = (
  root: string,
  slug: string,
  planPath: string,
  choice: unknown,
  evidence: unknown,
): FlowGateResult => {
  const recorded = createNativeChoiceEvidence(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  if (typeof choice !== "string" || !MENU_CHOICES.includes(choice as MenuChoice)) {
    return err("menu_choice_invalid", `invalid menu choice: ${JSON.stringify(choice)}`);
  }
  // The execution-menu evidence must be the exact label the user selected on
  // the native question; a mismatched choice is fabricated (FG-04).
  if (recorded.evidence.selectedLabel !== choice) {
    return err(
      "evidence_mismatch",
      `evidence selectedLabel ${JSON.stringify(recorded.evidence.selectedLabel)} does not match choice ${JSON.stringify(choice)}`,
    );
  }
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  const strict = readFlowStrict(root, slug);
  if (!strict.ok) return strict;
  const state = strict.state;
  if (state.spec.status !== "approved")
    return err("spec_not_approved", "spec must be approved before the execution menu");
  if (state.plan.status !== "approved")
    return err("plan_not_approved", "plan must be approved before the execution menu");
  writeFlowState(root, {
    ...state,
    plan: state.plan.path ? state.plan : { path: planPath, status: state.plan.status },
    menu: { presented: true, chosen: choice, evidence: recorded.evidence },
    updated_at: Date.now(),
  });
  return { ok: true };
};

export const slugFromPath = (p: string) => {
  const dirName = path.basename(path.dirname(p));
  return dirName === "." || dirName === "/" || dirName === "" ? "" : dirName;
};

/** Derive a slug from a canonical docs/<slug>/sdd/... path (SDD write gates). */
export const slugFromSddPath = (p: string): string => {
  const match = p
    .split(path.sep)
    .join("/")
    .match(/^docs\/([^/]+)\/sdd\b/);
  return match?.[1] ?? "";
};

export const assertFlowGates = (
  root: string,
  planPath: string,
  opts: { requireMenu?: boolean } = {},
): FlowGateResult => {
  const doc = resolveDoc(root, "", planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  const slug = slugFromPath(planPath);
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return err(
      "spec_not_approved",
      `spec not approved (status: ${state.spec.status}). Run workflow_spec_approve after the user's approval.`,
    );
  }
  if (state.plan.status !== "approved") {
    return err(
      "plan_not_approved",
      `plan not approved (status: ${state.plan.status}). Run workflow_plan_approve after the user's approval.`,
    );
  }
  if (opts.requireMenu && !state.menu.presented) {
    return err(
      "menu_not_presented",
      "post-plan menu not presented. Ask the native question menu (Subagent-driven/Inline/Handoff/Review spec/Review plan) and record the answer with workflow_plan_menu.",
    );
  }
  return { ok: true };
};

/**
 * Shared mutation guard for non-document product writes (FG-03, CA-18): a write
 * is blocked until the spec is approved, the plan is approved, the execution
 * menu has been recorded (when required), and the canonical docs validate.
 */
export const assertProductGates = (
  root: string,
  slug: string,
  opts: { requireMenu?: boolean; requireDocs?: boolean } = {},
): FlowGateResult => {
  const state = readFlowState(root, slug);
  if (state.spec.status !== "approved") {
    return err(
      "spec_not_approved",
      `spec not approved (status: ${state.spec.status}). Run workflow_spec_approve after the user's approval.`,
    );
  }
  if (state.plan.status !== "approved") {
    return err(
      "plan_not_approved",
      `plan not approved (status: ${state.plan.status}). Run workflow_plan_approve after the user's approval.`,
    );
  }
  if (opts.requireMenu && !state.menu.presented) {
    return err(
      "menu_not_presented",
      "post-plan menu not presented. Record the native question answer with workflow_plan_menu.",
    );
  }
  if (opts.requireDocs) {
    // Canonical relative form of the docs pair (DC-01/DC-02): docsValidate
    // resolves the contained paths itself.
    const validated = docsValidate({
      spec_path: path.posix.join("docs", slug, "spec.md"),
      plan_path: path.posix.join("docs", slug, "plan.md"),
      workspace_root: root,
    });
    if (validated.ok === false) return err("docs_invalid", validated.error);
  }
  return { ok: true };
};
