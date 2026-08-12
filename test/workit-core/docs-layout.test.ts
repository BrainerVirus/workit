import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import { createFlowTools } from "../../packages/workit-opencode/src/tools/flow";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";
import { buildHandoffPrompt } from "../../packages/workit-core/src/core/handoff-tools";
import { createDocsRepoTools } from "../../packages/workit-opencode/src/tools/docs-repo";

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
    const receipts = new HostReceiptStore();
    const tools = createFlowTools(receipts, { session: { get: async () => ({ data: {} }) } });
    const ctx = { directory: root, sessionID: "s1" } as any;
    const spec = `docs/${slug}/spec.md`;
    await tools.workflow_flow_status.execute({ plan_path: `docs/${slug}/plan.md` }, ctx);
    receipts.record("s1", "call-approve", "Approve");
    const raw = await tools.workflow_spec_approve.execute({ spec_path: spec }, ctx);
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

test("docs validate rejects absolute paths through the shared resolver", async () => {
  const { root, slug } = fixture();
  try {
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      {
        spec_path: path.join(root, "docs", slug, "spec.md"),
        plan_path: `docs/${slug}/plan.md`,
      },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    expect(JSON.parse(raw as string).ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("docs validate rejects cross-slug pairs through the shared resolver", async () => {
  const { root, slug } = fixture();
  try {
    mkdirSync(path.join(root, "docs", "other"), { recursive: true });
    writeFileSync(path.join(root, "docs/other/spec.md"), "# Other\n");
    const raw = await createSddTools(new WorkflowStateStore()).workflow_docs_validate.execute(
      {
        spec_path: `docs/${slug}/spec.md`,
        plan_path: "docs/other/plan.md",
      },
      { directory: root, worktree: root, sessionID: "s" } as never,
    );
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/cross-slug|docs\//i);
  } finally {
    cleanup(root);
  }
});

test("flow tools reject wrong basenames through the shared resolver", async () => {
  const { root, slug } = fixture();
  try {
    const tools = createFlowTools(new HostReceiptStore(), {
      session: { get: async () => ({ data: {} }) },
    });
    const ctx = { directory: root } as never;
    const out = await tools.workflow_spec_approve.execute(
      { spec_path: `docs/${slug}/spec.txt` },
      ctx,
    );
    expect(JSON.parse(out as string).ok).toBe(false);
    const planOut = await tools.workflow_plan_approve.execute(
      { plan_path: `docs/${slug}/notes.md` },
      ctx,
    );
    expect(JSON.parse(planOut as string).ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("flow tools reject traversal through the shared resolver", async () => {
  const { root } = fixture();
  try {
    const tools = createFlowTools(new HostReceiptStore(), {
      session: { get: async () => ({ data: {} }) },
    });
    const ctx = { directory: root } as never;
    const out = await tools.workflow_spec_approve.execute({ spec_path: "../outside.md" }, ctx);
    expect(JSON.parse(out as string).ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("workflow_docs_layout prepare creates only missing dirs on the opencode adapter", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-layout-prepare-"));
  try {
    const tools = createDocsRepoTools();
    const raw = await tools.workflow_docs_layout.execute({ slug: "fresh-layout-slug" }, {
      directory: root,
      worktree: root,
    } as never);
    const out = JSON.parse(raw as string);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug"))).toBe(true);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug", "sdd"))).toBe(false);
    expect(existsSync(path.join(root, "docs", "fresh-layout-slug", "spec.md"))).toBe(false);
  } finally {
    cleanup(root);
  }
});
