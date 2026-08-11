import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertHostEvidence,
  assertProductGates,
  createFlowEvidence,
  nextFlowStatus,
  prepareFlowState,
  readFlowState,
  recordMenuChoice,
  transitionPlan,
  transitionSpec,
} from "../../packages/workit-core/src/core/flow-state";

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-enforce-"));
  const slug = "my-feature";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const evidence = (host: "opencode" | "cursor" = "opencode", label = "Approve") => {
  const result = createFlowEvidence(host, `q-${label}`, label);
  if (!result.ok) throw new Error(result.error);
  return result.evidence;
};

const approveAll = (root: string, slug: string) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  expect(prep.ok).toBe(true);
  expect(transitionSpec(root, slug, spec, evidence()).ok).toBe(true);
  expect(transitionSpec(root, slug, spec, evidence()).ok).toBe(true);
  expect(transitionPlan(root, slug, plan, evidence()).ok).toBe(true);
  expect(transitionPlan(root, slug, plan, evidence()).ok).toBe(true);
  expect(recordMenuChoice(root, slug, plan, "handoff", evidence("opencode", "handoff")).ok).toBe(
    true,
  );
};

test("preparation records canonical paths and activation under docs/<slug>/sdd/", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(prep.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.activated).toBe(true);
    expect(state.spec.path).toBe(`docs/${slug}/spec.md`);
    expect(state.plan.path).toBe(`docs/${slug}/plan.md`);
    expect(existsSync(path.join(root, "docs", slug, "sdd", "flow.json"))).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("transitions reject missing flow state with a structured error (not silent pass)", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("not activated");
      expect(typeof result.code).toBe("string");
    }
  } finally {
    cleanup(root);
  }
});

test("transitions reject corrupt flow state with a structured error", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const flowFile = path.join(root, "docs", slug, "sdd", "flow.json");
    writeFileSync(flowFile, "{not-json", "utf8");
    const result = transitionSpec(root, slug, spec, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("corrupt");
      expect(result.code).toBe("flow_corrupt");
    }
  } finally {
    cleanup(root);
  }
});

test("bare booleans are rejected as fabricated evidence", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const bareTrue = transitionSpec(root, slug, spec, true as never);
    expect(bareTrue.ok).toBe(false);
    if (bareTrue.ok === false) expect(bareTrue.error).toMatch(/evidence/i);
    const bareFalse = transitionSpec(root, slug, spec, false as never);
    expect(bareFalse.ok).toBe(false);
    const confirmedObject = transitionSpec(root, slug, spec, { confirmed: true } as never);
    expect(confirmedObject.ok).toBe(false);
    if (confirmedObject.ok === false) expect(confirmedObject.error).toMatch(/evidence/i);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("forged evidence is rejected: empty label, bad host, and invalid timestamps", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const cases: unknown[] = [
      { host: "opencode", questionId: "q", selectedLabel: "", recordedAt: Date.now() },
      { host: "claude", questionId: "q", selectedLabel: "Approve", recordedAt: Date.now() },
      { host: "opencode", questionId: "", selectedLabel: "Approve", recordedAt: Date.now() },
      { host: "opencode", questionId: "q", selectedLabel: "Approve", recordedAt: 0 },
      {
        host: "opencode",
        questionId: "q",
        selectedLabel: "Approve",
        recordedAt: Date.now() + 999_999,
      },
    ];
    for (const forged of cases) {
      const result = transitionSpec(root, slug, spec, forged);
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.error).toMatch(/evidence|forged|stale|future/i);
    }
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("only exact native question results establish evidence", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const approved = evidence("opencode", "Approve spec");
    expect(transitionSpec(root, slug, spec, approved).ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("self_reviewed");
    expect(state.spec.evidence).toEqual(approved);
  } finally {
    cleanup(root);
  }
});

test("host-mismatched evidence is rejected by the shared host binding", () => {
  expect(assertHostEvidence("opencode", evidence("opencode")).ok).toBe(true);
  const wrong = assertHostEvidence("opencode", evidence("cursor"));
  expect(wrong.ok).toBe(false);
  if (wrong.ok === false) expect(wrong.error).toMatch(/cursor|host|forged/i);
});

test("plan writes are blocked until the spec is approved", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const result = transitionPlan(root, slug, plan, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("spec");
      expect(result.code).toBe("spec_not_approved");
    }
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("product mutation is blocked before spec/plan/menu/docs gates all pass", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const before = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(before.ok).toBe(false);
    if (before.ok === false) expect(before.code).toBe("flow_not_activated");

    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const draft = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(draft.ok).toBe(false);
    if (draft.ok === false) expect(draft.code).toBe("spec_not_approved");

    transitionSpec(root, slug, spec, evidence());
    transitionSpec(root, slug, spec, evidence());
    const noPlan = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(noPlan.ok).toBe(false);
    if (noPlan.ok === false) expect(noPlan.code).toBe("plan_not_approved");

    transitionPlan(root, slug, plan, evidence());
    transitionPlan(root, slug, plan, evidence());
    const noMenu = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(noMenu.ok).toBe(false);
    if (noMenu.ok === false) expect(noMenu.code).toBe("menu_not_presented");

    const noMenuOpt = assertProductGates(root, slug, { requireMenu: false, requireDocs: true });
    expect(noMenuOpt.ok).toBe(true);

    recordMenuChoice(root, slug, plan, "handoff", evidence("opencode", "handoff"));
    const all = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(all.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("product mutation fails docs validation when documents are invalid", () => {
  const { root, slug } = fixture();
  try {
    approveAll(root, slug);
    writeFileSync(path.join(root, "docs", slug, "plan.md"), "# broken");
    const gate = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(gate.ok).toBe(false);
    if (gate.ok === false) expect(gate.code).toBe("docs_invalid");
    const lax = assertProductGates(root, slug, { requireMenu: true, requireDocs: false });
    expect(lax.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("menu records only the exact selected label as evidence", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(transitionSpec(root, slug, spec, evidence()).ok).toBe(true);
    expect(transitionSpec(root, slug, spec, evidence()).ok).toBe(true);
    expect(transitionPlan(root, slug, plan, evidence()).ok).toBe(true);
    expect(transitionPlan(root, slug, plan, evidence()).ok).toBe(true);
    const mismatch = recordMenuChoice(root, slug, plan, "inline", evidence("opencode", "handoff"));
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok === false) expect(mismatch.code).toBe("evidence_mismatch");
    const invalid = recordMenuChoice(
      root,
      slug,
      plan,
      "not-an-option",
      evidence("opencode", "not-an-option"),
    );
    expect(invalid.ok).toBe(false);
    let state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(false);
    const recorded = recordMenuChoice(root, slug, plan, "inline", evidence("opencode", "inline"));
    expect(recorded.ok).toBe(true);
    state = readFlowState(root, slug);
    expect(state.menu).toMatchObject({ presented: true, chosen: "inline" });
    expect(state.menu.evidence?.selectedLabel).toBe("inline");
  } finally {
    cleanup(root);
  }
});

test("the shared transition matrix yields identical gate results for both transitions", () => {
  const { root, slug } = fixture();
  try {
    expect(nextFlowStatus("draft")).toEqual({ ok: true, next: "self_reviewed" });
    expect(nextFlowStatus("self_reviewed")).toEqual({ ok: true, next: "approved" });
    const done = nextFlowStatus("approved");
    expect(done.ok).toBe(false);
    if (done.ok === false) expect(done.code).toBe("flow_already_approved");

    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const specResult = transitionSpec(root, slug, spec, true as never);
    const planResult = transitionPlan(root, slug, plan, true as never);
    expect(specResult.ok).toBe(false);
    expect(planResult.ok).toBe(false);
    if (specResult.ok === false && planResult.ok === false) {
      expect(specResult.code).toBe("evidence_invalid");
      expect(planResult.code).toBe("evidence_invalid");
      expect(typeof specResult.error).toBe("string");
      expect(typeof planResult.error).toBe("string");
    }
    expect(readFlowState(root, slug).spec.status).toBe("draft");
    expect(readFlowState(root, slug).plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("approved flows can never regress via evidence replay", () => {
  const { root, slug } = fixture();
  try {
    approveAll(root, slug);
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const replay = transitionSpec(root, slug, spec, evidence());
    expect(replay.ok).toBe(false);
    if (replay.ok === false) expect(replay.code).toBe("flow_already_approved");
    const planReplay = transitionPlan(root, slug, plan, evidence());
    expect(planReplay.ok).toBe(false);
    if (planReplay.ok === false) expect(planReplay.code).toBe("flow_already_approved");
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("approved");
    expect(state.plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("flow state persists evidence provenance across reads", () => {
  const { root, slug } = fixture();
  try {
    approveAll(root, slug);
    const flow = JSON.parse(
      readFileSync(path.join(root, "docs", slug, "sdd", "flow.json"), "utf8"),
    ) as {
      spec: {
        evidence: { host: string; questionId: string; selectedLabel: string; recordedAt: number };
      };
      menu: { evidence: unknown };
    };
    expect(flow.spec.evidence.host).toBe("opencode");
    expect(flow.spec.evidence.questionId).toBe("q-Approve");
    expect(typeof flow.spec.evidence.recordedAt).toBe("number");
    expect(flow.menu.evidence).toBeDefined();
  } finally {
    cleanup(root);
  }
});

test("product gates use the strict read: missing flow state is flow_not_activated, never spec_not_approved", () => {
  const { root, slug } = fixture();
  try {
    const gate = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(gate.ok).toBe(false);
    if (gate.ok === false) {
      expect(gate.code).toBe("flow_not_activated");
      expect(gate.error).not.toContain("spec not approved");
    }
  } finally {
    cleanup(root);
  }
});

test("product gates use the strict read: corrupt flow state is flow_corrupt, not a silent draft fallback", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    writeFileSync(path.join(root, "docs", slug, "sdd", "flow.json"), "{not-json", "utf8");
    const gate = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(gate.ok).toBe(false);
    if (gate.ok === false) {
      expect(gate.code).toBe("flow_corrupt");
      expect(gate.error).toContain("corrupt");
    }
  } finally {
    cleanup(root);
  }
});
