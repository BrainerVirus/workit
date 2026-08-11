import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createFlowEvidence,
  prepareFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
  type NativeChoiceEvidence,
} from "../../packages/workit-core/src/core/flow-state";

export const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

export const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

export const evidence = (
  host: "opencode" | "cursor" = "opencode",
  label = "Approve",
): NativeChoiceEvidence => {
  const result = createFlowEvidence(host, `q-${label}`, label);
  if (!result.ok) throw new Error(result.error);
  return result.evidence;
};

/**
 * Write canonical docs and run the full approved + menu flow for a slug.
 * Used by tests that assert gated product mutations are allowed only after
 * every gate passes.
 */
export const establishApprovedFlow = (
  root: string,
  slug: string,
  host: "opencode" | "cursor" = "opencode",
) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  const steps = [
    transitionSpec(root, slug, spec, evidence(host, "Approve spec")),
    transitionSpec(root, slug, spec, evidence(host, "Approve spec")),
    transitionPlan(root, slug, plan, evidence(host, "Approve plan")),
    transitionPlan(root, slug, plan, evidence(host, "Approve plan")),
    recordMenuChoice(root, slug, plan, "handoff", evidence(host, "handoff")),
  ];
  for (const step of steps) if (!step.ok) throw new Error(step.error);
};
