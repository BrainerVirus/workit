import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../../packages/workit-core/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import { createFlowTools } from "../../packages/workit-core/src/tools/flow";
import { buildHandoffPrompt } from "../../packages/workit-core/src/tools/handoff";

const posix = (p: string) => p.split(path.sep).join("/");

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-layout-"));
  const slug = "add-some-awesome-feat";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
  writeFileSync(
    path.join(root, "docs", slug, "spec.md"),
    `# Spec\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`,
  );
  writeFileSync(
    path.join(root, "docs", slug, "plan.md"),
    `# Plan\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n`,
  );
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("flow state lives at docs/<slug>/sdd/flow.json", async () => {
  const { root, slug } = fixture();
  try {
    const tools = createFlowTools();
    const ctx = { directory: root } as any;
    const spec = `docs/${slug}/spec.md`;
    const raw = await tools.workflow_spec_approve.execute(
      { confirmed: true, spec_path: spec },
      ctx,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", slug, "sdd", "flow.json"))).toBe(true);
    expect(existsSync(path.join(root, "docs", slug, "flow.json"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("sdd context resolves docs/<slug>/sdd", async () => {
  const { root, slug } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_sdd_context.execute(
      { plan_path: `docs/${slug}/plan.md` },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(posix(out.data.sdd_dir)).toBe(`docs/${slug}/sdd`);
  } finally {
    cleanup(root);
  }
});

test("handoff resolves docs/<slug>/plan.md and spec.md", () => {
  const { root, slug } = fixture();
  try {
    const result = buildHandoffPrompt(root, `docs/${slug}/plan.md`);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(posix(result.plan)).toBe(`docs/${slug}/plan.md`);
      expect(posix(result.spec)).toBe(`docs/${slug}/spec.md`);
      expect(posix(result.sdd)).toBe(`docs/${slug}/sdd`);
    }
  } finally {
    cleanup(root);
  }
});

test("docs validate passes on the new layout", async () => {
  const { root, slug } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      { spec_path: `docs/${slug}/spec.md`, plan_path: `docs/${slug}/plan.md` },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(true);
  } finally {
    cleanup(root);
  }
});
