import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flow-"));
  const slug = "my-feature";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("missing flow.json reads as draft with no menu", () => {
  const { root, slug } = fixture();
  try {
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("draft");
    expect(state.plan.status).toBe("draft");
    expect(state.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("spec transitions draft -> self_reviewed -> approved", () => {
  const { root, slug } = fixture();
  try {
    const first = transitionSpec(root, slug, `docs/${slug}/spec.md`, true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");

    const second = transitionSpec(root, slug, `docs/${slug}/spec.md`, true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("confirmed:false never transitions", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, false);
    expect(result.ok).toBe(false);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve hard-fails while spec is draft", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionPlan(root, slug, `docs/${slug}/plan.md`, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("spec");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve requires spec approved", () => {
  const { root, slug } = fixture();
  try {
    transitionSpec(root, slug, `docs/${slug}/spec.md`, true);
    transitionSpec(root, slug, `docs/${slug}/spec.md`, true);
    const first = transitionPlan(root, slug, `docs/${slug}/plan.md`, true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("self_reviewed");
    const second = transitionPlan(root, slug, `docs/${slug}/plan.md`, true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("menu choice records presented + chosen", () => {
  const { root, slug } = fixture();
  try {
    const result = recordMenuChoice(root, slug, `docs/${slug}/plan.md`, "handoff", true);
    expect(result.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(true);
    expect(state.menu.chosen).toBe("handoff");
  } finally {
    cleanup(root);
  }
});

import { assertFlowGates, slugFromPath } from "../../packages/workit-core/src/core/flow-state";

test("slugFromPath strips -design suffix", () => {
  expect(slugFromPath("docs/x/plan.md")).toBe("x");
  expect(slugFromPath("docs/x/spec.md")).toBe("x");
});

test("assertFlowGates fails without approvals", () => {
  const { root, slug } = fixture();
  try {
    const result = assertFlowGates(root, `docs/${slug}/plan.md`);
    expect(result.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates requires menu when requested", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, spec), COMPLIANT_SPEC(slug));
    writeFileSync(path.join(root, plan), COMPLIANT_PLAN(slug));
    transitionSpec(root, slug, spec, true);
    transitionSpec(root, slug, spec, true);
    transitionPlan(root, slug, plan, true);
    transitionPlan(root, slug, plan, true);
    const withoutMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withoutMenu.ok).toBe(false);
    recordMenuChoice(root, slug, plan, "inline", true);
    const withMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withMenu.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("invalid slug is rejected before any write", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, "..", `docs/${slug}/spec.md`, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("invalid slug");
  } finally {
    cleanup(root);
  }
});

test("corrupt flow.json falls back to draft without throwing", () => {
  const { root, slug } = fixture();
  try {
    mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
    writeFileSync(path.join(root, "docs", slug, "flow.json"), "{not-json", "utf8");
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("draft");
    expect(state.plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("already approved spec rejects further transitions", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, spec), COMPLIANT_SPEC(slug));
    writeFileSync(path.join(root, plan), COMPLIANT_PLAN(slug));
    transitionSpec(root, slug, spec, true);
    transitionSpec(root, slug, spec, true);
    const third = transitionSpec(root, slug, spec, true);
    expect(third.ok).toBe(false);
    expect(String((third as { error: string }).error)).toContain("already approved");
  } finally {
    cleanup(root);
  }
});

test("transitions reject a missing doc file", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const missingPlan = `docs/${slug}/missing-plan.md`;
    transitionSpec(root, slug, spec, true);
    transitionSpec(root, slug, spec, true);
    const result = transitionPlan(root, slug, missingPlan, true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("plan not found");
  } finally {
    cleanup(root);
  }
});
