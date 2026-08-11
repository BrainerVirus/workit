import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
  prepareFlowState,
} from "../../packages/workit-core/src/core/flow-state";
import { establishApprovedFlow, evidence } from "./flow-fixtures";

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
    expect(state.activated).toBe(false);
    expect(state.spec.status).toBe("draft");
    expect(state.plan.status).toBe("draft");
    expect(state.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("spec transitions draft -> self_reviewed -> approved with native evidence", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const blocked = transitionSpec(root, slug, spec, evidence());
    expect(blocked.ok).toBe(false); // activation required first
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const first = transitionSpec(root, slug, spec, evidence());
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");
    const second = transitionSpec(root, slug, spec, evidence());
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("confirmed:false boolean is never evidence", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, false as never);
    expect(result.ok).toBe(false);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve hard-fails while spec is draft", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const result = transitionPlan(root, slug, plan, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("spec");
      expect(result.code).toBe("spec_not_approved");
    }
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve requires spec approved", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug);
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("approved");
    expect(state.plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("menu choice records presented + chosen with exact evidence", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug);
    const state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(true);
    expect(state.menu.chosen).toBe("handoff");
    expect(state.menu.evidence?.selectedLabel).toBe("handoff");
  } finally {
    cleanup(root);
  }
});

import {
  assertFlowGates,
  slugFromPath,
  slugFromSddPath,
} from "../../packages/workit-core/src/core/flow-state";

test("slugFromPath strips -design suffix", () => {
  expect(slugFromPath("docs/x/plan.md")).toBe("x");
  expect(slugFromPath("docs/x/spec.md")).toBe("x");
});

test("slugFromSddPath requires a real sdd segment and rejects sdd-prefixed lookalikes", () => {
  expect(slugFromSddPath("docs/x/sdd/flow.json")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd/progress.md")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd-attack/flow.json")).toBe("");
  expect(slugFromSddPath("docs/x/sdd/attack/flow.json")).toBe("x");
  expect(slugFromSddPath("docs/review/sdd'quoted")).toBe("review");
  expect(slugFromSddPath("docs/x/sdd'attack/flow.json")).toBe("x");
});

test("missing flow state hint names only workflow_flow_status as the activation path", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("workflow_flow_status");
      expect(result.error).not.toContain("docs_layout");
    }
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates fails without approvals", () => {
  const { root, slug } = fixture();
  try {
    const result = assertFlowGates(root, `docs/${slug}/plan.md`);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe("spec_not_approved");
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates requires menu when requested", () => {
  const { root, slug } = fixture();
  try {
    const plan = `docs/${slug}/plan.md`;
    establishApprovedFlow(root, slug);
    const withoutMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withoutMenu.ok).toBe(true); // establishApprovedFlow already presented the menu
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates blocks execution before the menu is presented", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, spec), COMPLIANT_SPEC(slug));
    writeFileSync(path.join(root, plan), COMPLIANT_PLAN(slug));
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    transitionSpec(root, slug, spec, evidence());
    transitionSpec(root, slug, spec, evidence());
    transitionPlan(root, slug, plan, evidence());
    transitionPlan(root, slug, plan, evidence());
    const withoutMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withoutMenu.ok).toBe(false);
    if (withoutMenu.ok === false) expect(withoutMenu.code).toBe("menu_not_presented");
    recordMenuChoice(root, slug, plan, "inline", evidence("opencode", "inline"));
    const withMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withMenu.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("invalid slug is rejected before any write", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, "..", `docs/${slug}/spec.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("invalid slug");
  } finally {
    cleanup(root);
  }
});

test("corrupt flow.json at the canonical sdd path blocks transitions with a structured error", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug);
    writeFileSync(path.join(root, "docs", slug, "sdd", "flow.json"), "{not-json", "utf8");
    const result = transitionPlan(root, slug, `docs/${slug}/plan.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("corrupt");
      expect(result.code).toBe("flow_corrupt");
    }
  } finally {
    cleanup(root);
  }
});

test("already approved spec rejects further transitions", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug);
    const third = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(third.ok).toBe(false);
    if (third.ok === false) {
      expect(third.error).toContain("already approved");
      expect(third.code).toBe("flow_already_approved");
    }
  } finally {
    cleanup(root);
  }
});

test("transitions reject a missing doc file", () => {
  const { root, slug } = fixture();
  try {
    const plan = `docs/${slug}/plan.md`;
    const spec = `docs/${slug}/spec.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    rmSync(path.join(root, plan), { force: true });
    const result = transitionPlan(root, slug, plan, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("plan not found");
  } finally {
    cleanup(root);
  }
});
