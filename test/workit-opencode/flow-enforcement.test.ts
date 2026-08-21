import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowTools, type SessionLookup } from "../../packages/workit-opencode/src/tools/flow";
import { createSddTools } from "../../packages/workit-opencode/src/tools/sdd";
import { WorkflowStateStore } from "../../packages/workit-core/src/state";
import {
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
    transitionPlan(root, slug, plan, ev("Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
  const menu = recordMenuChoice(root, slug, plan, "subagent-driven", ev("subagent-driven"), {
    hostWorkspace: root,
    role: "coordinator",
    sessionId: "root-session",
  });
  if (!menu.ok) throw new Error(menu.error);
};

test("approval and menu tool schemas expose no evidence, role, or taskIdentity fields", async () => {
  const { tools } = fixture();
  expect(schemaKeys(tools, "workit_spec_approve")).toEqual(["spec_path"]);
  expect(schemaKeys(tools, "workit_plan_approve")).toEqual(["plan_path"]);
  expect(schemaKeys(tools, "workit_plan_menu")).toEqual(["plan_path", "choice"]);
  expect(schemaKeys(tools, "workit_flow_status")).toEqual(["plan_path", "spec_path"]);
  expect(schemaKeys(tools, "workit_sdd_task_brief")).toEqual([
    "confirmed",
    "sdd_dir",
    "task_id",
    "section_text",
  ]);
  expect(schemaKeys(tools, "workit_sdd_append_advisory")).toEqual([
    "confirmed",
    "advisories_path",
    "task_id",
    "text",
  ]);
});

test("a caller-supplied evidence object is inert: no receipt means approval fails", async () => {
  const { root, tools, ctx } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const forged = await run(
      tools,
      "workit_spec_approve",
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
      "workit_flow_status",
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
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    const accepted = await run(
      tools,
      "workit_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("approved");
    expect(receipts.count("oc")).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("an intervening unrelated question cannot mask menu evidence (CA-02 purpose binding)", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    // An unrelated execution-menu receipt + a fresh spec-approval: only the spec purpose matters.
    receipts.record("oc", "call-menu", "Inline", Date.now(), "", "execution-menu");
    receipts.record("oc", "call-spec", "Approve spec", Date.now(), "", "spec-approval");
    const accepted = await run(tools, "workit_spec_approve", { spec_path: spec }, ctx);
    expect(accepted.ok).toBe(true);
    expect(accepted.data.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("a negative answer cannot be laundered into an approval (FINDING 3)", async () => {
  // Purposeless negatives (bare "No") are not recorded as flow receipts;
  // a spec-approval request with no typed receipt is receipt_missing (CA-02).
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    receipts.record("oc", "call-no", "No");
    const denied = await run(
      tools,
      "workit_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.data?.code).toBe("receipt_missing");
    expect(receipts.count("oc")).toBe(0);
    const status = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("draft");
    const retry = await run(
      tools,
      "workit_spec_approve",
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
  // Purposeless negatives are not recorded; an execution-menu request with
  // no typed receipt is receipt_missing, not receipt_rejected.
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    for (const step of [
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
    ])
      if (!step.ok) throw new Error(step.error);
    receipts.record("oc", "call-cancel", "Cancel");
    const denied = await run(
      tools,
      "workit_plan_menu",
      { choice: "subagent-driven", plan_path: plan },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.data?.code).toBe("receipt_missing");
    const status = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(status.data.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("receipt replay fails: one receipt approves exactly once", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    const first = await run(
      tools,
      "workit_spec_approve",
      { spec_path: "docs/oc-flow/spec.md" },
      ctx,
    );
    expect(first.ok).toBe(true);
    const replay = await run(
      tools,
      "workit_spec_approve",
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
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec");
    // Both approval calls race in the same message; the atomic consume
    // (consume-before-transition) lets exactly one take the receipt.
    const [a, b] = await Promise.all([
      run(tools, "workit_spec_approve", { spec_path: "docs/oc-flow/spec.md" }, ctx),
      run(tools, "workit_spec_approve", { spec_path: "docs/oc-flow/spec.md" }, ctx),
    ]);
    const winners = [a, b].filter((r) => r.ok === true);
    expect(winners.length).toBe(1);
    const losers = [a, b].filter((r) => r.ok === false);
    if (losers[0]?.ok === false) expect(losers[0].error).toMatch(/receipt/i);
    // One answer drove exactly one transition: draft -> approved on a single call.
    const status = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.spec.status).toBe("approved");
    expect(receipts.count("oc")).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("a receipt recorded for another session cannot be consumed", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    recordQuestion(receipts, "Approve spec", "other-session");
    const denied = await run(
      tools,
      "workit_spec_approve",
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
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";
    recordQuestion(receipts, "Approve spec");
    await run(tools, "workit_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve plan");
    await run(tools, "workit_plan_approve", { plan_path: plan }, ctx);

    recordQuestion(receipts, "Inline");
    const mismatch = await run(
      tools,
      "workit_plan_menu",
      { choice: "subagent-driven", plan_path: plan },
      ctx,
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok === false) expect(mismatch.error).toMatch(/mismatch|label/i);

    recordQuestion(receipts, "subagent-driven");
    const recorded = await run(
      tools,
      "workit_plan_menu",
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
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    for (const step of [
      transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
      transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
    ])
      if (!step.ok) throw new Error(step.error);
    // The host presents "Inline" (capitalized); the user answers exactly that.
    recordQuestion(receipts, "Inline");
    const menu = await run(tools, "workit_plan_menu", { choice: "inline", plan_path: plan }, ctx);
    expect(menu.ok).toBe(true);
    if (menu.ok === true) expect(menu.data.menu.chosen).toBe("inline");
  } finally {
    cleanup(root);
  }
});

test("menu consumption accepts host-decorated receipt labels for every source choice", async () => {
  // Task 3 (label-matching parity): hosts decorate choices with parenthesized
  // qualifiers ("Subagent-driven (Recommended)", "Handoff (new session only)")
  // that the bare machine enum does not carry. The shared matcher must still
  // bind the decorated receipt to the bare choice through the tool wrapper.
  const cases: Array<[string, string]> = [
    ["Subagent-driven (Recommended)", "subagent-driven"],
    ["Inline (Recommended)", "inline"],
    ["Handoff (new session only)", "handoff"],
    ["Review spec first", "review-spec"],
    ["Review plan first", "review-plan"],
  ];
  for (const [label, choice] of cases) {
    const { root, slug, tools, ctx, receipts } = fixture();
    try {
      await run(tools, "workit_flow_status", { plan_path: `docs/${slug}/plan.md` }, ctx);
      const spec = `docs/${slug}/spec.md`;
      const plan = `docs/${slug}/plan.md`;
      for (const step of [
        transitionSpec(root, slug, spec, receiptEvidence(receipts, "Approve spec")),
        transitionPlan(root, slug, plan, receiptEvidence(receipts, "Approve plan")),
      ])
        if (!step.ok) throw new Error(step.error);
      recordQuestion(receipts, label);
      const menu = await run(tools, "workit_plan_menu", { choice, plan_path: plan }, ctx);
      expect(menu.ok, `${label} -> ${choice}`).toBe(true);
      if (menu.ok) expect(menu.data.menu.chosen).toBe(choice);
    } finally {
      cleanup(root);
    }
  }
});

test("a real child session (host parentage) is delegated and denied control metadata", async () => {
  const { root, tools, receipts } = fixture(childClient("root-session"));
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    const childCtx = { directory: root, worktree: root, sessionID: "child-session" } as never;
    for (const [name, args] of [
      [
        "workit_sdd_task_brief",
        { confirmed: true, sdd_dir: "docs/oc-flow/sdd", task_id: 1, section_text: "- [ ] Work\n" },
      ],
      [
        "workit_sdd_append_progress",
        {
          confirmed: true,
          progress_path: "docs/oc-flow/sdd/progress.md",
          line: "Task 1: complete (commits abcdef0..1234567, tests pass)",
        },
      ],
      [
        "workit_sdd_append_advisory",
        {
          confirmed: true,
          advisories_path: "docs/oc-flow/sdd/advisories.md",
          task_id: 1,
          text: "nit",
        },
      ],
    ] as const) {
      const denied = await run(tools, name, args, childCtx);
      expect(denied.ok, name).toBe(false);
      if (denied.ok === false) expect(denied.data?.code, name).toBe("sdd_control_denied");
    }
    // Review-package denial is explicit too: a real base..head range still
    // fails closed for the delegated child (coordinator-owned metadata).
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString();
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "--allow-empty", "-m", "base");
    writeFileSync(path.join(root, "docs/oc-flow/sdd/.keep"), "\n");
    git("add", "-A");
    git("commit", "-m", "work");
    const reviewDenied = await run(
      tools,
      "workit_sdd_review_package",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        base_sha: git("rev-parse", "HEAD~1").trim(),
        head_sha: git("rev-parse", "HEAD").trim(),
      },
      childCtx,
    );
    expect(reviewDenied.ok).toBe(false);
    if (reviewDenied.ok === false) expect(reviewDenied.data?.code).toBe("sdd_control_denied");
    expect(existsSync(path.join(root, "docs/oc-flow/sdd/task-1-brief.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs/oc-flow/sdd/progress.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs/oc-flow/sdd/advisories.md"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("the root session owns control metadata after subagent-driven; caller role args are inert", async () => {
  const { root, tools, ctx, receipts } = fixture(rootClient());
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    const progress = await run(
      tools,
      "workit_sdd_append_progress",
      {
        confirmed: true,
        progress_path: "docs/oc-flow/sdd/progress.md",
        line: "Task 1: complete (commits abcdef0..1234567, tests pass)",
        role: "delegated",
        taskIdentity: "forged-worker",
      },
      ctx,
    );
    expect(progress.ok).toBe(true);

    const advisory = await run(
      tools,
      "workit_sdd_append_advisory",
      {
        confirmed: true,
        advisories_path: "docs/oc-flow/sdd/advisories.md",
        task_id: 1,
        text: "root-owned",
      },
      ctx,
    );
    expect(advisory.ok).toBe(true);
    expect(readFileSync(path.join(root, "docs/oc-flow/sdd/advisories.md"), "utf8")).toBe(
      "- Task 1: root-owned\n",
    );
  } finally {
    cleanup(root);
  }
});

test("a failing session lookup fails closed to the coordinator: control writes stay root-owned", async () => {
  const { root, tools, receipts } = fixture(failingClient());
  try {
    await establishSubagentDriven(root, "oc-flow", receipts);
    // An unverifiable session is the root coordinator (never a delegated
    // worker), so coordinator-owned control metadata stays writable — but a
    // forged delegated identity is impossible: there is no parentID at all.
    const brief = await run(
      tools,
      "workit_sdd_task_brief",
      {
        confirmed: true,
        sdd_dir: "docs/oc-flow/sdd",
        task_id: 1,
        section_text: "- [ ] Work\n",
      },
      { directory: root, worktree: root, sessionID: "unverifiable" } as never,
    );
    expect(brief.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("full flow through the opencode tools with host receipts: approvals + menu + gated SDD writes", async () => {
  const { root, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    const spec = "docs/oc-flow/spec.md";
    const plan = "docs/oc-flow/plan.md";

    const briefBlocked = await run(
      tools,
      "workit_sdd_task_brief",
      { confirmed: true, sdd_dir: "docs/oc-flow/sdd", task_id: 1, section_text: "- [ ] Work\n" },
      ctx,
    );
    expect(briefBlocked.ok).toBe(false);
    expect(briefBlocked.error).toMatch(/approved|spec/i);

    recordQuestion(receipts, "Approve spec");
    await run(tools, "workit_spec_approve", { spec_path: spec }, ctx);
    recordQuestion(receipts, "Approve plan");
    await run(tools, "workit_plan_approve", { plan_path: plan }, ctx);

    const progressBlocked = await run(
      tools,
      "workit_sdd_append_progress",
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
      "workit_plan_menu",
      { choice: "handoff", plan_path: plan },
      ctx,
    );
    expect(menu.ok).toBe(true);

    const brief = await run(
      tools,
      "workit_sdd_task_brief",
      { confirmed: true, sdd_dir: "docs/oc-flow/sdd", task_id: 1, section_text: "- [ ] Work\n" },
      ctx,
    );
    expect(brief.ok).toBe(true);

    const status = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(status.data.spec.status).toBe("approved");
    expect(status.data.plan.status).toBe("approved");
    expect(status.data.menu).toMatchObject({ presented: true, chosen: "handoff" });
    expect(status.data.menu.evidence).toBeDefined();
  } finally {
    cleanup(root);
  }
});

test("workit_flow_status prepares activation and canonical paths on first read", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workit_flow_status",
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

// --- Task 4: OpenCode adapter lifecycle + effective status ---

const writeSddLedger = (root: string, slug: string, lines: string[]) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "progress.md"), lines.join("\n") + "\n", "utf8");
};

test("lifecycle tool schemas expose only plan_path and no caller evidence/role fields", async () => {
  const { tools } = fixture();
  for (const name of ["workit_plan_pause", "workit_plan_resume", "workit_plan_complete"]) {
    expect(schemaKeys(tools, name)).toEqual(["plan_path"]);
  }
});

test("workit_flow_status returns execution and drift alongside spec/plan/menu", async () => {
  const { root, tools, ctx } = fixture();
  try {
    const out = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.data.execution).toEqual({
      status: "pending",
      mode: null,
      evidence: null,
      coordinator_session_id: null,
    });
    expect(out.data.drift).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("workit_flow_status reports digest drift while preserving the execution lifecycle after the plan changes", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it now"),
    );
    const out = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.data.drift).toEqual([
      { document: "plan", code: "digest_mismatch", path: "docs/oc-flow/plan.md" },
    ]);
    // Plan drift resets only the plan approval digest; the active execution
    // lifecycle survives the edit.
    expect(out.data.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
  } finally {
    cleanup(root);
  }
});

test("lifecycle tools: active -> paused -> active -> completed with one-use receipts", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    const plan = "docs/oc-flow/plan.md";

    const started = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(started.data.execution).toMatchObject({ status: "active", mode: "subagent-driven" });

    recordQuestion(receipts, "Pause plan");
    const paused = await run(tools, "workit_plan_pause", { plan_path: plan }, ctx);
    expect(paused.ok).toBe(true);
    expect(paused.data.execution.status).toBe("paused");
    expect(receipts.count("oc")).toBe(0);

    // A second pause without a fresh receipt is fail-closed (no replay).
    const replay = await run(tools, "workit_plan_pause", { plan_path: plan }, ctx);
    expect(replay.ok).toBe(false);
    if (replay.ok === false) expect(replay.error).toMatch(/receipt/i);

    recordQuestion(receipts, "Resume plan");
    const resumed = await run(tools, "workit_plan_resume", { plan_path: plan }, ctx);
    expect(resumed.ok).toBe(true);
    expect(resumed.data.execution.status).toBe("active");

    // Incomplete ledger -> structured execution_incomplete details.
    recordQuestion(receipts, "Complete plan");
    const incomplete = await run(tools, "workit_plan_complete", { plan_path: plan }, ctx);
    expect(incomplete.ok).toBe(false);
    if (incomplete.ok === false) {
      expect(incomplete.data?.code).toBe("execution_incomplete");
      expect(incomplete.data?.details).toMatchObject({
        required: [1],
        missing: [1],
      });
      expect(incomplete.error).toMatch(/ledger incomplete/i);
    }

    // Full ledger but failing repository verification -> verification_failed.
    writeSddLedger(root, slug, ["Task 1: complete"]);
    recordQuestion(receipts, "Complete plan");
    const unverified = await run(tools, "workit_plan_complete", { plan_path: plan }, ctx);
    expect(unverified.ok).toBe(false);
    if (unverified.ok === false) {
      expect(unverified.data?.code).toBe("verification_failed");
      expect(unverified.data?.details).toMatchObject({ exitCode: expect.any(Number) });
    }

    // Clean verification -> completed.
    writeFileSync(path.join(root, "CHANGELOG.md"), "## [Unreleased]\n\n- fixture\n");
    recordQuestion(receipts, "Complete plan");
    const completed = await run(tools, "workit_plan_complete", { plan_path: plan }, ctx);
    expect(completed.ok).toBe(true);
    expect(completed.data.execution.status).toBe("completed");

    const finalStatus = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(finalStatus.data.execution.status).toBe("completed");
    expect(finalStatus.data.drift).toEqual([]);
  } finally {
    cleanup(root);
  }
});

test("a wrong lifecycle purpose does not consume the receipt (purpose isolation: pause vs resume)", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    recordQuestion(receipts, "Pause plan");
    const wrong = await run(
      tools,
      "workit_plan_resume",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok === false) expect(wrong.code ?? wrong.error).toMatch(/receipt|purpose/i);
    expect(receipts.count("oc")).toBe(1);
    const right = await run(
      tools,
      "workit_plan_pause",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(right.ok).toBe(true);
    expect(right.data.execution.status).toBe("paused");
    expect(receipts.count("oc")).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("a negative lifecycle answer cannot be laundered into a pause", async () => {
  // Purposeless negatives produce no flow receipt; a plan-pause request with
  // no typed receipt is receipt_missing (CA-02 strict purpose binding).
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    receipts.record("oc", "call-cancel", "No");
    const denied = await run(
      tools,
      "workit_plan_pause",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.data?.code).toBe("receipt_missing");
    const status = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.execution.status).toBe("active");
  } finally {
    cleanup(root);
  }
});

test("a stale lifecycle receipt cannot pause a flow", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    receipts.record("oc", "call-stale", "Pause plan", Date.now() - 11 * 60 * 1000);
    const denied = await run(
      tools,
      "workit_plan_pause",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.error).toMatch(/stale|too old/i);
    const status = await run(
      tools,
      "workit_flow_status",
      { plan_path: "docs/oc-flow/plan.md" },
      ctx,
    );
    expect(status.data.execution.status).toBe("active");
  } finally {
    cleanup(root);
  }
});

test("resume after plan drift still works — lifecycle survives plan-doc drift", async () => {
  const { root, slug, tools, ctx, receipts } = fixture();
  try {
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, ctx);
    await establishSubagentDriven(root, slug, receipts);
    const plan = "docs/oc-flow/plan.md";
    recordQuestion(receipts, "Pause plan");
    await run(tools, "workit_plan_pause", { plan_path: plan }, ctx);
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it now"),
    );
    recordQuestion(receipts, "Resume plan");
    const resumed = await run(tools, "workit_plan_resume", { plan_path: plan }, ctx);
    expect(resumed.ok).toBe(true);
    const status = await run(tools, "workit_flow_status", { plan_path: plan }, ctx);
    expect(status.data.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
  } finally {
    cleanup(root);
  }
});

test("lifecycle tools preserve coordinator/delegated parentage and caller role args are inert", async () => {
  const { root, slug, tools, receipts } = fixture(childClient("root-session"));
  try {
    const childCtx = { directory: root, worktree: root, sessionID: "child" } as never;
    await run(tools, "workit_flow_status", { plan_path: "docs/oc-flow/plan.md" }, childCtx);
    await establishSubagentDriven(root, slug, receipts);
    receipts.record("child", "call-pause", "Pause plan");
    const paused = await run(
      tools,
      "workit_plan_pause",
      {
        plan_path: "docs/oc-flow/plan.md",
        confirmed: true,
        role: "coordinator",
        evidence: { host: "opencode", attested: true, callID: "forged" },
      },
      childCtx,
    );
    expect(paused.ok).toBe(true);
    expect(paused.data.execution.status).toBe("paused");
  } finally {
    cleanup(root);
  }
});
