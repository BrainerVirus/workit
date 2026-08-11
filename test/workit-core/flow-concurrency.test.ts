import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COORDINATOR_RECOVERY_TEXT,
  assertProductGates,
  prepareFlowState,
  readFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
  writeFlowStateIfCurrent,
  type MutationContext,
} from "../../packages/workit-core/src/core/flow-state";
import { findActiveSubagentDrivenPlans } from "../../packages/workit-core/src/core/detector";
import { COMPLIANT_PLAN, COMPLIANT_SPEC, evidence } from "./flow-fixtures";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-concurrency-"));
  const slug = "conc-flow";
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const coordinator = (root: string, sessionId = "coordinator-session"): MutationContext => ({
  hostWorkspace: root,
  role: "coordinator",
  sessionId,
});

const delegated = (root: string, taskIdentity = "workit-worker"): MutationContext => ({
  hostWorkspace: root,
  role: "delegated",
  sessionId: `task-${taskIdentity}`,
  taskIdentity,
});

const writeDocs = (root: string, slug: string) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
};

const approveSpecAndPlan = (root: string, slug: string) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  for (const step of [
    transitionSpec(root, slug, spec, evidence("opencode", "Approve spec")),
    transitionSpec(root, slug, spec, evidence("opencode", "Approve spec")),
    transitionPlan(root, slug, plan, evidence("opencode", "Approve plan")),
    transitionPlan(root, slug, plan, evidence("opencode", "Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
};

const establishSubagentDriven = (root: string, slug: string) => {
  writeDocs(root, slug);
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, {
    spec_path: `docs/${slug}/spec.md`,
    plan_path: plan,
  });
  if (!prep.ok) throw new Error(prep.error);
  approveSpecAndPlan(root, slug);
  const recorded = recordMenuChoice(
    root,
    slug,
    plan,
    "subagent-driven",
    evidence("opencode", "subagent-driven"),
  );
  if (!recorded.ok) throw new Error(recorded.error);
};

const flowFile = (root: string, slug: string) => path.join(root, "docs", slug, "sdd", "flow.json");

test("CA-20: coordinator product edits are blocked after subagent-driven selection", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe("coordinator_blocked");
      expect(gate.error).toContain(COORDINATOR_RECOVERY_TEXT);
    }
  } finally {
    cleanup(root);
  }
});

test("CA-20: coordinator stays allowed when the menu was not subagent-driven", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);
    const recorded = recordMenuChoice(root, slug, plan, "handoff", evidence("opencode", "handoff"));
    expect(recorded.ok).toBe(true);
    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-20: authenticated delegated workers are allowed; unauthenticated ones are not", () => {
  const { root, slug } = fixture();
  try {
    establishSubagentDriven(root, slug);
    const allowed = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      delegated(root),
    );
    expect(allowed.ok).toBe(true);
    const unauthenticated = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      { hostWorkspace: root, role: "delegated", sessionId: "worker-without-identity" },
    );
    expect(unauthenticated.ok).toBe(false);
    if (!unauthenticated.ok) expect(unauthenticated.code).toBe("delegated_unauthenticated");
  } finally {
    cleanup(root);
  }
});

test("CA-21: active discovery uses the host workspace, not process.cwd()", () => {
  const { root, slug } = fixture();
  const other = mkdtempSync(path.join(os.tmpdir(), "wf-unrelated-cwd-"));
  const previous = process.cwd();
  try {
    establishSubagentDriven(root, slug);
    process.chdir(other);
    try {
      expect(findActiveSubagentDrivenPlans(root)).toEqual([slug]);
      expect(findActiveSubagentDrivenPlans(other)).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup(root);
  }
});

test("FG-08/CA-21: unique per-write temp names never reuse a shared <file>.tmp", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const stale = `${flowFile(root, slug)}.tmp`;
    writeFileSync(stale, "stale-writer-buffer", "utf8");
    const result = transitionSpec(
      root,
      slug,
      `docs/${slug}/spec.md`,
      evidence("opencode", "Approve spec"),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(stale, "utf8")).toBe("stale-writer-buffer");
    expect(readFlowState(root, slug).spec.status).toBe("self_reviewed");
  } finally {
    cleanup(root);
  }
});

test("FG-08: stale concurrent writers are preserved via compare/retry, never clobbered", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: plan,
    });
    expect(prep.ok).toBe(true);
    approveSpecAndPlan(root, slug);

    const stale = readFlowState(root, slug);
    expect(stale.menu.presented).toBe(false);

    const newerNext = {
      ...stale,
      menu: { presented: true, chosen: "subagent-driven", evidence: null },
      updated_at: Date.now(),
    };
    const freshCommit = writeFlowStateIfCurrent(root, stale, newerNext);
    expect(freshCommit.ok).toBe(true);

    const clobbering = writeFlowStateIfCurrent(root, stale, {
      ...stale,
      menu: { presented: true, chosen: "handoff", evidence: null },
      updated_at: Date.now(),
    });
    expect(clobbering.ok).toBe(false);
    if (!clobbering.ok) expect(clobbering.conflict).toBe(true);
    expect(readFlowState(root, slug).menu.chosen).toBe("subagent-driven");
  } finally {
    cleanup(root);
  }
});

test("FG-08: a transition re-reads and retries on the fresh state after a concurrent commit", () => {
  const { root, slug } = fixture();
  try {
    writeDocs(root, slug);
    const prep = prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    expect(prep.ok).toBe(true);
    const concurrent = readFlowState(root, slug);
    const committed = writeFlowStateIfCurrent(root, concurrent, {
      ...concurrent,
      menu: { presented: true, chosen: "inline", evidence: null },
      updated_at: Date.now(),
    });
    expect(committed.ok).toBe(true);

    const result = transitionSpec(
      root,
      slug,
      `docs/${slug}/spec.md`,
      evidence("opencode", "Approve spec"),
    );
    expect(result.ok).toBe(true);
    const finalState = readFlowState(root, slug);
    expect(finalState.spec.status).toBe("self_reviewed");
    expect(finalState.menu.chosen).toBe("inline");
  } finally {
    cleanup(root);
  }
});

test("CA-28: a failed-session fixture cannot be skipped and keeps flow state isolated", () => {
  const { root, slug } = fixture();
  try {
    const dir = path.join(root, "docs", slug, "sdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "flow.json.tmp"), '{"partial":', "utf8");

    const gate = assertProductGates(
      root,
      slug,
      { requireMenu: true, requireDocs: true },
      coordinator(root),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("spec_not_approved");

    const transition = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(transition.ok).toBe(false);
    if (!transition.ok) expect(transition.code).toBe("flow_not_activated");

    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
    expect(existsSync(flowFile(root, slug))).toBe(false);
  } finally {
    cleanup(root);
  }
});
