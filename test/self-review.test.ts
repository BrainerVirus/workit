import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFlowState, transitionSpec, transitionPlan } from "../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const WARNING_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\nA new screen for the app.\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const NO_CA_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- Accept: nothing numbered\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const WARNING_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n### Task 1: Do the thing\n\nPlain prose, no checkbox steps, no Goal line — parses and has required headers.\n`;

const approveSpec = (root: string, slug: string) => {
  const specPath = `docs/${slug}/spec.md`;
  const first = transitionSpec(root, slug, specPath, true);
  expect(first.ok).toBe(true);
  const second = transitionSpec(root, slug, specPath, true);
  expect(second.ok).toBe(true);
};

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-self-review-"));
  const slug = "my-feature";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("spec missing a required section is rejected and stays draft", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n`);
    const result = transitionSpec(root, slug, specPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("self-review failed");
    expect(String((result as { error: string }).error)).toContain("## Acceptance criteria");
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("spec without CA-XX is rejected with missing_acceptance_criteria", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), NO_CA_SPEC(slug));
    const result = transitionSpec(root, slug, specPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("missing_acceptance_criteria");
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("compliant spec transitions draft -> self_reviewed -> approved", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    const first = transitionSpec(root, slug, specPath, true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");
    const second = transitionSpec(root, slug, specPath, true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("warning-only spec transitions fine", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), WARNING_SPEC(slug));
    const result = transitionSpec(root, slug, specPath, true);
    expect(result.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");
  } finally {
    cleanup(root);
  }
});

test("second transition is not gated by spec quality", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    const first = transitionSpec(root, slug, specPath, true);
    expect(first.ok).toBe(true);
    writeFileSync(path.join(root, specPath), "# broken");
    const second = transitionSpec(root, slug, specPath, true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("plan without ### Task N: headings is rejected and stays draft", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    approveSpec(root, slug);
    const planPath = `docs/${slug}/plan.md`;
    writeFileSync(
      path.join(root, planPath),
      `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\nNo tasks here.\n`,
    );
    const result = transitionPlan(root, slug, planPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("plan self-review failed");
    expect(String((result as { error: string }).error)).toContain("### Task N:");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan missing **Spec:** header is rejected and stays draft", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    approveSpec(root, slug);
    const planPath = `docs/${slug}/plan.md`;
    writeFileSync(
      path.join(root, planPath),
      `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n### Task 1: Do the thing\n`,
    );
    const result = transitionPlan(root, slug, planPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("**Spec:** header missing");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("spec without **Branch:** is rejected with the template hint and stays draft", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(
      path.join(root, specPath),
      `# ${slug}\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`,
    );
    const result = transitionSpec(root, slug, specPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("**Branch:** header missing");
    expect(String((result as { error: string }).error)).toContain("see templates/spec-template.md for the required structure");
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("spec with **Branch:** only inside a fence is rejected by the Branch check", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(
      path.join(root, specPath),
      `# ${slug}\n\n\`\`\`markdown\n**Branch:** \`feature/${slug}\`\n\`\`\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`,
    );
    const result = transitionSpec(root, slug, specPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("**Branch:** header missing");
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan with headers only inside a fence is rejected by the fence-aware header check", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    approveSpec(root, slug);
    const planPath = `docs/${slug}/plan.md`;
    writeFileSync(
      path.join(root, planPath),
      `# ${slug}\n\n\`\`\`markdown\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\`\`\`\n\n### Task 1: Do the thing\n`,
    );
    const result = transitionPlan(root, slug, planPath, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("**Spec:** header missing");
    expect(String((result as { error: string }).error)).toContain("**Branch:** header missing");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("compliant plan transitions draft -> self_reviewed -> approved", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    approveSpec(root, slug);
    const planPath = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, planPath), COMPLIANT_PLAN(slug));
    const first = transitionPlan(root, slug, planPath, true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("self_reviewed");
    const second = transitionPlan(root, slug, planPath, true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("plan with only warning-ish issues passes the gate", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    writeFileSync(path.join(root, specPath), COMPLIANT_SPEC(slug));
    approveSpec(root, slug);
    const planPath = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, planPath), WARNING_PLAN(slug));
    const result = transitionPlan(root, slug, planPath, true);
    expect(result.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("self_reviewed");
  } finally {
    cleanup(root);
  }
});
