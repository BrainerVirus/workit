import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFlowTools,
  opencodeQuestionEvidence,
} from "../../packages/workit-opencode/src/tools/flow";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import {
  COORDINATOR_RECOVERY_TEXT,
  assertHostEvidence,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-oc-enforce-"));
  const slug = "oc-flow";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const tools = { ...createFlowTools(), ...createSddTools(new WorkflowStateStore()) };
  const ctx = { directory: root, worktree: root, sessionID: "oc" } as never;
  return { root, slug, tools, ctx };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const run = (tools: any, name: string, args: any, ctx: any) =>
  tools[name].execute(args, ctx).then((raw: string) => JSON.parse(raw));

const evidence = (host = "opencode", label = "Approve") => {
  const result = opencodeQuestionEvidence(`q-${label}`, label);
  if (!result.ok) throw new Error(result.error);
  return { ...result.evidence, host };
};

test("the opencode native-question adapter produces host-bound evidence", () => {
  const recorded = opencodeQuestionEvidence("q-spec-approve", "Approve spec");
  expect(recorded.ok).toBe(true);
  if (recorded.ok) {
    expect(recorded.evidence).toMatchObject({
      host: "opencode",
      questionId: "q-spec-approve",
      selectedLabel: "Approve spec",
    });
    expect(typeof recorded.evidence.recordedAt).toBe("number");
  }
  const forged = opencodeQuestionEvidence("", "Approve spec");
  expect(forged.ok).toBe(false);
});

test("opencode rejects a fabricated bare boolean where evidence is required", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workflow_spec_approve",
      { confirmed: true, spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/evidence/i);
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

test("opencode accepts only its own host evidence and rejects forged evidence", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const cursorHost = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md", evidence: evidence("cursor") },
      ctx,
    );
    expect(cursorHost.ok).toBe(false);
    expect(cursorHost.error).toMatch(/cursor|host|forged/i);

    const future = await run(
      tools,
      "workflow_spec_approve",
      {
        spec_path: "docs/oc-flow/spec.md",
        evidence: {
          host: "opencode",
          questionId: "q-future",
          selectedLabel: "Approve",
          recordedAt: Date.now() + 999_999,
        },
      },
      ctx,
    );
    expect(future.ok).toBe(false);

    const accepted = await run(
      tools,
      "workflow_spec_approve",
      { spec_path: "docs/oc-flow/spec.md", evidence: evidence("opencode") },
      ctx,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("self_reviewed");
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

test("full flow through the opencode tools: approvals + menu + gated SDD writes", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";

    const briefBlocked = await run(
      tools,
      "workflow_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
      },
      ctx,
    );
    expect(briefBlocked.ok).toBe(false);
    expect(briefBlocked.error).toMatch(/approved|spec/i);

    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );

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

    const menu = await run(
      tools,
      "workflow_plan_menu",
      { choice: "handoff", plan_path: plan, evidence: evidence("opencode", "handoff") },
      ctx,
    );
    expect(menu.ok).toBe(true);

    const brief = await run(
      tools,
      "workflow_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
      },
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

test("opencode threads MutationContext: coordinator blocked, authenticated worker allowed", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );
    const menu = await run(
      tools,
      "workflow_plan_menu",
      {
        choice: "subagent-driven",
        plan_path: plan,
        evidence: evidence("opencode", "subagent-driven"),
      },
      ctx,
    );
    expect(menu.ok).toBe(true);

    const coordinatorCtx = {
      directory: root,
      worktree: root,
      sessionID: "oc",
      agent: "build",
    } as never;
    const blocked = await run(
      tools,
      "workflow_sdd_append_progress",
      {
        confirmed: true,
        progress_path: "docs/oc-flow/sdd/progress.md",
        line: "Task 1: work (commits abcdef0..1234567, tests pass)",
      },
      coordinatorCtx,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) {
      expect(blocked.data?.code).toBe("coordinator_blocked");
      expect(blocked.error).toContain(COORDINATOR_RECOVERY_TEXT);
    }

    const workerCtx = {
      directory: root,
      worktree: root,
      sessionID: "oc",
      agent: "workit-worker",
    } as never;
    const brief = await run(
      tools,
      "workflow_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
        role: "delegated",
        taskIdentity: "workit-worker",
      },
      workerCtx,
    );
    expect(brief.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("opencode fails closed: a coordinator under a custom agent name cannot bypass the boundary", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workflow_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_spec_approve",
      { spec_path: spec, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );
    await run(
      tools,
      "workflow_plan_approve",
      { plan_path: plan, evidence: evidence("opencode") },
      ctx,
    );
    const menu = await run(
      tools,
      "workflow_plan_menu",
      {
        choice: "subagent-driven",
        plan_path: plan,
        evidence: evidence("opencode", "subagent-driven"),
      },
      ctx,
    );
    expect(menu.ok).toBe(true);

    // Any agent that does not pass role="delegated" is the coordinator — the
    // agent-name heuristic must not reclassify a custom-named session.
    const customCoordinatorCtx = {
      directory: root,
      worktree: root,
      sessionID: "oc",
      agent: "custom-lead",
    } as never;
    const blocked = await run(
      tools,
      "workflow_sdd_append_progress",
      {
        confirmed: true,
        progress_path: "docs/oc-flow/sdd/progress.md",
        line: "Task 1: work (commits abcdef0..1234567, tests pass)",
      },
      customCoordinatorCtx,
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

test("opencode shares the exact host parity with cursor via core bindings", () => {
  const cursorEv = opencodeQuestionEvidence("q", "Approve");
  if (!cursorEv.ok) throw new Error(cursorEv.error);
  const bind = assertHostEvidence("cursor", cursorEv.evidence);
  expect(bind.ok).toBe(false);
  const own = assertHostEvidence("opencode", cursorEv.evidence);
  expect(own.ok).toBe(true);
});
