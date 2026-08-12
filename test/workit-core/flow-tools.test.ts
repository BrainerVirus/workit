import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowTools, type SessionLookup } from "../../packages/workit-opencode/src/tools/flow";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC =
  "# X\n\n**Branch:** `feature/x`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n";

const client: SessionLookup = {
  session: { get: async () => ({ data: {} }) },
};

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flowtools-"));
  mkdirSync(path.join(root, "docs", "x"), { recursive: true });
  writeFileSync(path.join(root, "docs/x/spec.md"), COMPLIANT_SPEC);
  writeFileSync(
    path.join(root, "docs/x/plan.md"),
    "# X\n\n**Spec:** `docs/x/spec.md`\n**Branch:** `feature/x`\n\n### Task 1: One\n\n- [ ] **Step 1:** Work\n",
  );
  const receipts = new HostReceiptStore();
  const tools = createFlowTools(receipts, client);
  const ctx = { directory: root, sessionID: "s1" } as never;
  return { root, tools, ctx, receipts };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const run = (tools: any, name: string, args: any, ctx: any) =>
  tools[name].execute(args, ctx).then((raw: string) => JSON.parse(raw));

const question = (receipts: HostReceiptStore, label = "Approve") => {
  receipts.record("s1", `call-${label}`, label);
};

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

test("spec_approve without a host receipt fails", async () => {
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
    if (out.ok === false) expect(out.error).toMatch(/receipt/i);
  } finally {
    cleanup(root);
  }
});

test("full flow: activate + spec approve -> plan approve -> menu", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    const spec = "docs/x/spec.md";
    const plan = "docs/x/plan.md";
    await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    question(receipts);
    const specOut = await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    expect(specOut.ok).toBe(true);
    question(receipts, "Approve");
    const planFirst = await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    expect(planFirst.ok).toBe(true);
    question(receipts, "handoff");
    const menu = await run(
      tools,
      "workflow_plan_menu",
      { plan_path: plan, choice: "handoff" },
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

test("plan_approve hard-fails while spec is draft; the attempted receipt IS spent (FINDING 5 semantics)", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    const spec = "docs/x/spec.md";
    const plan = "docs/x/plan.md";
    await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    // The user answered the plan-approval question, but the spec is still draft.
    question(receipts, "Approve");
    const out = await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("spec");
    // FINDING 5 (round 3): consume-before-transition is spent-on-any-attempt —
    // the failed gate consumed the answer, and a retry WITHOUT re-asking fails.
    expect(receipts.count("s1")).toBe(0);
    const retry = await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    expect(retry.ok).toBe(false);
    if (retry.ok === false) expect(retry.error).toMatch(/receipt/i);
    // Approve the spec with its own receipt, then ask the plan question
    // AGAIN: the fresh answer authorizes (re-answer UX).
    question(receipts);
    await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    question(receipts, "Approve");
    const planOut = await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    expect(planOut.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});
