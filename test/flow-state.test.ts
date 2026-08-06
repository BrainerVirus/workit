import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
} from "../src/core/flow-state";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flow-"));
  mkdirSync(path.join(root, "docs/superpowers/specs"), { recursive: true });
  mkdirSync(path.join(root, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(path.join(root, "docs/superpowers/specs/a-design.md"), "# A\n\n**Branch:** `feature/a`\n");
  writeFileSync(path.join(root, "docs/superpowers/plans/a.md"), "# A\n\n**Branch:** `feature/a`\n");
  return { root, slug: "my-feature" };
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
    const first = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");

    const second = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("confirmed:false never transitions", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", false);
    expect(result.ok).toBe(false);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve hard-fails while spec is draft", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
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
    transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    transitionSpec(root, slug, "docs/superpowers/specs/a-design.md", true);
    const first = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("self_reviewed");
    const second = transitionPlan(root, slug, "docs/superpowers/plans/a.md", true);
    expect(second.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("menu choice records presented + chosen", () => {
  const { root, slug } = fixture();
  try {
    const result = recordMenuChoice(root, slug, "docs/superpowers/plans/a.md", "handoff", true);
    expect(result.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(true);
    expect(state.menu.chosen).toBe("handoff");
  } finally {
    cleanup(root);
  }
});

import { assertFlowGates, slugFromPath } from "../src/core/flow-state";

test("slugFromPath strips -design suffix", () => {
  expect(slugFromPath("docs/superpowers/plans/2026-08-06-x.md")).toBe("2026-08-06-x");
  expect(slugFromPath("docs/superpowers/specs/2026-08-06-x-design.md")).toBe("2026-08-06-x");
});

test("assertFlowGates fails without approvals", () => {
  const { root, slug } = fixture();
  try {
    const result = assertFlowGates(root, `docs/superpowers/plans/${slug}.md`);
    expect(result.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates requires menu when requested", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/superpowers/specs/${slug}-design.md`;
    const plan = `docs/superpowers/plans/${slug}.md`;
    writeFileSync(path.join(root, spec), `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n`);
    writeFileSync(path.join(root, plan), `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n`);
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
  const { root } = fixture();
  try {
    const result = transitionSpec(root, "..", "docs/superpowers/specs/a-design.md", true);
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("invalid slug");
  } finally {
    cleanup(root);
  }
});
