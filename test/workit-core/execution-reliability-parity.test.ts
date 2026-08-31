import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MENU_CHOICES,
  markHandoffDestination,
  prepareFlowState,
  readEffectiveFlowState,
  recordMenuChoice,
  transitionExecution,
  transitionPlan,
  transitionSpec,
} from "../../packages/workit-core/src/core/flow-state";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";
import { COMPLIANT_PLAN, COMPLIANT_SPEC, openEvidence } from "./flow-fixtures";

const fixture = (slug = "exec-parity") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-exec-parity-"));
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const setupApprovedFlow = (root: string, slug: string, store: HostReceiptStore) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  for (const step of [
    transitionSpec(root, slug, spec, openEvidence(store, "s", "Approve spec")),
    transitionPlan(root, slug, plan, openEvidence(store, "s", "Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
  return plan;
};

const cliEvidence = () => ({ host: "cli", attested: false, confirmation: "flag" }) as const;

describe("cross-host execution transition parity", () => {
  test("opencode subagent-driven activates with coordinator session", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "subagent-driven",
        openEvidence(store, "s", "subagent-driven"),
        { hostWorkspace: root, role: "coordinator", sessionId: "coord-1" },
      );
      expect(recorded.ok).toBe(true);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.menu).toMatchObject({ presented: true, chosen: "subagent-driven" });
      expect(effective.state.execution).toEqual({
        status: "active",
        mode: "subagent-driven",
        evidence: expect.anything(),
        coordinator_session_id: "coord-1",
      });
    } finally {
      cleanup(root);
    }
  });

  test("opencode inline activates without coordinator session", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "inline",
        openEvidence(store, "s", "inline"),
        { hostWorkspace: root, role: "coordinator", sessionId: "coord-1" },
      );
      expect(recorded.ok).toBe(true);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.execution).toEqual({
        status: "active",
        mode: "inline",
        evidence: expect.anything(),
        coordinator_session_id: null,
      });
    } finally {
      cleanup(root);
    }
  });

  test("cursor subagent-driven activates and records execution mode with a coordinator lease", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(root, slug, plan, "subagent-driven", {
        host: "cursor",
        attested: false,
        confirmation: "contract",
      });
      expect(recorded.ok).toBe(true);
      if (recorded.ok) expect(recorded.coordinator_lease).toMatch(/^[0-9a-f]{64}$/);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.menu.presented).toBe(true);
      expect(effective.state.execution).toEqual({
        status: "active",
        mode: "subagent-driven",
        evidence: { host: "cursor", attested: false, confirmation: "contract" },
        coordinator_session_id: null,
        delegation: {
          coordinator_lease_hash: expect.any(String),
          active_task_id: null,
          token_hash: null,
          token_workspace: null,
          token_slug: null,
          status: "active",
        },
      });
    } finally {
      cleanup(root);
    }
  });

  test("handoff keeps execution pending; destination marker resets menu", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "handoff",
        openEvidence(store, "s", "handoff"),
        {
          hostWorkspace: root,
          role: "coordinator",
          sessionId: "coord-1",
        },
      );
      expect(recorded.ok).toBe(true);
      let effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.execution.status).toBe("pending");
      expect(effective.state.execution.coordinator_session_id).toBeNull();
      const marked = markHandoffDestination(root, slug, plan);
      expect(marked.ok).toBe(true);
      effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.handoff_destination).toBe(true);
      expect(effective.state.menu).toEqual({ presented: false, chosen: "", evidence: null });
    } finally {
      cleanup(root);
    }
  });

  test("model deferral is a no-op choice", () => {
    const { root, slug } = fixture();
    try {
      expect(MENU_CHOICES).not.toContain("change-model");
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "change-model",
        openEvidence(store, "s", "change-model"),
        { hostWorkspace: root, role: "coordinator", sessionId: "coord-1" },
      );
      expect(recorded.ok).toBe(false);
      if (recorded.ok) return;
      expect(recorded.code).toBe("menu_choice_invalid");
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.menu.presented).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("pause/resume preserve the coordinator session", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "subagent-driven",
        openEvidence(store, "s", "subagent-driven"),
        { hostWorkspace: root, role: "coordinator", sessionId: "coord-1" },
      );
      expect(recorded.ok).toBe(true);
      for (const step of [
        transitionExecution(root, slug, plan, "pause", cliEvidence()),
        transitionExecution(root, slug, plan, "resume", cliEvidence()),
      ])
        expect(step.ok).toBe(true);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.execution.status).toBe("active");
      expect(effective.state.execution.coordinator_session_id).toBe("coord-1");
    } finally {
      cleanup(root);
    }
  });

  test("completion clears the coordinator session", () => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const plan = setupApprovedFlow(root, slug, store);
      const recorded = recordMenuChoice(
        root,
        slug,
        plan,
        "subagent-driven",
        openEvidence(store, "s", "subagent-driven"),
        { hostWorkspace: root, role: "coordinator", sessionId: "coord-1" },
      );
      expect(recorded.ok).toBe(true);
      mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
      writeFileSync(
        path.join(root, "docs", slug, "sdd", "progress.md"),
        "Task 1: complete (commits abc1234..def5678, review clean)\n",
      );
      const completed = transitionExecution(
        root,
        slug,
        plan,
        "complete",
        cliEvidence(),
        undefined,
        {
          verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: root }),
        },
      );
      expect(completed.ok).toBe(true);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok).toBe(true);
      if (!effective.ok) return;
      expect(effective.state.execution.status).toBe("completed");
      expect(effective.state.execution.coordinator_session_id).toBeNull();
    } finally {
      cleanup(root);
    }
  });
});
