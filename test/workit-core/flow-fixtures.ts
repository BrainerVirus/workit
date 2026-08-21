import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createOpenCodeEvidence,
  prepareFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
  type NativeChoiceEvidence,
} from "../../packages/workit-core/src/core/flow-state";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";

export const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

export const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

/**
 * Host-issued OpenCode evidence: the plugin observes the answered native
 * `question` and records a receipt for the session. Tests simulate the host:
 * record the answer, then consume the session's most recent receipt. The menu
 * path must consume with the `{ label }` filter instead of this helper.
 */
export const openEvidence = (
  store: HostReceiptStore,
  sessionId: string,
  label: string,
): NativeChoiceEvidence => {
  const { receiptPurposeForLabel } = require("../../packages/workit-core/src/core/flow-state");
  const shorthand: Record<string, string> = {
    approve: "Approve spec",
    pause: "Pause plan",
    resume: "Resume plan",
    complete: "Complete plan",
  };
  const canonical = shorthand[label.trim().toLowerCase()] ?? label;
  let purpose = receiptPurposeForLabel(canonical);
  // Legacy bare "Approve" shorthand preserved for core spec/plan helpers.
  if (!purpose && label.trim().toLowerCase() === "approve") purpose = "spec-approval" as const;
  if (!purpose)
    throw new Error(
      `no purpose for label ${JSON.stringify(label)} (canonical ${JSON.stringify(canonical)})`,
    );
  store.record(sessionId, `call-${label}`, canonical, Date.now(), canonical, purpose);
  // For lifecycle shorthand, the receipt label is the canonical form; evidence
  // preserves the canonical bytes (CA-01).
  const consumed = store.consume(sessionId, { purpose });
  if (!consumed.ok) throw new Error(consumed.error);
  // Preserve original label bytes for lifecycle/menu shorthands that differ
  // from canonical (e.g. "pause" vs "Pause plan") — evidence keeps the call's
  // original intent, not the canonical expansion.
  if (label !== canonical) {
    return {
      ...createOpenCodeEvidence(consumed.receipt),
      selectedLabel: label,
    } as NativeChoiceEvidence;
  }
  return createOpenCodeEvidence(consumed.receipt);
};

/** The constant Cursor policy-only confirmation (attested: false). */
export const cursorEvidence = (): NativeChoiceEvidence => ({
  host: "cursor",
  attested: false,
  confirmation: "contract",
});

/**
 * Structural-test convenience: one fresh receipt per call, as if the plugin
 * hook observed one answered native question. Not usable for replay/menu-label
 * tests, which drive the store directly.
 */
export const evidence = (label = "Approve spec"): NativeChoiceEvidence =>
  openEvidence(new HostReceiptStore(), "evidence-session", label);

/** Menu evidence that consumes the receipt with the exact-choice filter.
 *  Bypasses HostReceiptStore purpose gating so label-matching tests can drive
 *  mismatched selectedLabel values (e.g. "First review spec") that have no
 *  workflow purpose yet must still reach recordMenuChoice's sameChoiceLabel check. */
export const menuEvidence = (
  _store: HostReceiptStore,
  _sessionId: string,
  label: string,
): NativeChoiceEvidence => {
  return {
    host: "opencode",
    attested: true,
    callID: `call-menu-${label}`,
    selectedLabel: label,
    recordedAt: Date.now(),
  };
};

/**
 * Write canonical docs and run the full approved + menu flow for a slug.
 * Used by tests that assert gated product mutations are allowed only after
 * every gate passes.
 */
export const establishApprovedFlow = (
  root: string,
  slug: string,
  store: HostReceiptStore,
  sessionId: string,
  host: "opencode" | "cursor" = "opencode",
) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  const steps =
    host === "opencode"
      ? [
          transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")),
          transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")),
          recordMenuChoice(root, slug, plan, "handoff", openEvidence(store, sessionId, "handoff")),
        ]
      : [
          transitionSpec(root, slug, spec, cursorEvidence()),
          transitionPlan(root, slug, plan, cursorEvidence()),
          recordMenuChoice(root, slug, plan, "handoff", cursorEvidence()),
        ];
  for (const step of steps) if (!step.ok) throw new Error(step.error);
};
