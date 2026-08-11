import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowTools, type SessionLookup } from "../../packages/workit-opencode/src/tools/flow";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import {
  COORDINATOR_RECOVERY_TEXT,
  HostReceiptStore,
  createOpenCodeEvidence,
  transitionPlan,
  transitionSpec,
  recordMenuChoice,
  prepareFlowState,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const rootClient = (): SessionLookup => ({
  session: {
    get: async () => ({ data: {} }),
  },
});

const childClient = (parentID = "root-session"): SessionLookup => ({
  session: {
    get: async () => ({ data: { parentID, directory: undefined } }),
  },
});

const failingClient = (): SessionLookup => ({
  session: {
    get: async () => {
      throw new Error("server unreachable");
    },
  },
});

const fixture = (client?: SessionLookup) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-oc-enforce-"));
  const slug = "oc-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const receipts = new HostReceiptStore();
  const tools = {
    ...createFlowTools(receipts, client ?? rootClient()),
    ...createSddTools(new WorkflowStateStore(), client ?? rootClient()),
  };
  const ctx = { directory: root, worktree: root, sessionID: "oc" } as never;
  return { root, slug, tools, ctx, receipts };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const run = (tools: any, name: string, args: any, ctx: any) =>
  tools[name].execute(args, ctx).then((raw: string) => JSON.parse(raw));

const schemaKeys = (tools: any, name: string) =>
  Object.keys((tools[name] as { args: Record<string, unknown> }).args);

// Simulates the host observing the answered native question: the plugin's
// tool.execute.after hook records the answer for the session, and the
// approval/menu tool consumes the session's MOST RECENT receipt (no windows).
const recordQuestion = (receipts: HostReceiptStore, label: string, sessionID = "oc") => {
  receipts.record(sessionID, `call-${label}`, label);
};

const receiptEvidence = (
  receipts: HostReceiptStore,
  label: string,
): ReturnType<typeof createOpenCodeEvidence> => {
  recordQuestion(receipts, label);
  const consumed = receipts.consume("oc");
  if (!consumed.ok) throw new Error(consumed.error);
  return createOpenCodeEvidence(consumed.receipt);
};

// Full approval + subagent-driven menu with host-issued receipts, using core
// transitions directly (receipts bound to the same session the tools use).
const establishSubagentDriven = async (root: string, slug: string, receipts: HostReceiptStore) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  const ev = (label: string) => {
    recordQuestion(receipts, label);
    const consumed = receipts.consume("oc");
    if (!consumed.ok) throw new Error(consumed.error);
    return createOpenCodeEvidence(consumed.receipt);
  };
  for (const step of [
    transitionSpec(root, slug, spec, ev("Approve spec")),
    transitionSpec(root, slug, spec, ev("Approve spec")),
    transitionPlan(root, slug, plan, ev("Approve plan")),
    transitionPlan(root, slug, plan, ev("Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
  const menu = recordMenuChoice(root, slug, plan, "subagent-driven", ev("subagent-driven"));
  if (!menu.ok) throw new Error(menu.error);
};

test("approval and menu tool schemas expose no evidence, role, or taskIdentity fields", async () => {
  const { tools } = fixture();
  expect(schemaKeys(tools, "workflow_spec_approve")).toEqual(["spec_path"]);
  expect(schemaKeys(tools, "workflow_plan_approve")).toEqual(["plan_path"]);
  expect(schemaKeys(tools, "workflow_plan_menu")).toEqual(["plan_path", "choice"]);
  expect(schemaKeys(tools, "workflow_flow_status")).toEqual(["plan_path", "spec_path"]);
  expect(schemaKeys(tools, "workflow_sdd_task_brief")).toEqual([
    "confirmed",
    "sdd_dir",
    "task_id",
    "section_text",
  ]);
});

test("a caller-supplied evidence object is inert: no receipt means approval fails", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const forged = await run(
      tools,
      "workflow_spec_approve",
      {
        spec_path: "docs/oc-flow/spec.md",
        evidence: {
          host: "opencode",
          attested: true,
          callID: "forged",
          selectedLabel: "Approve",
          recordedAt: Date.now(),
        },
      },
      ctx,
    );
    expect(forged.ok).toBe(false);
    if (forged.ok === false) expect(forged.error).toMatch(/receipt/i);
    const status = await run(
      tools,
      "workflow_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("a host-issued question receipt is consumed by the approval tool without evidence args", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    const accepted = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("self_reviewed");
    expect(receipts.count("oc")).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("a recent positive answer to any question authorizes the approval (documented residual)", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    // A "proceed with stash?" answer is a positive label: the correlation
    // boundary is any recent positive host answer + the model's choice to
    // proceed. The laundering case (negative answer -> approval) is closed.
    receipts.record("oc", "call-stash", "yes, proceed");
    const accepted = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("self_reviewed");
    const status = await run(
      tools,
      "workflow_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("self_reviewed");
  } finally {
    cleanup(root);
  }
});

test("a negative answer cannot be laundered into an approval (FINDING 3)", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    receipts.record("oc", "call-no", "No");
    const denied = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) {
      expect(denied.data?.code).toBe("receipt_rejected");
      expect(denied.error).toMatch(/negative answer/i);
    }
    // Consumed-and-rejected: the negative answer is spent, never authorizing.
    expect(receipts.count("oc")).toBe(0);
    const status = await run(
      tools,
      "workflow_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("draft");
    // Retrying without a fresh answer still fails: the negative receipt is gone.
    const retry = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(retry.ok).toBe(false);
    if (retry.ok === false) expect(retry.data?.code).toBe("receipt_missing");
  } finally {
    cleanup(root);
  }
});

test("a negative answer cannot be laundered into a menu choice (FINDING 3)", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    for (const step of [
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
    ])
      if (!step.ok) throw new Error(step.error);
    receipts.record("oc", "call-cancel", "Cancel");
    const denied = await run(
      tools,
      "workflow_plan_menu",
      { choice: "subagent-driven", plan_path: plan },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) {
      expect(denied.data?.code).toBe("receipt_rejected");
      expect(denied.error).toMatch(/negative answer/i);
    }
    expect(receipts.count("oc")).toBe(0);
    const status = await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    expect(status.data.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("receipt replay fails: one receipt approves exactly once", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    const first = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(first.ok).toBe(true);
    const replay = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(replay.ok).toBe(false);
    if (replay.ok === false) expect(replay.error).toMatch(/receipt/i);
  } finally {
    cleanup(root);
  }
});

test("FINDING 5: two concurrent approve calls with ONE receipt — exactly one succeeds", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    // Both approval calls race in the same message; the atomic consume
    // (consume-before-transition) lets exactly one take the receipt.
    const [a, b] = await Promise.all([
      run(tools, "workflow_spec_approve", { spec_path: "docs/oc-flow/spec.md" }, ctx),
      run(tools, "workflow_spec_approve", { spec_path: "docs/oc-flow/spec.md" }, ctx),
    ]);
    const winners = [a, b].filter((r) => r.ok === true);
    expect(winners.length).toBe(1);
    const losers = [a, b].filter((r) => r.ok === false);
    if (losers[0]?.ok === false) expect(losers[0].error).toMatch(/receipt/i);
    // One answer drove exactly one transition: self_reviewed, NOT approved.
    const status = await run(
      tools,
      "workflow_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("self_reviewed");
    expect(receipts.count("oc")).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("a receipt recorded for another session cannot be consumed", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec", "other-session");
    const denied = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.error).toMatch(/receipt/i);
  } finally {
    cleanup(root);
  }
});

test("menu consumption binds the exact selected label: a mismatched receipt label fails", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    recordQuestion(receipts, "Approve");
    await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve");
    await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve");
    await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    recordQuestion(receipts, "Approve");
    await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);

    recordQuestion(receipts, "Inline");
    const mismatch = await run(
      tools,
      "workflow_plan_menu",
      { choice: "subagent-driven", plan_path: plan },
      ctx,
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok === false) expect(mismatch.error).toMatch(/mismatch|label/i);

    recordQuestion(receipts, "subagent-driven");
    const recorded = await run(
      tools,
      "workflow_plan_menu",
      { choice: "subagent-driven", plan_path: plan },
      ctx,
    );
    expect(recorded.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("menu consumption accepts the capitalized label exactly as the user answers it", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    for (const step of [
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
    ])
      if (!step.ok) throw new Error(step.error);
    // The host presents "Inline" (capitalized); the user answers exactly that.
    recordQuestion(receipts, "Inline");
    const menu = await run(tools, "workflow_plan_menu", { choice: "inline", plan_path: plan }, ctx);
    expect(menu.ok).toBe(true);
    if (menu.ok === true) expect(menu.data.menu.chosen).toBe("inline");
  } finally {
    cleanup(root);
  }
});

test("a real child session (host parentage) is delegated and passes product gates", async () => {
  const { root, tools, receipts } = fixture(childClient("root-session"));
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    const childCtx = { directory: root, worktree: root, sessionID: "child-session" } as never;
    const brief = await run(
      tools,
      "workflow_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
      },
      childCtx,
    );
    expect(brief.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("the root session is blocked after subagent-driven; caller role args are inert", async () => {
  const { root, tools, ctx, receipts } = fixture(rootClient());
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    const blocked = await run(
      tools,
      "workflow_sdd_append_progress",
      {
        confirmed: true,
        progress_path: "docs/oc-flow/sdd/progress.md",
        line: "Task 1: work (commits abcdef0..1234567, tests pass)",
        role: "delegated",
        taskIdentity: "forged-worker",
      },
      ctx,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) {
      expect(blocked.data?.code).toBe("coordinator_blocked");
      expect(blocked.error).toContain(COORDINATOR_RECOVERY_TEXT);
    }
  } finally {
    cleanup(root);
  }
});

test("a failing session lookup fails closed: the session is treated as the root coordinator", async () => {
  const { root, tools, receipts } = fixture(failingClient());
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    const blocked = await run(
      tools,
      "workflow_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
      },
      { directory: root, worktree: root, sessionID: "unverifiable" } as never,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) expect(blocked.data?.code).toBe("coordinator_blocked");
  } finally {
    cleanup(root);
  }
});

test("full flow through the opencode tools with host receipts: approvals + menu + gated SDD writes", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";

    const briefBlocked = await run(
      tools,
      "workflow_sdd_task_brief",
      { confirmed: true, sdd_dir: "docs/oc-flow/sdd", task_id: 1, section_text: "- [ ] Work\n" },
      ctx,
    );
    expect(briefBlocked.ok).toBe(false);
    expect(briefBlocked.error).toMatch(/approved|spec/i);

    recordQuestion(receipts, "Approve spec");
    await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve spec");
    await run(tools, "workflow_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve plan");
    await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);
    recordQuestion(receipts, "Approve plan");
    await run(tools, "workflow_plan_approve", { plan_path: plan }, ctx);

    const progressBlocked = await run(
      tools,
      "workflow_sdd_append_progress",
      {
        confirmed: true,
        progress_path: "docs/oc-flow/sdd/progress.md",
        line: "Task 1: complete (commits abcdef0..1234567, tests pass)",
      },
      ctx,
    );
    expect(progressBlocked.ok).toBe(false);
    if (progressBlocked.ok === false) expect(progressBlocked.error).toMatch(/menu/i);

    recordQuestion(receipts, "handoff");
    const menu = await run(
      tools,
      "workflow_plan_menu",
      { choice: "handoff", plan_path: plan },
      ctx,
    );
    expect(menu.ok).toBe(true);

    const brief = await run(
      tools,
      "workflow_sdd_task_brief",
      { confirmed: true, sdd_dir: "docs/oc-flow/sdd", task_id: 1, section_text: "- [ ] Work\n" },
      ctx,
    );
    expect(brief.ok).toBe(true);

    const status = await run(tools, "workflow_flow_status", { plan_path: plan }, ctx);
    expect(status.data.spec.status).toBe("approved");
    expect(status.data.plan.status).toBe("approved");
    expect(status.data.menu).toMatchObject({ presented: true, chosen: "handoff" });
    expect(status.data.menu.evidence).toBeDefined();
  } finally {
    cleanup(root);
  }
});

test("workflow_flow_status prepares activation and canonical paths on first read", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workflow_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.data.spec.path).toBe("docs/oc-flow/spec.md");
    expect(out.data.plan.path).toBe("docs/oc-flow/plan.md");
    expect(existsSync(path.join(root, "docs/oc-flow/sdd/flow.json"))).toBe(true);
  } finally {
    cleanup(root);
  }
});
