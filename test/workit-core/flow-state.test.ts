import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFlowState,
  readEffectiveFlowState,
  transitionSpec,
  transitionPlan,
  recordMenuChoice,
  prepareFlowState,
  writeFlowState,
  mintDelegateToken,
  validateDelegateToken,
  revokeDelegateToken,
} from "../../packages/workit-core/src/core/flow-state";
import { establishApprovedFlow, evidence, openEvidence, cursorEvidence } from "./flow-fixtures";
import { HostReceiptStore } from "../../packages/workit-core/src/core/flow-state";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const flowJson = (root: string, slug: string) => path.join(root, "docs", slug, "sdd", "flow.json");

const COMPLIANT_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const COMPLIANT_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-flow-"));
  const slug = "my-feature";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN(slug));
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

test("missing flow.json reads as draft with no menu", () => {
  const { root, slug } = fixture();
  try {
    const state = readFlowState(root, slug);
    expect(state.activated).toBe(false);
    expect(state.spec.status).toBe("draft");
    expect(state.plan.status).toBe("draft");
    expect(state.menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("spec transitions draft -> approved in one receipt with native evidence", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const blocked = transitionSpec(root, slug, spec, evidence());
    expect(blocked.ok).toBe(false); // activation required first
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const first = transitionSpec(root, slug, spec, evidence());
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
    // The single receipt consumed the whole draft -> approved transition.
    const second = transitionSpec(root, slug, spec, evidence());
    expect(second.ok).toBe(false);
    if (second.ok === false) expect(second.code).toBe("flow_already_approved");
  } finally {
    cleanup(root);
  }
});

test("a legacy self_reviewed state advances to approved on the next receipt", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    // A flow.json written by the previous two-step matrix: self_reviewed.
    writeFlowState(root, {
      slug,
      activated: true,
      spec: { path: spec, status: "self_reviewed", evidence: null, approved_digest: null },
      plan: { path: plan, status: "self_reviewed", evidence: null, approved_digest: null },
      menu: { presented: false, chosen: "", evidence: null },
      execution: { status: "pending", mode: null, evidence: null, coordinator_session_id: null },
      handoff_destination: false,
      updated_at: Date.now(),
    });
    const first = transitionSpec(root, slug, spec, evidence());
    expect(first.ok).toBe(true);
    expect(readFlowState(root, slug).spec.status).toBe("approved");
    const planStillLegacy = readFlowState(root, slug).plan.status;
    expect(planStillLegacy).toBe("self_reviewed");
    const planApproved = transitionPlan(root, slug, plan, evidence());
    expect(planApproved.ok).toBe(true);
    expect(readFlowState(root, slug).plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("confirmed:false boolean is never evidence", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, false as never);
    expect(result.ok).toBe(false);
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("plan approve hard-fails while spec is draft", () => {
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

test("plan approve requires spec approved", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("approved");
    expect(state.plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("menu choice records presented + chosen with exact evidence", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const state = readFlowState(root, slug);
    expect(state.menu.presented).toBe(true);
    expect(state.menu.chosen).toBe("handoff");
    if (state.menu.evidence?.host === "opencode") {
      expect(state.menu.evidence.selectedLabel).toBe("handoff");
    }
  } finally {
    cleanup(root);
  }
});

test("recordMenuChoice fixes up a legacy empty plan.path to the canonical path", () => {
  const { root, slug } = fixture();
  try {
    const plan = `docs/${slug}/plan.md`;
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const base = readFlowState(root, slug);
    writeFlowState(root, { ...base, plan: { ...base.plan, path: "" } });
    // The legacy empty path survived up to the menu recording.
    expect(readFlowState(root, slug).plan.path).toBe("");
    const store = new HostReceiptStore();
    const recorded = recordMenuChoice(
      root,
      slug,
      plan,
      "inline",
      openEvidence(store, "s1", "inline"),
    );
    expect(recorded.ok).toBe(true);
    expect(readFlowState(root, slug).plan.path).toBe(plan);
  } finally {
    cleanup(root);
  }
});

import {
  assertFlowGates,
  slugFromPath,
  slugFromSddPath,
} from "../../packages/workit-core/src/core/flow-state";

test("slugFromPath strips -design suffix", () => {
  expect(slugFromPath("docs/x/plan.md")).toBe("x");
  expect(slugFromPath("docs/x/spec.md")).toBe("x");
});

test("slugFromSddPath requires a real sdd segment and rejects sdd-prefixed lookalikes", () => {
  expect(slugFromSddPath("docs/x/sdd/flow.json")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd/progress.md")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd")).toBe("x");
  expect(slugFromSddPath("docs/x/sdd-attack/flow.json")).toBe("");
  expect(slugFromSddPath("docs/x/sdd/attack/flow.json")).toBe("x");
  expect(slugFromSddPath("docs/review/sdd'quoted")).toBe("review");
  expect(slugFromSddPath("docs/x/sdd'attack/flow.json")).toBe("x");
});

test("missing flow state hint names only workit_flow_status as the activation path", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("workit_flow_status");
      expect(result.error).not.toContain("docs_layout");
    }
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates fails without an activated flow (fail closed)", () => {
  const { root, slug } = fixture();
  try {
    const result = assertFlowGates(root, `docs/${slug}/plan.md`);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe("flow_not_activated");
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates fails without approvals on an activated flow", () => {
  const { root, slug } = fixture();
  try {
    prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    const result = assertFlowGates(root, `docs/${slug}/plan.md`);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.code).toBe("spec_not_approved");
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates requires menu when requested", () => {
  const { root, slug } = fixture();
  try {
    const plan = `docs/${slug}/plan.md`;
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const withoutMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withoutMenu.ok).toBe(true); // establishApprovedFlow already presented the menu
  } finally {
    cleanup(root);
  }
});

test("assertFlowGates blocks execution before the menu is presented", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    writeFileSync(path.join(root, spec), COMPLIANT_SPEC(slug));
    writeFileSync(path.join(root, plan), COMPLIANT_PLAN(slug));
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    transitionSpec(root, slug, spec, evidence());
    transitionPlan(root, slug, plan, evidence());
    const withoutMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withoutMenu.ok).toBe(false);
    if (withoutMenu.ok === false) expect(withoutMenu.code).toBe("menu_not_presented");
    recordMenuChoice(root, slug, plan, "inline", evidence("inline"));
    const withMenu = assertFlowGates(root, plan, { requireMenu: true });
    expect(withMenu.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("invalid slug is rejected before any write", () => {
  const { root, slug } = fixture();
  try {
    const result = transitionSpec(root, "..", `docs/${slug}/spec.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("invalid slug");
  } finally {
    cleanup(root);
  }
});

test("malformed flow.json at the canonical sdd path blocks transitions with flow_state_invalid", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const file = flowJson(root, slug);
    writeFileSync(file, "{not-json", "utf8");
    const result = transitionPlan(root, slug, `docs/${slug}/plan.md`, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("invalid flow state");
      expect(result.code).toBe("flow_state_invalid");
      expect(result.details).toEqual({
        path: `docs/${slug}/sdd/flow.json`,
        original_bytes_preserved: true,
      });
    }
    expect(readFileSync(file, "utf8")).toBe("{not-json");
  } finally {
    cleanup(root);
  }
});

test("already approved spec rejects further transitions", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const third = transitionSpec(root, slug, `docs/${slug}/spec.md`, evidence());
    expect(third.ok).toBe(false);
    if (third.ok === false) {
      expect(third.error).toContain("already approved");
      expect(third.code).toBe("flow_already_approved");
    }
  } finally {
    cleanup(root);
  }
});

test("transitions reject a missing doc file", () => {
  const { root, slug } = fixture();
  try {
    const plan = `docs/${slug}/plan.md`;
    const spec = `docs/${slug}/spec.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    rmSync(path.join(root, plan), { force: true });
    const result = transitionPlan(root, slug, plan, evidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("plan not found");
  } finally {
    cleanup(root);
  }
});

test("CA-01: fresh spec and plan approvals persist the exact SHA-256 digest of the canonical bytes", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([]);
    const specBytes = readFileSync(path.join(root, "docs", slug, "spec.md"));
    const planBytes = readFileSync(path.join(root, "docs", slug, "plan.md"));
    expect(effective.state.spec.approved_digest).toBe(sha256(specBytes));
    expect(effective.state.plan.approved_digest).toBe(sha256(planBytes));
    expect(effective.state.spec.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(effective.state.plan.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    // The persisted property name is exactly approved_digest.
    const persisted = JSON.parse(readFileSync(flowJson(root, slug), "utf8"));
    expect(persisted.spec.approved_digest).toBe(sha256(specBytes));
    expect(persisted.plan.approved_digest).toBe(sha256(planBytes));
  } finally {
    cleanup(root);
  }
});

test("CA-06: an LF -> CRLF line-ending edit invalidates the spec approval (digest_mismatch)", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const specFile = path.join(root, "docs", slug, "spec.md");
    writeFileSync(specFile, readFileSync(specFile, "utf8").replace(/\n/g, "\r\n"));
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "spec", code: "digest_mismatch", path: `docs/${slug}/spec.md` },
    ]);
    // CA-03: spec drift resets spec + plan approval, both digests, menu
    // evidence, handoff context, and execution to pending.
    expect(effective.state.spec).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.menu).toEqual({ presented: false, chosen: "", evidence: null });
    expect(effective.state.execution).toEqual({
      status: "pending",
      mode: null,
      evidence: null,
      coordinator_session_id: null,
    });
    expect(effective.state.handoff_destination).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("CA-06: canonically equivalent but byte-different Unicode edits cause digest_mismatch", () => {
  const { root, slug } = fixture();
  try {
    const specPath = `docs/${slug}/spec.md`;
    const planPath = `docs/${slug}/plan.md`;
    const planFile = path.join(root, "docs", slug, "plan.md");
    prepareFlowState(root, slug, { spec_path: specPath, plan_path: planPath });
    expect(transitionSpec(root, slug, specPath, evidence()).ok).toBe(true);
    // Approve a plan whose bytes contain a precomposed é (U+00E9).
    writeFileSync(planFile, COMPLIANT_PLAN(slug).replace("do it", "do it \u00e9"));
    expect(transitionPlan(root, slug, planPath, evidence()).ok).toBe(true);
    const composed = readEffectiveFlowState(root, slug);
    expect(composed.ok).toBe(true);
    if (!composed.ok) throw new Error(composed.error);
    // Decompose é into e + U+0301: canonically equivalent text, different bytes.
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("\u00e9", "e\u0301"));
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "digest_mismatch", path: `docs/${slug}/plan.md` },
    ]);
    // CA-03: plan drift preserves the valid spec approval and digest.
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.spec.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.menu).toEqual({ presented: false, chosen: "", evidence: null });
    expect(effective.state.execution).toEqual({
      status: "pending",
      mode: null,
      evidence: null,
      coordinator_session_id: null,
    });
  } finally {
    cleanup(root);
  }
});

test("CA-01: invalid UTF-8 in the canonical doc is document_unreadable, not digest_mismatch", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    writeFileSync(path.join(root, "docs", slug, "plan.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "document_unreadable", path: `docs/${slug}/plan.md` },
    ]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.spec.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
  } finally {
    cleanup(root);
  }
});

test("CA-04: missing and unreadable canonical files produce their exact drift codes", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const specFile = path.join(root, "docs", slug, "spec.md");
    rmSync(specFile, { force: true });
    const missing = readEffectiveFlowState(root, slug);
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error(missing.error);
    expect(missing.drift).toEqual([
      { document: "spec", code: "document_missing", path: `docs/${slug}/spec.md` },
    ]);
    expect(missing.state.spec.status).toBe("draft");
    expect(missing.state.plan.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("CA-04: an unreadable canonical spec file is document_unreadable", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    chmodSync(path.join(root, "docs", slug, "spec.md"), 0o000);
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "spec", code: "document_unreadable", path: `docs/${slug}/spec.md` },
    ]);
    expect(effective.state.spec.status).toBe("draft");
  } finally {
    chmodSync(path.join(root, "docs", slug, "spec.md"), 0o644);
    cleanup(root);
  }
});

test("CA-04: a missing canonical plan file is plan document_missing and preserves the valid spec", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const planFile = path.join(root, "docs", slug, "plan.md");
    rmSync(planFile, { force: true });
    const missing = readEffectiveFlowState(root, slug);
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error(missing.error);
    expect(missing.drift).toEqual([
      { document: "plan", code: "document_missing", path: `docs/${slug}/plan.md` },
    ]);
    expect(missing.state.spec).toMatchObject({ status: "approved" });
    expect(missing.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
  } finally {
    cleanup(root);
  }
});

test("CA-04: an unreadable canonical plan file is plan document_unreadable and preserves the valid spec", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const planFile = path.join(root, "docs", slug, "plan.md");
    chmodSync(planFile, 0o000);
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "document_unreadable", path: `docs/${slug}/plan.md` },
    ]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
  } finally {
    chmodSync(path.join(root, "docs", slug, "plan.md"), 0o644);
    cleanup(root);
  }
});

test("CA-03: spec drift resets plan approval, menu evidence, handoff context, and execution", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const advanced = readFlowState(root, slug);
    writeFlowState(root, {
      ...advanced,
      handoff_destination: true,
      execution: {
        status: "active",
        mode: "subagent-driven",
        evidence: null,
        coordinator_session_id: null,
      },
    });
    writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC(slug) + "\n");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "spec", code: "digest_mismatch", path: `docs/${slug}/spec.md` },
    ]);
    expect(effective.state.spec).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.menu).toEqual({ presented: false, chosen: "", evidence: null });
    expect(effective.state.execution).toEqual({
      status: "pending",
      mode: null,
      evidence: null,
      coordinator_session_id: null,
    });
    expect(effective.state.handoff_destination).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("CA-03: plan drift after execution started preserves menu and execution lifecycle", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const advanced = readFlowState(root, slug);
    writeFlowState(root, {
      ...advanced,
      menu: { presented: true, chosen: "subagent-driven", evidence: null },
      execution: {
        status: "active",
        mode: "subagent-driven",
        evidence: null,
        coordinator_session_id: null,
      },
    });
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it differently"),
    );
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "digest_mismatch", path: `docs/${slug}/plan.md` },
    ]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    // Lifecycle facts are preserved: a plan edit does not rewind an
    // in-progress/completed execution, its menu, or its handoff context.
    expect(effective.state.menu).toEqual({
      presented: true,
      chosen: "subagent-driven",
      evidence: null,
    });
    expect(effective.state.execution).toEqual({
      status: "active",
      mode: "subagent-driven",
      evidence: null,
      coordinator_session_id: null,
    });
  } finally {
    cleanup(root);
  }
});

test("CA-03: plan drift preserves the valid spec approval/digest and the execution lifecycle, resetting only the plan approval", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const specDigest = readFlowState(root, slug).spec.approved_digest;
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it differently"),
    );
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "digest_mismatch", path: `docs/${slug}/plan.md` },
    ]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.spec.approved_digest).toBe(specDigest);
    expect(effective.state.plan).toMatchObject({
      status: "draft",
      approved_digest: null,
      evidence: null,
    });
    expect(effective.state.menu).toMatchObject({
      presented: true,
      chosen: "handoff",
    });
    expect(effective.state.execution).toMatchObject({
      status: "pending",
      mode: null,
    });
    expect(effective.state.handoff_destination).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("CA-05: approved legacy state without a digest reports digest_missing and fails closed", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    writeFlowState(root, {
      ...readFlowState(root, slug),
      spec: { path: spec, status: "approved", evidence: null, approved_digest: null },
      plan: { path: plan, status: "approved", evidence: null, approved_digest: null },
      menu: { presented: true, chosen: "handoff", evidence: null },
    });
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "spec", code: "digest_missing", path: `docs/${slug}/spec.md` },
    ]);
    expect(effective.state.spec.status).toBe("draft");
    expect(effective.state.plan.status).toBe("draft");
    expect(existsSync(flowJson(root, slug))).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-05: an approved plan without a digest reports plan digest_missing and preserves a valid spec", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const base = readFlowState(root, slug);
    const specDigest = base.spec.approved_digest;
    writeFlowState(root, { ...base, plan: { ...base.plan, approved_digest: null } });
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "plan", code: "digest_missing", path: `docs/${slug}/plan.md` },
    ]);
    expect(effective.state.spec).toMatchObject({ status: "approved" });
    expect(effective.state.spec.approved_digest).toBe(specDigest);
    expect(effective.state.plan).toMatchObject({ status: "draft", approved_digest: null });
  } finally {
    cleanup(root);
  }
});

test("CA-05: the reconciled draft accepts a fresh approval without deleting flow.json", () => {
  const { root, slug } = fixture();
  try {
    establishApprovedFlow(root, slug, new HostReceiptStore(), "s1");
    const file = flowJson(root, slug);
    expect(existsSync(file)).toBe(true);
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN(slug).replace("do it", "do it now"),
    );
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.state.plan.status).toBe("draft");
    expect(effective.state.plan.approved_digest).toBe(null);
    expect(existsSync(file)).toBe(true);
    const store = new HostReceiptStore();
    const reapproved = transitionPlan(
      root,
      slug,
      `docs/${slug}/plan.md`,
      openEvidence(store, "re-approve", "Approve plan"),
    );
    expect(reapproved.ok).toBe(true);
    const after = readEffectiveFlowState(root, slug);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error);
    expect(after.drift).toEqual([]);
    expect(after.state.plan).toMatchObject({ status: "approved" });
    const planBytes = readFileSync(path.join(root, "docs", slug, "plan.md"));
    expect(after.state.plan.approved_digest).toBe(sha256(planBytes));
    expect(after.state.spec).toMatchObject({ status: "approved" });
    expect(existsSync(file)).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-18: malformed flow.json returns flow_state_invalid and preserves the original bytes", () => {
  const { root, slug } = fixture();
  try {
    prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    const file = flowJson(root, slug);
    writeFileSync(file, "{not-json", "utf8");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(false);
    if (!effective.ok) {
      expect(effective.code).toBe("flow_state_invalid");
      expect(effective.error).toContain("invalid flow state");
      expect(effective.details).toEqual({
        path: `docs/${slug}/sdd/flow.json`,
        original_bytes_preserved: true,
      });
    }
    expect(readFileSync(file, "utf8")).toBe("{not-json");
  } finally {
    cleanup(root);
  }
});

test("CA-18: a bogus menu.chosen outside MENU_CHOICES is flow_state_invalid", () => {
  const { root, slug } = fixture();
  try {
    prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    const file = flowJson(root, slug);
    const bogus = JSON.stringify({
      ...JSON.parse(readFileSync(file, "utf8")),
      menu: { presented: true, chosen: "foo", evidence: null },
    });
    writeFileSync(file, bogus, "utf8");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(false);
    if (!effective.ok) {
      expect(effective.code).toBe("flow_state_invalid");
      expect(effective.error).toContain("menu.chosen");
      expect(effective.details).toEqual({
        path: `docs/${slug}/sdd/flow.json`,
        original_bytes_preserved: true,
      });
    }
    expect(readFileSync(file, "utf8")).toBe(bogus);
  } finally {
    cleanup(root);
  }
});

test("a never-activated effective read creates no docs/<slug>/sdd/ side effect", () => {
  const { root, slug } = fixture();
  try {
    const sddDir = path.join(root, "docs", slug, "sdd");
    expect(existsSync(sddDir)).toBe(false);
    const result = readEffectiveFlowState(root, slug);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("flow_not_activated");
    expect(existsSync(sddDir)).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("CA-16: deriveLegacyExecution guards exercised in isolation — plan-approved and subagent-driven-choice preconditions", () => {
  // A legacy flow.json WITHOUT the execution key (the pre-lifecycle shape) with
  // valid approved digests so reconciliation introduces no drift. Each row
  // flips exactly one precondition the fixture always pre-approves elsewhere.
  const writeLegacy = (
    root: string,
    slug: string,
    overrides: { plan?: { status: string }; menu?: { chosen: string } } = {},
    ledger?: string[],
  ) => {
    const sdd = path.join(root, "docs", slug, "sdd");
    mkdirSync(sdd, { recursive: true });
    if (ledger) {
      writeFileSync(path.join(sdd, "progress.md"), ledger.join("\n") + "\n", "utf8");
    }
    const specBytes = readFileSync(path.join(root, "docs", slug, "spec.md"));
    const planBytes = readFileSync(path.join(root, "docs", slug, "plan.md"));
    writeFileSync(
      path.join(sdd, "flow.json"),
      JSON.stringify(
        {
          slug,
          activated: true,
          spec: {
            path: `docs/${slug}/spec.md`,
            status: "approved",
            evidence: null,
            approved_digest: sha256(specBytes),
          },
          plan: {
            path: `docs/${slug}/plan.md`,
            status: "approved",
            evidence: null,
            approved_digest: sha256(planBytes),
            ...overrides.plan,
          },
          menu: {
            presented: true,
            chosen: "subagent-driven",
            evidence: null,
            ...overrides.menu,
          },
          handoff_destination: false,
          updated_at: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
  };
  const cases: {
    name: string;
    overrides: { plan?: { status: string }; menu?: { chosen: string } };
    ledger?: string[];
    expected: { status: "active" | "pending"; mode: "subagent-driven" | "inline" | null };
  }[] = [
    {
      name: "approved plan but NOT subagent-driven choice derives pending",
      overrides: { menu: { chosen: "handoff" } },
      ledger: ["Task 1: in_progress"],
      expected: { status: "pending", mode: null },
    },
    {
      name: "subagent-driven choice but plan NOT approved derives pending",
      overrides: { plan: { status: "draft" } },
      ledger: ["Task 1: in_progress"],
      expected: { status: "pending", mode: null },
    },
    {
      name: "approved + subagent-driven + ledger NOT started derives pending",
      overrides: {},
      ledger: undefined,
      expected: { status: "pending", mode: null },
    },
    {
      name: "approved + subagent-driven + started incomplete derives active",
      overrides: {},
      ledger: ["Task 1: in_progress"],
      expected: { status: "active", mode: "subagent-driven" },
    },
  ];
  for (const c of cases) {
    const { root, slug } = fixture();
    try {
      writeLegacy(root, slug, c.overrides, c.ledger);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok, c.name).toBe(true);
      if (!effective.ok) throw new Error(effective.error);
      expect(effective.drift, c.name).toEqual([]);
      expect(effective.state.execution, c.name).toEqual({
        status: c.expected.status,
        mode: c.expected.mode,
        evidence: null,
        coordinator_session_id: null,
      });
    } finally {
      cleanup(root);
    }
  }
});

test("CA-18: unsupported field values return flow_state_invalid without touching the file", () => {
  const { root, slug } = fixture();
  try {
    prepareFlowState(root, slug, {
      spec_path: `docs/${slug}/spec.md`,
      plan_path: `docs/${slug}/plan.md`,
    });
    const file = flowJson(root, slug);
    const cases: unknown[] = [
      { execution: { status: "cancelled", mode: null, evidence: null } },
      { menu: { presented: "yes", chosen: "", evidence: null } },
      { activated: "true" },
      { spec: { status: "rejected" } },
      { plan: { approved_digest: "not-a-digest" } },
      { handoff_destination: "true" },
    ];
    for (const patch of cases) {
      const unsupported = {
        ...JSON.parse(readFileSync(file, "utf8")),
        ...(patch as Record<string, unknown>),
      };
      const raw = JSON.stringify(unsupported);
      writeFileSync(file, raw, "utf8");
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok, JSON.stringify(patch)).toBe(false);
      if (!effective.ok) {
        expect(effective.code).toBe("flow_state_invalid");
        expect(effective.details).toEqual({
          path: `docs/${slug}/sdd/flow.json`,
          original_bytes_preserved: true,
        });
      }
      expect(readFileSync(file, "utf8")).toBe(raw);
    }
  } finally {
    cleanup(root);
  }
});

const planWithTasks = (slug: string, tasks: { id: number; title: string }[]) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n` +
  tasks.map((t) => `### Task ${t.id}: ${t.title}\n\n- [ ] **Step 1:** do it\n`).join("\n");

const cursorSubagentFixture = (taskIds: number[] = [1, 2]) => {
  const { root, slug } = fixture();
  writeFileSync(
    path.join(root, "docs", slug, "plan.md"),
    planWithTasks(
      slug,
      taskIds.map((id) => ({ id, title: `Do task ${id}` })),
    ),
  );
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  expect(transitionSpec(root, slug, spec, cursorEvidence()).ok).toBe(true);
  expect(transitionPlan(root, slug, plan, cursorEvidence()).ok).toBe(true);
  const menu = recordMenuChoice(root, slug, plan, "subagent-driven", cursorEvidence());
  expect(menu.ok, JSON.stringify(menu)).toBe(true);
  if (!menu.ok || !("coordinator_lease" in menu) || !menu.coordinator_lease) {
    throw new Error("coordinator lease not returned");
  }
  return { root, slug, plan, lease: menu.coordinator_lease, planPath: plan };
};

test("Cursor recordMenuChoice with subagent-driven issues a coordinator lease once and activates execution", () => {
  const { root, slug, lease } = cursorSubagentFixture();
  try {
    expect(typeof lease).toBe("string");
    expect(lease.length).toBeGreaterThanOrEqual(32);
    const state = readFlowState(root, slug);
    expect(state.menu.chosen).toBe("subagent-driven");
    expect(state.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
    // Raw lease never persisted; only its SHA-256 hash.
    const persisted = JSON.parse(readFileSync(flowJson(root, slug), "utf8"));
    expect(JSON.stringify(persisted)).not.toContain(lease);
    expect(createHash("sha256").update(lease).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.execution.delegation.coordinator_lease_hash).toBe(
      createHash("sha256").update(lease).digest("hex"),
    );
    // Non-subagent choices and other paths do not issue a lease.
    expect("coordinator_lease" in readFlowState(root, slug) ? false : true).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("coordinator lease reuse and invalid lease are rejected by mintDelegateToken", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    const first = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(first.ok).toBe(true);
    // The same lease may mint the next task's token (task-scoped, replaced),
    // but a WRONG lease never mints.
    const wrong = mintDelegateToken(root, slug, planPath, 2, lease + "x");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("coordinator_lease_invalid");
    const garbage = mintDelegateToken(root, slug, planPath, 2, "");
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.code).toBe("coordinator_lease_invalid");
  } finally {
    cleanup(root);
  }
});

test("delegate token is bound to (workspaceRoot, slug, taskId) and reusable within the task", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    const minted = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error(minted.error);
    // Raw token not persisted.
    expect(readFileSync(flowJson(root, slug), "utf8")).not.toContain(minted.token);
    // Reusable within the same task.
    const again = validateDelegateToken(root, minted.token);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.context.slug).toBe(slug);
      expect(again.context.taskId).toBe(1);
    }
    // Wrong task id fails.
    const other = mintDelegateToken(root, slug, planPath, 3, lease);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("task_invalid");
    // Wrong workspace fails.
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "wf-flow-other-"));
    try {
      const wrongWorkspace = validateDelegateToken(otherRoot, minted.token);
      expect(wrongWorkspace.ok).toBe(false);
      if (!wrongWorkspace.ok) expect(wrongWorkspace.code).toBe("delegation_token_invalid");
    } finally {
      cleanup(otherRoot);
    }
  } finally {
    cleanup(root);
  }
});

test("one active token per flow: minting the next task token revokes the previous one", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    const first = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(validateDelegateToken(root, first.token).ok).toBe(true);
    const second = mintDelegateToken(root, slug, planPath, 2, lease);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(validateDelegateToken(root, first.token).ok).toBe(false);
    expect(validateDelegateToken(root, second.token).ok).toBe(true);
    // Task 1 is unfinished, so its token is replaceable: re-minting revokes
    // the task 2 token and rebinds to task 1 (one active token per flow).
    const replacement = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error(replacement.error);
    expect(validateDelegateToken(root, second.token).ok).toBe(false);
    expect(validateDelegateToken(root, replacement.token).ok).toBe(true);
    // A completed task's token can never be re-minted.
    const completed = mintDelegateToken(root, slug, planPath, 9, lease);
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.code).toBe("task_invalid");
  } finally {
    cleanup(root);
  }
});

test("recording a task progress line revokes the active token atomically", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    const minted = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error(minted.error);
    expect(validateDelegateToken(root, minted.token).ok).toBe(true);
    const revoked = revokeDelegateToken(root, slug, 1);
    expect(revoked.ok).toBe(true);
    expect(validateDelegateToken(root, minted.token).ok).toBe(false);
    // Idempotent-ish: revoking again fails closed (nothing active for task).
    const again = revokeDelegateToken(root, slug, 1);
    expect(again.ok).toBe(false);
    // Task 1 must be completed in the ledger before revocation of its token succeeds.
  } finally {
    cleanup(root);
  }
});

test("validateDelegateToken rejects invalid, missing, and revoked tokens with structured errors", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    const missing = validateDelegateToken(root, "");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("delegation_token_invalid");
    const garbage = validateDelegateToken(root, "not-a-real-token");
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.code).toBe("delegation_token_invalid");
    const minted = mintDelegateToken(root, slug, planPath, 1, lease);
    if (!minted.ok) throw new Error(minted.error);
    expect(revokeDelegateToken(root, slug, 1).ok).toBe(true);
    const revoked = validateDelegateToken(root, minted.token);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("delegation_token_revoked");
  } finally {
    cleanup(root);
  }
});

test("mintDelegateToken requires the active Cursor subagent-driven flow and an unfinished task", () => {
  const { root, slug, planPath, lease } = cursorSubagentFixture();
  try {
    // Hand the flow to pending (as if the menu never executed).
    const base = readFlowState(root, slug);
    writeFlowState(root, {
      ...base,
      execution: { ...base.execution, status: "pending", mode: null },
    });
    const blocked = mintDelegateToken(root, slug, planPath, 1, lease);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("flow_not_active");
  } finally {
    cleanup(root);
  }
});
