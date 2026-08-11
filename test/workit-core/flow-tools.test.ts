import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowTools } from "../../packages/workit-opencode/src/tools/flow";

const COMPLIANT_SPEC =
  "# X\n\n**Branch:** `feature/x`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flowtools-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), COMPLIANT_SPEC);
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
  );
  const tools = createFlowTools();
  const ctx = { directory: root } as any;
  return { root, tools, ctx };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const run = (tools: any, name: string, args: any, ctx: any) =>
  tools[name].execute(args, ctx).then((raw: string) => JSON.parse(raw));

const ev = (label = "Approve") => ({
  host: "opencode",
  questionId: `q-${label}`,
  selectedLabel: label,
  recordedAt: Date.now(),
});

test("flow_status activates the flow and returns draft when no state exists", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workflow_flow_status",
      {
        plan_path: "docs/x/plan.md",
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.data.spec.status).toBe("draft");
    expect(out.data.spec.path).toBe("docs/x/spec.md");
    expect(out.data.menu.presented).toBe(false);
    expect(out.data.flow_path).toContain("docs/x/sdd/flow.json");
  } finally {
    cleanup(root);
  }
});

test("spec_approve without evidence fails", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workflow_spec_approve",
      {
        confirmed: false,
        spec_path: "docs/x/spec.md",
      },
      ctx,
    );
    expect(out.ok).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("full flow: activate + spec approve x2 -> plan approve x2 -> menu", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const spec = "docs/x/spec.md";
    const plan = "docs/x/plan.md";
    await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    await run(tools, "workflow_spec_approve", { spec_path: spec, evidence: ev() }, ctx);
    await run(tools, "workflow_spec_approve", { spec_path: spec, evidence: ev() }, ctx);
    const planFirst = await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: ev() },
      ctx,
    );
    expect(planFirst.ok).toBe(true);
    const planSecond = await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: ev() },
      ctx,
    );
    expect(planSecond.ok).toBe(true);
    const menu = await run(
      tools,
      "workflow_plan_menu",
      {
        plan_path: plan,
        choice: "handoff",
        evidence: ev("handoff"),
      },
      ctx,
    );
    expect(menu.ok).toBe(true);
    const status = await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    expect(status.data.spec.status).toBe("approved");
    expect(status.data.plan.status).toBe("approved");
    expect(status.data.menu).toMatchObject({ presented: true, chosen: "handoff" });
  } finally {
    cleanup(root);
  }
});

test("plan_approve hard-fails while spec is draft", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const plan = "docs/x/plan.md";
    await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    const out = await run(tools, "workflow_plan_approve", { plan_path: plan, evidence: ev() }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("spec");
  } finally {
    cleanup(root);
  }
});
