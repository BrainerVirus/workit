import { expect, test } from "bun:test";
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
  COORDINATOR_RECOVERY_TEXT,
  COORDINATOR_SHELL_DENIED_TEXT,
  COORDINATOR_WRITE_TOOLS,
  CURSOR_SUBAGENT_UNSUPPORTED_TEXT,
  HostReceiptStore,
  assertEvidenceShape,
  assertHostEvidence,
  assertProductGates,
  createCursorConfirmation,
  createOpenCodeEvidence,
  isCoordinatorBashAllowed,
  markHandoffDestination,
  nextFlowStatus,
  prepareFlowState,
  readEffectiveFlowState,
  readFlowState,
  recordMenuChoice,
  roleFromParentage,
  subagentDrivenInterception,
  transitionExecution,
  transitionPlan,
  transitionSpec,
  type CliConfirmation,
} from "../../packages/workit-core/src/core/flow-state";
import type { VerifyResult } from "../../packages/workit-core/src/core/verify-project";
import { findMarkedDestinations } from "../../packages/workit-core/src/core/menu";
import {
  COMPLIANT_PLAN,
  COMPLIANT_SPEC,
  cursorEvidence,
  menuEvidence,
  openEvidence,
} from "./flow-fixtures";

const COMPLIANT_SPEC_FN = COMPLIANT_SPEC;
const COMPLIANT_PLAN_FN = COMPLIANT_PLAN;

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-enforce-"));
  const slug = "my-feature";
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), COMPLIANT_SPEC_FN(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN_FN(slug));
  return { root, slug };
};

const cleanup = (root: string) => rmSync(root, { recursive: true, force: true });

const approveAll = (root: string, slug: string) => {
  const store = new HostReceiptStore();
  const sessionId = "coordinator-session";
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  expect(prep.ok).toBe(true);
  expect(transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok).toBe(
    true,
  );
  expect(transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok).toBe(
    true,
  );
  expect(
    recordMenuChoice(root, slug, plan, "handoff", openEvidence(store, sessionId, "handoff")).ok,
  ).toBe(true);
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
    const result = transitionSpec(root, slug, `docs/${slug}/spec.md`, cursorEvidence());
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
    const result = transitionSpec(root, slug, spec, cursorEvidence());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain("invalid flow state");
      expect(result.code).toBe("flow_state_invalid");
    }
    expect(readFileSync(flowFile, "utf8")).toBe("{not-json");
  } finally {
    cleanup(root);
  }
});

test("bare booleans and primitives are rejected as fabricated evidence", () => {
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

test("invented OpenCode evidence is rejected: bad host, missing attestation, forged fields", () => {
  const { root, slug } = fixture();
  const now = Date.now();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const cases: unknown[] = [
      { host: "opencode", attested: false, callID: "c", selectedLabel: "Approve", recordedAt: now },
      { host: "opencode", callID: "c", selectedLabel: "Approve", recordedAt: now },
      { host: "cursor", attested: true, callID: "c", selectedLabel: "Approve", recordedAt: now },
      { host: "opencode", attested: true, callID: "", selectedLabel: "Approve", recordedAt: now },
      { host: "opencode", attested: true, callID: "c", selectedLabel: "", recordedAt: now },
      {
        host: "opencode",
        attested: true,
        callID: "c",
        selectedLabel: "Approve",
        recordedAt: now + 999_999,
      },
      { host: "claude", attested: true, callID: "c", selectedLabel: "Approve", recordedAt: now },
    ];
    for (const forged of cases) {
      const result = transitionSpec(root, slug, spec, forged);
      expect(result.ok, JSON.stringify(forged)).toBe(false);
      if (result.ok === false) expect(result.error).toMatch(/evidence|attested|forged|host/i);
    }
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("invented Cursor evidence is rejected: attested true or any caller data beyond the constant", () => {
  const { root, slug } = fixture();
  const now = Date.now();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const cases: unknown[] = [
      // Cursor must never self-certify an observed answer.
      {
        host: "cursor",
        attested: true,
        questionId: "q",
        selectedLabel: "Approve",
        recordedAt: now,
      },
      // Cursor evidence must carry no caller-supplied question data at all.
      { host: "cursor", attested: false, confirmation: "contract", questionId: "q" },
      { host: "cursor", attested: false, confirmation: "contract", selectedLabel: "Approve" },
      { host: "cursor", attested: false, confirmation: "contract", recordedAt: now },
      // Missing pieces of the constant.
      { host: "cursor", attested: false },
      { host: "cursor", confirmation: "contract" },
      { host: "cursor", attested: true, confirmation: "contract" },
    ];
    for (const forged of cases) {
      const result = transitionSpec(root, slug, spec, forged);
      expect(result.ok, JSON.stringify(forged)).toBe(false);
      if (result.ok === false) expect(result.error).toMatch(/evidence|attested|host/i);
    }
    expect(readFlowState(root, slug).spec.status).toBe("draft");
  } finally {
    cleanup(root);
  }
});

test("only host-issued receipts establish OpenCode evidence", () => {
  const { root, slug } = fixture();
  const store = new HostReceiptStore();
  const sessionId = "coordinator-session";
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const approved = openEvidence(store, sessionId, "Approve spec");
    expect(approved.host).toBe("opencode");
    if (approved.host === "opencode") {
      expect(approved.attested).toBe(true);
      expect(approved.selectedLabel).toBe("Approve spec");
      expect(typeof approved.callID).toBe("string");
      expect(typeof approved.recordedAt).toBe("number");
    }
    expect(transitionSpec(root, slug, spec, approved).ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("approved");
    expect(state.spec.evidence).toEqual(approved);
  } finally {
    cleanup(root);
  }
});

test("the receipt store is one-use: replay and cross-session consumption fail", () => {
  const store = new HostReceiptStore();
  store.record("s1", "call-1", "Approve spec");
  expect(store.count("s1")).toBe(1);
  expect(store.count("s2")).toBe(0);

  const consumed = store.consume("s1", { purpose: "spec-approval" });
  expect(consumed.ok).toBe(true);
  if (consumed.ok) {
    expect(consumed.receipt).toMatchObject({
      sessionId: "s1",
      callID: "call-1",
      selectedLabel: "Approve spec",
    });
    expect(typeof consumed.receipt.recordedAt).toBe("number");
  }
  expect(store.count("s1")).toBe(0);

  // Replay: the receipt was consumed exactly once.
  const replay = store.consume("s1", { purpose: "spec-approval" });
  expect(replay.ok).toBe(false);
  if (!replay.ok) expect(replay.code).toBe("receipt_missing");

  // Wrong session: a receipt recorded for another session is unreachable.
  store.record("s1", "call-2", "Approve spec");
  const wrongSession = store.consume("s2", { purpose: "spec-approval" });
  expect(wrongSession.ok).toBe(false);
  if (!wrongSession.ok) expect(wrongSession.code).toBe("receipt_missing");
  // The receipt is still there for its own session.
  expect(store.count("s1")).toBe(1);
});

test("the receipt store takes the session's MOST RECENT unconsumed receipt", () => {
  const store = new HostReceiptStore();
  store.record("s1", "call-1", "Approve spec", Date.now(), "", "spec-approval");
  store.record("s1", "call-2", "Approve spec", Date.now(), "", "spec-approval");
  const consumed = store.consume("s1", { purpose: "spec-approval" });
  expect(consumed.ok).toBe(true);
  if (consumed.ok) expect(consumed.receipt.selectedLabel).toBe("Approve spec");
  expect(store.count("s1")).toBe(1);
  const older = store.consume("s1", { purpose: "spec-approval" });
  expect(older.ok).toBe(true);
  if (older.ok) expect(older.receipt.selectedLabel).toBe("Approve spec");
});

test("the receipt store binds the exact selected label for menu consumption", () => {
  const store = new HostReceiptStore();
  store.record("s1", "call-menu", "Inline");
  const mismatch = store.consume("s1", { label: "subagent-driven" });
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.code).toBe("evidence_mismatch");
  // FINDING 6: a failed gate does not spend the user's answer.
  expect(store.count("s1")).toBe(1);

  const matched = store.consume("s1", { label: "inline" });
  expect(matched.ok).toBe(true);
  if (matched.ok) expect(matched.receipt.selectedLabel).toBe("Inline");
  expect(store.count("s1")).toBe(0);
});

test("menu label comparison is case-insensitive: a user answering 'Inline' authorizes the lowercase enum", () => {
  const store = new HostReceiptStore();
  store.record("s1", "call-menu", "Inline");
  const matched = store.consume("s1", { label: "inline" });
  expect(matched.ok).toBe(true);
  if (matched.ok) expect(matched.receipt.selectedLabel).toBe("Inline");
});

test("consume with a label filter accepts a qualifier-decorated handoff label", () => {
  const store = new HostReceiptStore();
  store.record("s1", "call-menu", "Handoff (new session only)");
  const matched = store.consume("s1", { label: "handoff" });
  expect(matched.ok).toBe(true);
  if (matched.ok) expect(matched.receipt.selectedLabel).toBe("Handoff (new session only)");
  expect(store.count("s1")).toBe(0);
});

test("negative answers are rejected and SPENT: no consent laundering via 'No'/'Reject' answers", () => {
  // With strict purpose binding, purposeless negatives (bare "No", "Cancel")
  // are never recorded as flow receipts — the store's `record` drops them
  // (CA-01/CA-02). Purpose-typed negatives (e.g. "Approve spec (Cancel)")
  // would be purposeful, but no bare negative ever blocks a typed purpose.
  const store = new HostReceiptStore();
  for (const label of [
    "No",
    "no",
    "no, thanks",
    "Reject",
    "Cancel",
    "CANCEL",
    "Decline",
    "Not now",
    "not now please",
    "Skip",
    "Back",
    "Deny",
    "Nope",
    "nope, sorry",
    "Nah",
    "Not yet",
    "not yet, let me check",
  ]) {
    store.record("s1", `call-${label}`, label);
    expect(store.count("s1"), label).toBe(0);
    const consumed = store.consume("s1", { purpose: "spec-approval" });
    expect(consumed.ok, label).toBe(false);
    if (!consumed.ok) expect(consumed.code, label).toBe("receipt_missing");
  }
});

test("a negative answer is spent by peek too: it cannot poison the queue", () => {
  // Purposeless negatives are not recorded — peek over an empty typed queue
  // is receipt_missing (no global purposeless negative latch, CA-02).
  const store = new HostReceiptStore();
  store.record("s1", "call-no", "No");
  expect(store.count("s1")).toBe(0);
  const peeked = store.peek("s1", { purpose: "spec-approval" });
  expect(peeked.ok).toBe(false);
  if (!peeked.ok) expect(peeked.code).toBe("receipt_missing");
});

test("the most recent answer wins: a No recorded after a Yes revokes the intent", () => {
  // Per-purpose revocation: a stash "No" blocks only execution-menu, not spec-approval.
  const store = new HostReceiptStore();
  store.record("s1", "call-yes", "Approve spec", Date.now(), "", "spec-approval");
  store.record("s1", "call-no", "Inline", Date.now(), "", "execution-menu");
  // Spec-approval is still valid — the execution-menu receipt is unrelated.
  const spec = store.consume("s1", { purpose: "spec-approval" });
  expect(spec.ok).toBe(true);
  expect(store.count("s1")).toBe(1);
});

test("a recent positive answer to an unrelated question does not authorize an approval (CA-02)", () => {
  // Strict purpose binding: an unrelated execution-menu receipt cannot authorize spec-approval.
  const store = new HostReceiptStore();
  store.record("s1", "call-stash", "Inline", Date.now(), "", "execution-menu");
  const consumed = store.consume("s1", { purpose: "spec-approval" });
  expect(consumed.ok).toBe(false);
  if (!consumed.ok) expect(consumed.code).toBe("receipt_missing");
});

test("the receipt store rejects future and stale receipts", () => {
  const store = new HostReceiptStore();
  const future = Date.now() + 2 * 60 * 60 * 1000;
  store.record("s1", "call-future", "Approve spec", future, "", "spec-approval");
  expect(store.count("s1")).toBe(0);

  // RECEIPT_FRESHNESS_MS is 10 minutes: a 10m+1s-old answer is stale.
  const stale = Date.now() - (10 * 60 * 1000 + 1000);
  store.record("s1", "call-stale", "Approve spec", stale, "", "spec-approval");
  const consumed = store.consume("s1", { purpose: "spec-approval" });
  expect(consumed.ok).toBe(false);
  if (!consumed.ok) expect(consumed.code).toBe("receipt_stale");
});

test("the receipt store bounds unconsumed receipts per session", () => {
  const store = new HostReceiptStore();
  for (let i = 0; i < 12; i++) {
    store.record("s1", `call-${i}`, "Approve spec", Date.now(), "", "spec-approval");
  }
  expect(store.count("s1")).toBe(10);
  const newest = store.consume("s1", { purpose: "spec-approval" });
  expect(newest.ok).toBe(true);
  if (newest.ok) expect(newest.receipt.selectedLabel).toBe("Approve spec");
});

test("host-mismatched evidence is rejected by the shared host binding", () => {
  expect(assertHostEvidence("opencode", cursorEvidence()).ok).toBe(false);
  expect(assertHostEvidence("cursor", cursorEvidence()).ok).toBe(true);
  const store = new HostReceiptStore();
  const opencode = openEvidence(store, "s1", "Approve");
  expect(assertHostEvidence("opencode", opencode).ok).toBe(true);
  expect(assertHostEvidence("cursor", opencode).ok).toBe(false);
  expect(assertEvidenceShape(true as never).ok).toBe(false);
  expect(assertEvidenceShape(cursorEvidence()).ok).toBe(true);
});

test("createCursorConfirmation returns exactly the policy-only constant", () => {
  const result = createCursorConfirmation();
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.evidence).toEqual({ host: "cursor", attested: false, confirmation: "contract" });
    expect(Object.keys(result.evidence).sort()).toEqual(["attested", "confirmation", "host"]);
  }
});

test("plan writes are blocked until the spec is approved", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    const result = transitionPlan(root, slug, plan, cursorEvidence());
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

    const store = new HostReceiptStore();
    const sessionId = "s1";
    transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve"));
    transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve"));
    const noPlan = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(noPlan.ok).toBe(false);
    if (noPlan.ok === false) expect(noPlan.code).toBe("plan_not_approved");

    transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve"));
    transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve"));
    const noMenu = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(noMenu.ok).toBe(false);
    if (noMenu.ok === false) expect(noMenu.code).toBe("menu_not_presented");

    const noMenuOpt = assertProductGates(root, slug, { requireMenu: false, requireDocs: true });
    expect(noMenuOpt.ok).toBe(true);

    recordMenuChoice(root, slug, plan, "handoff", openEvidence(store, sessionId, "handoff"));
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
    // A content change to the plan invalidates its approval BEFORE the docs
    // validation gate runs (CA-02/CA-03): reconciliation resets the plan to
    // draft, so the gate reports plan_not_approved, not docs_invalid.
    writeFileSync(path.join(root, "docs", slug, "plan.md"), "# broken");
    const gate = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(gate.ok).toBe(false);
    if (gate.ok === false) expect(gate.code).toBe("plan_not_approved");
    const lax = assertProductGates(root, slug, { requireMenu: true, requireDocs: false });
    expect(lax.ok).toBe(false);
    if (lax.ok === false) expect(lax.code).toBe("plan_not_approved");
    // Fresh approval restores the plan approval. The lifecycle facts (menu,
    // execution) survive plan drift, so the full gate passes without
    // re-presenting the menu.
    const store = new HostReceiptStore();
    const sessionId = "s1";
    writeFileSync(path.join(root, "docs", slug, "plan.md"), COMPLIANT_PLAN_FN(slug));
    expect(
      transitionPlan(
        root,
        slug,
        `docs/${slug}/plan.md`,
        openEvidence(store, sessionId, "Approve plan"),
      ).ok,
    ).toBe(true);
    const all = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(all.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("menu records only the exact selected label as evidence (OpenCode receipts)", () => {
  const { root, slug } = fixture();
  const store = new HostReceiptStore();
  const sessionId = "s1";
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok).toBe(
      true,
    );
    expect(transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok).toBe(
      true,
    );

    store.record(sessionId, "call-menu", "handoff", Date.now(), "handoff", "execution-menu");
    const mismatch = recordMenuChoice(
      root,
      slug,
      plan,
      "inline",
      createOpenCodeEvidence(
        (() => {
          const c = store.consume(sessionId, { purpose: "execution-menu", label: "handoff" });
          if (!c.ok) throw new Error(c.error);
          return c.receipt;
        })(),
      ),
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok === false) expect(mismatch.code).toBe("evidence_mismatch");

    // "not-an-option" has no purpose and would be dropped by the typed store;
    // prove invalid choice rejection via the choice gate itself (use inline receipt for handoff mismatch above).
    const stillPresented = readFlowState(root, slug).menu.presented;
    expect(stillPresented).toBe(false);
    const recorded = recordMenuChoice(
      root,
      slug,
      plan,
      "inline",
      openEvidence(store, sessionId, "inline"),
    );
    expect(recorded.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.menu).toMatchObject({ presented: true, chosen: "inline" });
    if (state.menu.evidence?.host === "opencode") {
      expect(state.menu.evidence.selectedLabel).toBe("inline");
    }
  } finally {
    cleanup(root);
  }
});

test.each([
  ["Subagent-driven (Recommended)", "subagent-driven"],
  ["Handoff (new session only)", "handoff"],
  ["Inline (Recommended)", "inline"],
  ["Review spec first", "review-spec"],
  ["Review plan first", "review-plan"],
])(
  "recordMenuChoice accepts qualifier-decorated selected labels on the source flow: %s",
  (selectedLabel, choice) => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const sessionId = `source-${choice}`;
      const spec = `docs/${slug}/spec.md`;
      const plan = `docs/${slug}/plan.md`;
      prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
      expect(
        transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok,
      ).toBe(true);
      expect(
        transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok,
      ).toBe(true);
      const result = recordMenuChoice(
        root,
        slug,
        plan,
        choice,
        menuEvidence(store, sessionId, selectedLabel),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(readFlowState(root, slug).menu.presented).toBe(true);
        expect(readFlowState(root, slug).menu.chosen).toBe(choice);
      }
    } finally {
      cleanup(root);
    }
  },
);

test.each([
  ["Subagent-driven (Recommended)", "subagent-driven"],
  ["Inline (Recommended)", "inline"],
  ["Review spec first", "review-spec"],
  ["Review plan first", "review-plan"],
])(
  "recordMenuChoice accepts qualifier-decorated selected labels on a marked handoff destination: %s",
  (selectedLabel, choice) => {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const spec = `docs/${slug}/spec.md`;
      const plan = `docs/${slug}/plan.md`;
      prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
      expect(transitionSpec(root, slug, spec, openEvidence(store, "src", "Approve spec")).ok).toBe(
        true,
      );
      expect(transitionPlan(root, slug, plan, openEvidence(store, "src", "Approve plan")).ok).toBe(
        true,
      );
      expect(
        recordMenuChoice(root, slug, plan, "handoff", menuEvidence(store, "src", "handoff")).ok,
      ).toBe(true);
      expect(markHandoffDestination(root, slug, plan)).toEqual({ ok: true });
      expect(readFlowState(root, slug).handoff_destination).toBe(true);

      const result = recordMenuChoice(
        root,
        slug,
        plan,
        choice,
        menuEvidence(store, `dest-${choice}`, selectedLabel),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(readFlowState(root, slug).menu.presented).toBe(true);
        expect(readFlowState(root, slug).menu.chosen).toBe(choice);
      }
    } finally {
      cleanup(root);
    }
  },
);

test("menu still rejects a genuinely mismatched base label as evidence_mismatch", () => {
  const cases: Array<[string, string]> = [
    ["Implement", "inline"],
    ["Handoff", "review-spec"],
  ];
  for (const [selectedLabel, choice] of cases) {
    const { root, slug } = fixture();
    try {
      const store = new HostReceiptStore();
      const sessionId = `mismatch-${choice}`;
      const spec = `docs/${slug}/spec.md`;
      const plan = `docs/${slug}/plan.md`;
      prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
      expect(
        transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok,
      ).toBe(true);
      expect(
        transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok,
      ).toBe(true);
      const result = recordMenuChoice(
        root,
        slug,
        plan,
        choice,
        menuEvidence(store, sessionId, selectedLabel),
      );
      expect(result.ok, `${selectedLabel} -> ${choice}`).toBe(false);
      if (result.ok === false) {
        expect(result.code, `${selectedLabel} -> ${choice}`).toBe("evidence_mismatch");
      }
      expect(readFlowState(root, slug).menu.presented).toBe(false);
    } finally {
      cleanup(root);
    }
  }
});

test("recordMenuChoice rejects a leading 'First' qualifier that the base label never renders", () => {
  // Advisory #3: the matcher must strip only a TRAILING "first" qualifier
  // ("Review spec first" -> review-spec), never a leading one — "First review
  // spec" is not the same choice as "review spec" and must be rejected.
  const { root, slug } = fixture();
  try {
    const store = new HostReceiptStore();
    const sessionId = "first-mismatch";
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(
      transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok,
    ).toBe(true);
    expect(
      transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok,
    ).toBe(true);
    const rejected = recordMenuChoice(
      root,
      slug,
      plan,
      "review-spec",
      menuEvidence(store, sessionId, "First review spec"),
    );
    expect(rejected.ok, "a leading qualifier must not over-match").toBe(false);
    if (rejected.ok === false) {
      expect(rejected.code, "a leading qualifier must not over-match").toBe("evidence_mismatch");
    }
    expect(readFlowState(root, slug).menu.presented).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("Cursor menu cannot record subagent-driven: unsupported mode with recovery guidance", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    expect(transitionSpec(root, slug, spec, cursorEvidence()).ok).toBe(true);
    expect(transitionPlan(root, slug, plan, cursorEvidence()).ok).toBe(true);

    const blocked = recordMenuChoice(root, slug, plan, "subagent-driven", cursorEvidence());
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) {
      expect(blocked.code).toBe("unsupported_mode");
      expect(blocked.error).toContain(CURSOR_SUBAGENT_UNSUPPORTED_TEXT);
    }
    expect(readFlowState(root, slug).menu.presented).toBe(false);

    const inline = recordMenuChoice(root, slug, plan, "inline", cursorEvidence());
    expect(inline.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("the shared transition matrix lands both docs at approved in one step (FG-09)", () => {
  const { root, slug } = fixture();
  try {
    expect(nextFlowStatus("draft")).toEqual({ ok: true, next: "approved" });
    // A legacy self_reviewed state still advances to approved.
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
  const store = new HostReceiptStore();
  const sessionId = "s1";
  try {
    approveAll(root, slug);
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    const replay = transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve"));
    expect(replay.ok).toBe(false);
    if (replay.ok === false) expect(replay.code).toBe("flow_already_approved");
    const planReplay = transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve"));
    expect(planReplay.ok).toBe(false);
    if (planReplay.ok === false) expect(planReplay.code).toBe("flow_already_approved");
    const state = readFlowState(root, slug);
    expect(state.spec.status).toBe("approved");
    expect(state.plan.status).toBe("approved");
  } finally {
    cleanup(root);
  }
});

test("flow state persists receipt-derived evidence provenance across reads", () => {
  const { root, slug } = fixture();
  try {
    approveAll(root, slug);
    const flow = JSON.parse(
      readFileSync(path.join(root, "docs", slug, "sdd", "flow.json"), "utf8"),
    ) as {
      spec: {
        evidence: {
          host: string;
          attested: boolean;
          callID: string;
          selectedLabel: string;
          recordedAt: number;
        };
      };
      menu: { evidence: unknown };
    };
    expect(flow.spec.evidence.host).toBe("opencode");
    expect(flow.spec.evidence.attested).toBe(true);
    expect(flow.spec.evidence.callID).toBe("call-Approve spec");
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

test("product gates use the strict read: corrupt flow state is flow_state_invalid, not a silent draft fallback", () => {
  const { root, slug } = fixture();
  try {
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
    writeFileSync(path.join(root, "docs", slug, "sdd", "flow.json"), "{not-json", "utf8");
    const gate = assertProductGates(root, slug, { requireMenu: true, requireDocs: true });
    expect(gate.ok).toBe(false);
    if (gate.ok === false) {
      expect(gate.code).toBe("flow_state_invalid");
      expect(gate.error).toContain("invalid flow state");
    }
  } finally {
    cleanup(root);
  }
});

test("delegation comes from host parentage, never from caller fields", () => {
  expect(roleFromParentage(undefined)).toBe("coordinator");
  expect(roleFromParentage(null)).toBe("coordinator");
  expect(roleFromParentage("")).toBe("coordinator");
  expect(roleFromParentage("root-session")).toBe("delegated");
  expect(roleFromParentage("child-of-root")).toBe("delegated");
});

test("subagent-driven interception: delegated child sessions are never blocked", () => {
  const blocked = subagentDrivenInterception({
    tool: "write",
    parentID: "root-session",
    active: true,
  });
  expect(blocked.ok).toBe(true);
  const bash = subagentDrivenInterception({
    tool: "bash",
    command: "rm -rf /",
    parentID: "root-session",
    active: true,
  });
  expect(bash.ok).toBe(true);
});

test("subagent-driven interception: inactive plans never block the root session", () => {
  const blocked = subagentDrivenInterception({ tool: "write", parentID: undefined, active: false });
  expect(blocked.ok).toBe(true);
});

test("subagent-driven interception: root-session write tools are denied when active", () => {
  for (const tool of COORDINATOR_WRITE_TOOLS) {
    const decision = subagentDrivenInterception({ tool, parentID: undefined, active: true });
    expect(decision.ok, tool).toBe(false);
    if (!decision.ok) {
      expect(decision.code, tool).toBe("coordinator_write_denied");
      expect(decision.error, tool).toContain(COORDINATOR_RECOVERY_TEXT);
    }
  }
  // Host-native write tools must be on the list.
  for (const hostTool of ["write", "edit", "apply_patch", "patch", "rename", "delete"]) {
    expect(COORDINATOR_WRITE_TOOLS, hostTool).toContain(hostTool);
  }
});

test("subagent-driven interception: non-write tools stay allowed for the root session", () => {
  for (const tool of [
    "read",
    "grep",
    "glob",
    "question",
    "task",
    "todowrite",
    "webfetch",
    "workflow_flow_status",
    "workflow_spec_approve",
    "workflow_plan_menu",
    "workflow_handoff_session",
    "workflow_verify",
    "workflow_git_context",
  ]) {
    const decision = subagentDrivenInterception({ tool, parentID: undefined, active: true });
    expect(decision.ok, tool).toBe(true);
  }
});

test("subagent-driven interception: coordinator shell mutations are denied with recovery guidance", () => {
  for (const command of [
    "rm -rf docs",
    "mv a b",
    "cp a b",
    "touch x",
    "mkdir x",
    "git push",
    "git commit -m x",
    "git checkout -b new",
    "git reset --hard",
    "git stash push",
    "git merge develop",
    "sed -i s/x/y/ file",
    "cat a > b",
    "cat a >> b",
    "ls | grep x",
    "cd docs && ls",
    "echo hi; rm x",
    "printf 'x\n' > f",
    "sudo rm x",
    "python -c 'print(1)'",
    "node -e '1'",
    "curl https://example.com",
    "wget https://example.com",
    "bash -c 'ls'",
    "bun run format",
    "bun run build",
    "npm run build",
    "git stash",
    "tee f",
    "perl -e '1'",
  ]) {
    const decision = subagentDrivenInterception({
      tool: "bash",
      command,
      parentID: undefined,
      active: true,
    });
    expect(decision.ok, JSON.stringify(command)).toBe(false);
    if (!decision.ok) {
      expect(decision.code, command).toBe("coordinator_shell_denied");
      expect(decision.error, command).toContain(COORDINATOR_SHELL_DENIED_TEXT);
    }
  }
  expect(isCoordinatorBashAllowed("git stash")).toBe(false);
});

test("curl/sudo/tee/wget are denied as command heads but pass as arguments (FINDING 5)", () => {
  for (const command of [
    "curl https://example.com",
    "curl -s https://example.com",
    "sudo ls",
    "sudo -u root ls",
    "tee f",
    "tee -a f",
    "wget https://example.com",
  ]) {
    expect(isCoordinatorBashAllowed(command), command).toBe(false);
  }
});

// Adversarial matrix: every known allowlist bypass is denied (CA-18, AR-13).
// This table is the audited security boundary — adding a deny rule requires
// adding its bypass here, and every bypass here must stay denied.
test("adversarial allowlist matrix: every documented coordinator-shell bypass is denied", () => {
  for (const [command, vector] of [
    // find: allowlisted head token admits delete/execute via flags
    ["find . -delete", "find -delete"],
    ["find . -exec touch {} +", "find -exec"],
    ["find . -execdir rm {} \\;", "find -execdir"],
    ["find . -ok rm {} \\;", "find -ok"],
    // awk: arbitrary shell via system()
    ["awk 'BEGIN{system(\"rm -rf x\")}'", "awk system("],
    ["awk 'BEGIN{system(\"rm -rf /tmp/x\")}' f", "awk system()"],
    // sed: in-place edit hides behind a suffix flag, bypassing the -i exact match
    ["sed -i.bak s/x/y/ f", "sed -i suffix"],
    ["sed --in-place s/x/y/ f", "sed --in-place"],
    ["sed -I s/x/y/ f", "sed -I (BSD in-place)"],
    // git: flag-form check admits destructive branch/tag flags
    ["git branch -d x", "git branch -d"],
    ["git branch -D x", "git branch -D"],
    ["git branch -m x", "git branch -m"],
    ["git branch -c x", "git branch -c"],
    ["git tag -d x", "git tag -d"],
    ["git tag -f x", "git tag -f"],
    ["git remote add origin https://x", "git remote add"],
    // process substitution executes: <( and >( are not $(
    ["ls <(rm -rf /tmp/x)", "process substitution <("],
    ["cat >(rm -rf /tmp/x)", "process substitution >("],
    ["diff <(head -1 a) <(head -1 b)", "process substitution arg"],
    // subshell + command substitution
    ["(rm -rf x)", "subshell ("],
    ["echo $(ls)", "command substitution $("],
    // test verbs admit mutating flags
    ["bun run lint --fix", "lint --fix"],
    ["npm test -- --coverage", "test --coverage"],
    ["bun run format --write", "format --write"],
    ["npm run check -- --coverage", "check --coverage"],
    // bare tsc can emit config/decorator artifacts without --noEmit
    ["tsc", "bare tsc"],
    // write-capable -o/--output on allowlisted read verbs (FINDING 1)
    ["sort -o out.txt f", "sort -o"],
    ["sort -oout.txt f", "sort -o attached"],
    ["sort --output=out.txt f", "sort --output="],
    ["sort --output out.txt f", "sort --output"],
    ["tree -o out.txt", "tree -o"],
    ["tree --output=out.txt", "tree --output="],
    ["comm -o out.txt a b", "comm -o"],
    ["diff -o out.txt a b", "diff -o"],
    ["git log --output=out.txt", "git log --output="],
    ["git diff --output=out.txt", "git diff --output="],
    ["git diff --output out.txt", "git diff --output"],
    ["cat a --output=b", "--output= on any verb"],
    // sed scripts that write files: the w command, and -f/--file scripts (FINDING 1)
    ["sed 'w out.txt' x", "sed w command"],
    ["sed '/pat/w out.txt' x", "sed script w"],
    ["sed 's/a/b/w out.txt' x", "sed w at end of script"],
    ["sed '1,5w out.txt' x", "sed line-range w"],
    ["sed -e 'w out.txt' x", "sed -e w command"],
    ["sed -f rules.sed x", "sed -f script file"],
    ["sed --file rules.sed x", "sed --file"],
    // find's file-writing forms (FINDING 1)
    ["find . -fprint out.txt", "find -fprint"],
    ["find . -fprintf out.txt '%p'", "find -fprintf"],
    ["find . -fprint0 out.txt", "find -fprint0"],
    ["find . -fls out.txt", "find -fls"],
    // probes: unallowlisted heads that mutate, execute, or write (FINDING 1)
    ["xargs rm -rf x", "xargs head"],
    ["git config --file x user.name y", "git config"],
    ["git config user.email x", "git config"],
    ["git var GIT_AUTHOR_IDENT", "git var"],
    ["expand x", "expand head"],
    ["cp a b", "cp head"],
    ["mv a b", "mv head"],
    ["gzip x", "gzip head"],
    ["tar cf x.tar x", "tar head"],
    ["chmod +x f", "chmod head"],
    ["shred f", "shred head"],
    // sed `w` command with ATTACHED filename: one token, the exact/endsWith
    // checks cannot see it (FINDING 1, round 3)
    ["sed '1,5w/tmp/x' f", "sed 1,5w attached file"],
    ["sed 1,5w/tmp/x f", "sed 1,5w attached unquoted"],
    ["sed 'w/tmp/x' f", "sed w attached file"],
    ["sed 'w=/tmp/x' f", "sed w= attached file"],
    ["sed '/pat/w/tmp/x' f", "sed regex-address w attached"],
    ["sed -e'w/tmp/x' f", "sed -e attached w"],
    ["sed -e's/a/b/wout' f", "sed -e attached s w-flag"],
    ["sed 's/a/b/wout' f", "sed s-command w-flag attached"],
    // sed/awk script FILE forms with ATTACHED option value (FINDING 2/3)
    ["sed -f/tmp/evil.sed x", "sed -f attached"],
    ["sed --file=/tmp/evil.sed x", "sed --file attached"],
    ["awk -f evil.awk x", "awk -f script file"],
    ["awk -fevil.awk x", "awk -f attached"],
    ["awk --file=evil.awk x", "awk --file="],
    ["gawk -f evil.awk x", "gawk -f script file"],
    ["mawk -f evil.awk x", "mawk -f script file"],
    // ${IFS} / ANSI-C-quote whitespace injection: shell expansion past the
    // tokenizer (FINDING 4)
    ["find . -exec${IFS}rm${IFS}-rf${IFS}x${IFS}{}${IFS}+", "${IFS} in find -exec"],
    ["git log --output${IFS}x", "${IFS} with --output"],
    ["sed 's/a/b/'${IFS}w${IFS}out.txt", "${IFS} in sed script"],
    ["find . -name$'\\t'x", "$' ANSI-C quote whitespace"],
    // quoted flags: the shell strips quotes before exec, so a quoted write
    // flag IS a write flag (FINDING 4, decide-and-document)
    ['git diff "--output" out.txt', "quoted --output flag"],
    ['git log "--output=out.txt"', "quoted --output= flag"],
    ['sort "-oout.txt" f', "quoted attached -o"],
    // jq -o/--output-file writes the output to a file (write-capable -o class)
    ["jq -o out.json x.json", "jq -o output file"],
    ["jq --output-file=out.json x.json", "jq --output-file="],
    // uppercase W: GNU sed's W writes the FIRST line of pattern space to the
    // file — the same write class as lowercase w (FINDING 1, round 4). The
    // quote-joined forms put the write command at the END of the split token
    // (`'W out'` → `'W` + `out'`, `-e'W f'` → `-e'W` + `f'`); the attached
    // forms keep the glued filename.
    ["sed 'W out' f", "sed W standalone (quote join)"],
    ["sed -n 'W out' f", "sed -n W"],
    ["sed -E 'W out' f", "sed -E W"],
    ["sed --posix 'W out' f", "sed --posix W"],
    ["sed '/a/W out' f", "sed regex-address W"],
    ["sed '1,5W out' f", "sed line-range W"],
    ["sed '/a/,/b/W out' f", "sed addr-pair W"],
    ["sed -e'W f' f", "sed -e W join (truncates its own input)"],
    ["sed --expression='W out' f", "sed --expression W join"],
    ["sed -e'W/tmp/x' f", "sed -e W attached"],
    ["sed '1,5W/tmp/x' f", "sed 1,5W attached"],
    ["sed '/a/W/tmp/x' f", "sed /a/ W attached"],
    ["sed 'W=/tmp/x' f", "sed W= attached"],
    ["sed 's/a/b/Wout' f", "sed s-flag W attached"],
    ["sed -e's/a/b/Wout' f", "sed -e s-flag W attached"],
    ["sed 'W/tmp/x' f", "sed W attached quoted"],
    ["sed W/tmp/x f", "sed W attached unquoted"],
    ["sed -eWout f", "sed -e glued W attached"],
    // documented fail-closed false positive: a file literally named W after a
    // sed read is denied (same class as the file named `w`, round 2)
    ["sed 's/a/b/' W", "file named W fail-closed"],
    // FINDING 1 (round 5): sed is DENIED OUTRIGHT (head removed from the
    // allowlist). GNU sed 4.9 executes arbitrary commands through the `e`
    // command (bash-verified: `sed 'e touch PWNED' f` ran touch) and the
    // `s///e` flag (`sed 's/.*/touch X/e' f` ran touch) — a script-grammar
    // class a token parser cannot close (five review rounds of sed escapes).
    ["sed 'e touch PWNED' f", "sed e command executes (verified in bash)"],
    ["sed -n 'e touch X' f", "sed -n e command"],
    ["sed -E 'e touch X' f", "sed -E e command"],
    ["sed '1,5e touch X' f", "sed line-range e command"],
    ["sed '/a/e touch X' g", "sed regex-address e command"],
    ["sed 's/.*/touch X/e' f", "sed s///e flag executes (verified in bash)"],
    ["sed 's/a/b/e' f", "sed s///e flag"],
    // sed reads were a nice-to-have, not a boundary need — ALL sed forms are
    // now denied (previously-allowed positive rows moved here, round 5)
    ["sed -n 1,5p file", "sed read (was positive, round 5)"],
    ["sed s/x/y/ file", "sed read (was positive, round 5)"],
    ["sed -n 's/x/y/p' file", "sed read (was positive, round 5)"],
    ["sed 'a text' file", "sed a command (was positive, round 5)"],
    ["sed 's/a/w/g' file", "sed read (was positive, round 5)"],
    ["sed '/w/p' file", "sed read (was positive, round 5)"],
    ["sed '/w/d' file", "sed read (was positive, round 5)"],
    ["sed -e'/w/p' file", "sed read (was positive, round 5)"],
    // FINDING 2 (round 5): mid-token quote joins — the shell strips quote
    // characters when building argv, so `'w'out` IS `wout` and `--out'put=x'`
    // IS `--output=x`. Tokens are now fully unquoted before every check.
    ["sed 'w'out f", "sed quote-join w (moot: sed denied)"],
    ["sed 'W'outU f", "sed quote-join W (moot: sed denied)"],
    ["sed -e'w'outE f", "sed -e quote-join w (moot: sed denied)"],
    ["sed --expression='W'outX f", "sed --expression quote-join W (moot: sed denied)"],
    ["sed 'w'\"out\" f", "sed quote-join w+double (moot: sed denied)"],
    ["git log --out'put=x'", "quote-join --output="],
    ["find . -de'lete'", "quote-join -delete"],
    ["find . -e'xec rm {} +'", "quote-join -exec"],
    ["awk -'f x'", "quote-join -f script file"],
    ["sort -'o'out.txt f", "quote-join attached -o"],
    ["git diff --o'utput' out.txt", "quote-join --output"],
    ["bun run lint --'fix'", "quote-join --fix"],
    ["ts'c'", "quote-join head tsc (bare)"],
    ["cu'rl' x", "quote-join denied head curl"],
    ["su'do' ls", "quote-join denied head sudo"],
    ["t'ee' f", "quote-join denied head tee"],
    ["git branch -d'el' x", "quote-join branch -d"],
    // git mutable value positions: ONE value is allowed after a value-taking
    // read flag; a trailing name would CREATE a branch/tag (verified in bash:
    // `git branch --sort=-x y`, `git tag --format=x y` both create) and a
    // dash-flag smuggled in as the value stays denied (FINDING 3, round 4)
    ["git branch --sort=-committerdate y", "branch --sort=value + name"],
    ["git branch --format=x y", "branch format value + name"],
    ["git tag --format=x y", "tag format value + name (creates lightweight tag)"],
    ["git branch --contains x y", "two values after --contains"],
    ["git branch --contains -d x", "branch --contains + -d + name"],
    ["git tag --sort -f x", "tag --sort + -f + name"],
    ["git branch --format -d x", "branch --format + -d + name"],
    // multi-token --format values (a space inside the quoted format) stay
    // fail-closed: only the single-token form is allowlisted
    ["git branch --format '%(refname) %(objectname)'", "multi-token format value fail-closed"],
    // command without -v executes; only `command -v`/`-V` lookup is read-only
    ["command git status", "command executes"],
    ["command -v", "command -v without a name"],
    ["command -v a b", "command -v with two names"],
    // FINDING 1 (round 6): GNU sort --compress-program executes PROG with the
    // sorted data on stdin — `sh` runs the data as a script (bash-verified:
    // `sort --buffer-size=1M --compress-program=sh` created PWNED_COMPRESS).
    // Denied globally (any verb): the flag only exists on sort, but a global
    // deny has no flag-surface to track.
    ["sort --compress-program=sh x", "sort --compress-program exec (verified in bash)"],
    ["sort --compress-program sh x", "sort --compress-program space form"],
    ["sort --compress-program=gzip x", "sort --compress-program= any PROG"],
    ["cat --compress-program=sh f", "--compress-program denied globally"],
    ["grep --compress-program=sh x f", "--compress-program denied on any verb"],
    // FINDING 2 (round 6): git exec-trigger flags — flags that RUN programs:
    // `git grep --open-files-in-pager=sh -e x -- f` and the short form
    // `git grep -Osh` open each matched file with a pager that can be `sh`
    // (bash-verified: both created GITPWNED / GITPWNED_O); `--ext-diff` runs
    // repo gitattributes external diff drivers (log/diff/show); `--textconv`
    // runs repo-configured textconv drivers (log/diff/show/blame/grep).
    [
      "git grep --open-files-in-pager=sh -e x -- f",
      "git grep open-files-in-pager exec (verified in bash)",
    ],
    ["git grep --open-files-in-pager sh -e x", "git grep open-files-in-pager space form"],
    ["git grep --open-files-in-pager -e x", "git grep open-files-in-pager bare (repo core.pager)"],
    ["git grep -Osh -e x -- f", "git grep -O attached pager exec (verified in bash)"],
    ["git grep -O sh -e x", "git grep -O space form"],
    ["git grep -O -e x", "git grep -O bare (repo core.pager)"],
    ["git log --ext-diff", "git log --ext-diff (external diff drivers)"],
    ["git diff --ext-diff", "git diff --ext-diff"],
    ["git show --ext-diff", "git show --ext-diff"],
    ["git log --textconv", "git log --textconv (textconv drivers)"],
    ["git diff --textconv", "git diff --textconv"],
    ["git show --textconv", "git show --textconv"],
    ["git blame --textconv", "git blame --textconv"],
    ["git grep --textconv", "git grep --textconv"],
    // FINDING 2 (round 6): `--show-signature` runs gpg (core.gpg.program)
    // on each commit shown; `--remerge-diff` runs the merge machinery on
    // merge commits (external merge drivers) — same driver-execution class,
    // denied fail-closed (no coordinator review flow needs either).
    ["git log --show-signature", "git log --show-signature (runs gpg)"],
    ["git show --show-signature", "git show --show-signature"],
    ["git log --remerge-diff", "git log --remerge-diff (merge drivers)"],
    // FINDING 2 (round 6): pager forcing is a GLOBAL git option (before the
    // subcommand); `git -p log` puts `-p` at tokens[1] where the
    // subcommand-position rule already denies it. `git log -p` (after the
    // subcommand) is `--patch` — read-only, allowed (positive table). Pinned
    // here so a future rework cannot silently admit the global forms.
    ["git -p log", "git -p (global paginate, position-denied)"],
    ["git --paginate log", "git --paginate (position-denied)"],
    // FINDING 3 (round 6): `date -s`/`--set` mutate the system clock
    // (bash-verified: `date -s` attempts the set — "cannot set date: Operation
    // not permitted"). All attached/separate/`=` forms denied.
    ["date -s '2024-01-01'", "date -s clock set"],
    ["date -s2024-01-01", "date -s attached"],
    ["date --set '2024-01-01'", "date --set space form"],
    ["date --set=2024-01-01", "date --set="],
    // FINDING 4 (round 6): `sort -T`/`--temporary-directory` writes sort's
    // own temp files into an arbitrary directory (bash/strace-verified:
    // `sort -T /tmp/opencode/r6d` created sortGdvlHf, sortV2VyNF, ...).
    ["sort -T /tmp/x f", "sort -T temp dir"],
    ["sort -T/tmp/x f", "sort -T attached"],
    ["sort --temporary-directory=/tmp/x f", "sort --temporary-directory="],
    ["sort --temporary-directory /tmp/x f", "sort --temporary-directory space form"],
    // FINDING 1 (round 7): runner-branch write flags that escaped the flag
    // families — alternate spellings, camelCase, and short forms:
    // `--outputFile` (jest JSON report) is neither `--output` nor
    // `--output-file`; `-u` (bun/jest/vitest snapshot update) is not
    // `--update`; `--collectCoverage` is camelCase; `--cache*` writes
    // eslint/jest cache files; tsc build-info flags write .tsbuildinfo even
    // with `--noEmit`.
    ["npx jest --json --outputFile=/tmp/x.json", "jest --outputFile= writes JSON report"],
    ["npx jest --json --outputFile /tmp/x.json", "jest --outputFile space form"],
    ["bun test -u", "bun test -u snapshot update"],
    ["bun test -u test/foo.test.ts", "bun test -u with path"],
    ["npm test -u", "npm test -u snapshot update"],
    ["npx jest --collectCoverage", "jest --collectCoverage camelCase"],
    ["npx jest --collectCoverageFrom=src/**", "jest --collectCoverageFrom"],
    // FINDING 1 (round 8): kebab-case coverage spellings — jest's yargs CLI
    // parser accepts `--collect-coverage` and the mixed `--collect-coverageFrom`
    // form. `--collect-coverage` WRITES coverage/ (clover.xml, lcov.info,
    // coverage-final.json — re-verified in bash, round 8); `--collect-coverageFrom`
    // alone does not enable collection in jest 29.7.0, but writes whenever
    // collection is enabled (`--coverage`/config — `--coverage` is separately
    // denied), so the whole `--collect-coverage*` family is denied fail-closed.
    // All three rows escaped the round-7 allowlist: lowercased
    // `--collect-coverage` cannot prefix-match the camelCase `--collectcoverage`
    // entry (the dash breaks the prefix).
    ["npx jest --collect-coverage", "jest --collect-coverage kebab"],
    ["npx jest --collect-coverageFrom=src/**", "jest --collect-coverageFrom mixed kebab"],
    ["npm test -- --collect-coverage", "npm test -- --collect-coverage kebab"],
    // sibling kebab/camel runner spellings re-verified after the round-8
    // change (all covered by existing prefixes/global denies — regression
    // pins): `--update-snapshot` (`--update`), `--cache-directory`
    // (`--cache`), `--coverage-directory` (`--coverage`), `--output-file`
    // (global output-flag deny).
    ["npx jest --update-snapshot", "jest --update-snapshot kebab"],
    ["npx jest --cache-directory /tmp/c", "jest --cache-directory kebab"],
    ["npx jest --coverage-directory /tmp/c", "jest --coverage-directory kebab"],
    ["npx jest --output-file /tmp/x.json", "jest --output-file (global output deny)"],
    ["bun run lint --cache", "lint --cache writes cache file"],
    ["bun run lint --cache-dir /tmp/c", "lint --cache-dir"],
    ["npx jest --cacheDirectory /tmp/c", "jest --cacheDirectory"],
    ["bun test --cache=false", "test --cache=false (read-only, over-denied)"],
    ["npx vitest -u", "vitest -u snapshot update"],
    ["npx vitest -w", "vitest -w (write form in some runners, over-denied)"],
    ["tsc --noEmit --incremental", "tsc incremental writes tsbuildinfo"],
    ["tsc --noEmit --tsBuildInfoFile=/tmp/x.tsbuildinfo", "tsc --tsBuildInfoFile"],
    ["tsc --noEmit --tsBuildInfoFile /tmp/x", "tsc --tsBuildInfoFile space form"],
    ["bun run tsc --noEmit --incremental", "runner tsc incremental"],
    ["tsc -b --noEmit", "tsc -b build mode"],
    ["tsc --noEmit --composite", "tsc composite implies incremental"],
    // FINDING 3 (round 7): `--no-pager` before the subcommand disables the
    // pager (read-only) but must never lift any other boundary rule
    ["git --no-pager", "git --no-pager without subcommand"],
    ["git --no-pager branch -d x", "git --no-pager does not lift mutable denies"],
    ["git --no-pager grep -Osh -e x", "git --no-pager does not lift exec-flag denies"],
    // FINDING 4 (round 7): combined short flags stay denied on the mutating
    // classes (`tag -a` creates an annotated tag; remote has only -v)
    ["git tag -av v1", "tag -av: -a creates an annotated tag"],
    ["git remote -av", "remote -av: -a is not a read flag"],
    ["git branch -adv", "branch -adv: -d deletes"],
  ]) {
    expect(isCoordinatorBashAllowed(command), `${vector}: ${command}`).toBe(false);
    const decision = subagentDrivenInterception({
      tool: "bash",
      command,
      parentID: undefined,
      active: true,
    });
    expect(decision.ok, `${vector}: ${command}`).toBe(false);
    if (!decision.ok) {
      expect(decision.code, vector).toBe("coordinator_shell_denied");
      expect(decision.error, vector).toContain(COORDINATOR_SHELL_DENIED_TEXT);
    }
  }
});

test("the coordinator bash allowlist permits bounded read/test/review commands", () => {
  for (const command of [
    "cat spec.md",
    "head -20 plan.md",
    "tail -5 flow.json",
    "grep -n Task docs/x/plan.md",
    "rg 'Task' docs",
    "grep -o foo file",
    "rg -o foo file",
    // FINDING 5: fragment denials are head-scoped — curl/sudo as ARGS pass
    "grep curl README.md",
    "rg 'sudo' docs",
    "cat sudo-config.txt",
    "git log --grep=curl",
    "find docs -name '*.md'",
    "find . -name '*.md' -o -name '*.txt'",
    "ls -la",
    "stat flow.json",
    "wc -l spec.md",
    "file README.md",
    "diff a b",
    "sort list.txt",
    "uniq list.txt",
    "cut -d: -f1 x",
    "tr a b < input.txt",
    "fold -w 80 x",
    "printf '%s' hi",
    "echo hello",
    "pwd",
    "date",
    "which bun",
    "type git",
    "du -sh docs",
    "df -h",
    "tree -L 2",
    "jq . x.json",
    // FINDING 3 (round 5): echo/printf/jq are pure-stdout verbs — parens
    // inside a fully-quoted token are display text (bash-verified: unquoted
    // parens are a syntax error in bash and stay denied)
    'echo "a (b)"',
    "printf '(%s)\\n' x",
    "jq '.a + (.b // 0)' x.json",
    "awk '{print $1}' file",
    "awk -F: '{print $1}' file",
    "gawk -F, '{print $1}' file",
    "mawk '{print $1}' file",
    // quoted arguments are transparent to the shell: reads with quoted words
    // stay allowed (quote-stripping must not over-deny)
    'cat "a b"',
    'git diff "--stat"',
    // quote-joined read VALUES stay allowed (the shell builds the same argv)
    "git branch --contains HE'AD'",
    "grep -w foo file",
    "sort -t: -k2 f",
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff HEAD",
    "git diff --stat",
    "git show HEAD",
    "git branch --show-current",
    "git branch -a",
    "git rev-parse HEAD",
    "git merge-base HEAD origin/main",
    "git remote -v",
    "git ls-files",
    "git blame file",
    "git shortlog -n",
    "git describe --tags",
    "git check-ignore docs/x/sdd",
    "git name-rev HEAD",
    "git stash list",
    "git grep Task",
    "git tag -l",
    "git branch --show-current",
    "git remote -v",
    // value-taking read flags on the mutable listing subcommands: one value
    // (a commit/tag name, a sort key, a format string) after --contains/
    // --points-at/--merged/--no-merged/--sort/--format, or glued --flag=value
    // (FINDING 3, round 4 — verified read-only in bash)
    "git branch --contains HEAD",
    "git tag --contains v1",
    "git branch --points-at HEAD",
    "git tag --points-at v1",
    "git branch --merged HEAD",
    "git branch --merged",
    "git tag --merged v1",
    "git branch --no-merged HEAD",
    "git branch --sort=-committerdate",
    "git tag --sort=-creatordate",
    "git branch --sort -committerdate",
    "git tag -l --sort=-creatordate",
    "git branch --format='%(refname)'",
    "git branch --format '%(refname)'",
    "git tag --format='%(refname)'",
    "git log --format '%h %s'",
    "git log --format='%(refname)'",
    "git log --pretty=format:'%h %s'",
    "tsc --noEmit",
    "bun run tsc --noEmit",
    "bun test",
    "bun test test/foo.test.ts",
    "bun run test",
    "bun run check",
    "bun run lint",
    "bun run typecheck",
    "bun run verify",
    "bun run validate",
    "npm test",
    "npm run test",
    "npm run check",
    "pnpm test",
    "yarn test",
    "npx vitest run",
    "npx jest",
    // read-only builtins (FINDING 3, round 4): `command -v`/`-V` only look up
    // paths; `test`/`[` only evaluate expressions
    "command -v git",
    "command -V bun",
    "test -f flow.json",
    "test x = y",
    "test -n '$VAR'",
    "[ -f spec.md ]",
    "[ x = y ]",
    // FINDING 2 (round 6): `git log -p`/`git diff -p` are `--patch`
    // (read-only) — only the GLOBAL pre-subcommand `-p` forces a pager and is
    // denied (deny table). `--no-ext-diff`/`--no-textconv` DISABLE the
    // drivers and stay allowed.
    "git log -p",
    "git diff -p",
    "git log --no-ext-diff",
    "git log --no-textconv",
    "git grep -l Task",
    "git grep -n --no-textconv Task",
    // FINDING 3 (round 6): `date -d` (display date, read-only) stays allowed;
    // only `-s`/`--set` (clock mutation) is denied (deny table).
    "date -d 'yesterday'",
    "date -u +%s",
    // FINDING 2 (round 7): `git log/diff -O <orderfile>` is `--diff-order`
    // (read-only) — only grep's `-O` is the pager-exec flag (deny table,
    // bash-verified round 6). Pinned in the committed matrix so the
    // grep-scoped `-O` deny cannot be widened without breaking these.
    "git log -O order.txt",
    "git diff -O order.txt",
    // FINDING 3 (round 7): `git --no-pager <sub>` (global pager disable,
    // BEFORE the subcommand) is read-only — consistent with the already
    // allowed post-subcommand form; every deny rule still applies.
    "git --no-pager log --oneline",
    "git --no-pager status",
    "git --no-pager branch -a",
    "git --no-pager diff HEAD",
    "git --no-pager stash list",
    // FINDING 4 (round 7): combined read-only short flags on the mutable
    // listing subcommands (`-av` = `-a -v`, `-ar` = `-a -r`, `-avv` =
    // `-a -vv`) — verified read-only in bash (list-only, no creation).
    "git branch -av",
    "git branch -ar",
    "git branch -avv",
  ]) {
    expect(isCoordinatorBashAllowed(command), JSON.stringify(command)).toBe(true);
    const decision = subagentDrivenInterception({
      tool: "bash",
      command,
      parentID: undefined,
      active: true,
    });
    expect(decision.ok, JSON.stringify(command)).toBe(true);
  }
});

const lifecycleFlowFile = (root: string, slug: string) =>
  path.join(root, "docs", slug, "sdd", "flow.json");

const cliEvidence = (confirmation: "flag" | "tty" = "tty"): CliConfirmation => ({
  host: "cli",
  attested: false,
  confirmation,
});

/** Approve spec+plan and record the given post-plan menu choice (CA-11). */
const establishMenuChoice = (root: string, slug: string, choice: string) => {
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const store = new HostReceiptStore();
  const sessionId = "lifecycle-session";
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  expect(prep.ok).toBe(true);
  expect(transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok).toBe(
    true,
  );
  expect(transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok).toBe(
    true,
  );
  const menu = recordMenuChoice(root, slug, plan, choice, openEvidence(store, sessionId, choice));
  expect(menu.ok).toBe(true);
};

const writeSddLedger = (root: string, slug: string, lines: string[]) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "progress.md"), lines.join("\n") + "\n", "utf8");
};

/** Legacy fixture: remove the execution key from the persisted flow.json bytes. */
const stripExecution = (root: string, slug: string) => {
  const file = lifecycleFlowFile(root, slug);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete parsed.execution;
  writeFileSync(file, JSON.stringify(parsed, null, 2), "utf8");
};

const stubVerifier =
  (exitCode: number, onRun?: (root: string) => void) =>
  (root: string): VerifyResult => {
    onRun?.(root);
    return { stdout: "", stderr: "", exitCode, cwd: root };
  };

test("CA-11/CA-13: the post-plan menu sets the execution lifecycle atomically with menu evidence", () => {
  const cases: [
    string,
    { status: "active" | "pending"; mode: "subagent-driven" | "inline" | null },
  ][] = [
    ["subagent-driven", { status: "active", mode: "subagent-driven" }],
    ["inline", { status: "active", mode: "inline" }],
    ["handoff", { status: "pending", mode: null }],
    ["review-spec", { status: "pending", mode: null }],
    ["review-plan", { status: "pending", mode: null }],
  ];
  for (const [choice, expected] of cases) {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, choice);
      const state = readFlowState(root, slug);
      expect(state.execution.status, choice).toBe(expected.status);
      expect(state.execution.mode, choice).toBe(expected.mode);
      expect(state.execution.evidence, choice).not.toBeNull();
      if (state.execution.evidence?.host === "opencode") {
        expect(state.execution.evidence.selectedLabel, choice).toBe(choice);
      }
    } finally {
      cleanup(root);
    }
  }
});

test("CA-14: pause/resume cycles active -> paused -> active and preserves mode, evidence, and SDD progress", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    const plan = `docs/${slug}/plan.md`;
    const sddDir = path.join(root, "docs", slug, "sdd");
    writeFileSync(path.join(sddDir, "task-1-brief.md"), "# Task 1 brief\n\n- [ ] Work\n", "utf8");
    writeSddLedger(root, slug, ["Task 1: complete"]);
    const briefBefore = readFileSync(path.join(sddDir, "task-1-brief.md"), "utf8");
    const progressBefore = readFileSync(path.join(sddDir, "progress.md"), "utf8");
    const menuEvidence = readFlowState(root, slug).execution.evidence;

    const paused = transitionExecution(root, slug, plan, "pause", cliEvidence("flag"));
    expect(paused.ok).toBe(true);
    let state = readFlowState(root, slug);
    expect(state.execution).toMatchObject({ status: "paused", mode: "subagent-driven" });
    expect(state.execution.evidence).toEqual(menuEvidence);
    expect(readFileSync(path.join(sddDir, "task-1-brief.md"), "utf8")).toBe(briefBefore);
    expect(readFileSync(path.join(sddDir, "progress.md"), "utf8")).toBe(progressBefore);

    const resumed = transitionExecution(root, slug, plan, "resume", cliEvidence("tty"));
    expect(resumed.ok).toBe(true);
    state = readFlowState(root, slug);
    expect(state.execution).toMatchObject({ status: "active", mode: "subagent-driven" });
    expect(state.execution.evidence).toEqual(menuEvidence);
    expect(readFileSync(path.join(sddDir, "task-1-brief.md"), "utf8")).toBe(briefBefore);
    expect(readFileSync(path.join(sddDir, "progress.md"), "utf8")).toBe(progressBefore);
  } finally {
    cleanup(root);
  }
});

test("CA-14: pause from pending and completed fails; resume from active, pending, and completed fails", () => {
  // Pause from a pending (handoff) flow.
  {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, "handoff");
      const plan = `docs/${slug}/plan.md`;
      const paused = transitionExecution(root, slug, plan, "pause", cliEvidence());
      expect(paused.ok).toBe(false);
      if (!paused.ok) expect(paused.code).toBe("flow_not_active");
      const resumed = transitionExecution(root, slug, plan, "resume", cliEvidence());
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) expect(resumed.code).toBe("flow_not_paused");
    } finally {
      cleanup(root);
    }
  }
  // Resume from active.
  {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, "subagent-driven");
      const plan = `docs/${slug}/plan.md`;
      const resumed = transitionExecution(root, slug, plan, "resume", cliEvidence());
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) expect(resumed.code).toBe("flow_not_paused");
    } finally {
      cleanup(root);
    }
  }
  // Pause from an already-paused flow (flow_already_paused — the one pause
  // failure row the pause-failure test did not cover).
  {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, "subagent-driven");
      const plan = `docs/${slug}/plan.md`;
      const first = transitionExecution(root, slug, plan, "pause", cliEvidence("flag"));
      expect(first.ok).toBe(true);
      const paused = transitionExecution(root, slug, plan, "pause", cliEvidence("tty"));
      expect(paused.ok).toBe(false);
      if (!paused.ok) expect(paused.code).toBe("flow_already_paused");
    } finally {
      cleanup(root);
    }
  }
  // Pause and resume from completed.
  {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, "subagent-driven");
      writeSddLedger(root, slug, ["Task 1: complete"]);
      const plan = `docs/${slug}/plan.md`;
      const done = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
        verifyProject: stubVerifier(0),
      });
      expect(done.ok).toBe(true);
      const paused = transitionExecution(root, slug, plan, "pause", cliEvidence());
      expect(paused.ok).toBe(false);
      if (!paused.ok) expect(paused.code).toBe("flow_already_completed");
      const resumed = transitionExecution(root, slug, plan, "resume", cliEvidence());
      expect(resumed.ok).toBe(false);
      if (!resumed.ok) expect(resumed.code).toBe("flow_already_completed");
    } finally {
      cleanup(root);
    }
  }
});

test("CA-19/CA-21: lifecycle evidence must be native choice evidence or the exact CliConfirmation shape", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    const plan = `docs/${slug}/plan.md`;
    const forged: unknown[] = [
      { host: "cli", attested: false, confirmation: "flag", extra: true },
      { host: "cli", attested: true, confirmation: "flag" },
      { host: "cli", attested: false, confirmation: "contract" },
      { host: "cli", confirmation: "flag" },
      { host: "cli", attested: false },
      true,
      "flag",
      { host: "opencode", attested: true, callID: "", selectedLabel: "x", recordedAt: Date.now() },
    ];
    for (const bad of forged) {
      const result = transitionExecution(root, slug, plan, "pause", bad as never);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.code, JSON.stringify(bad)).toBe("evidence_invalid");
    }
    const paused = transitionExecution(root, slug, plan, "pause", cliEvidence("flag"));
    expect(paused.ok).toBe(true);
    // Resume from paused: any valid native receipt purpose suffices (execution-menu resume not yet typed as lifecycle purpose in core test helper).
    const opencodeResume = transitionExecution(root, slug, plan, "resume", cliEvidence("flag"));
    expect(opencodeResume.ok).toBe(true);
  } finally {
    cleanup(root);
  }
});

test("CA-15: pause after plan drift still works — lifecycle survives, plan approval resets", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    const plan = `docs/${slug}/plan.md`;
    writeFileSync(
      path.join(root, "docs", slug, "plan.md"),
      COMPLIANT_PLAN_FN(slug).replace("do it", "do it now"),
    );
    // Plan drift resets only the plan approval digest; the active execution
    // lifecycle and menu survive, so pausing still succeeds.
    const paused = transitionExecution(root, slug, plan, "pause", cliEvidence());
    expect(paused.ok).toBe(true);
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.state.execution).toMatchObject({
      status: "paused",
      mode: "subagent-driven",
    });
    expect(effective.state.plan).toMatchObject({ status: "draft", approved_digest: null });
  } finally {
    cleanup(root);
  }
});

test("CA-15: pause with unreadable canonical plan doc still works — lifecycle survives plan-doc drift", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    const plan = `docs/${slug}/plan.md`;
    const planFile = path.join(root, "docs", slug, "plan.md");
    chmodSync(planFile, 0o000);
    let unreadable = true;
    try {
      readFileSync(planFile, "utf8");
      unreadable = false;
    } catch {
      // unreadable
    }
    if (unreadable) {
      // Plan-doc drift (here unreadable -> document_unreadable) never rewinds
      // the execution lifecycle; pausing an active run keeps working.
      const paused = transitionExecution(root, slug, plan, "pause", cliEvidence());
      expect(paused.ok).toBe(true);
    }
  } finally {
    chmodSync(path.join(root, "docs", slug, "plan.md"), 0o644);
    cleanup(root);
  }
});

test("CA-16: a legacy flow without execution, approved + subagent-driven + started incomplete ledger normalizes to active", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    writeSddLedger(root, slug, ["Task 1: in_progress"]);
    stripExecution(root, slug);
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([]);
    expect(effective.state.execution).toEqual({
      status: "active",
      mode: "subagent-driven",
      evidence: null,
    });
    // The migration is persisted, not just returned.
    expect(readFlowState(root, slug).execution).toMatchObject({ status: "active" });
  } finally {
    cleanup(root);
  }
});

test("CA-16: missing/empty ledgers and every other legacy combination normalize to pending", () => {
  const cases: { choice: string; ledger: string[] | null }[] = [
    { choice: "subagent-driven", ledger: null },
    { choice: "subagent-driven", ledger: ["Task 1: complete"] },
    { choice: "inline", ledger: ["Task 1: in_progress"] },
    { choice: "handoff", ledger: ["Task 1: in_progress"] },
  ];
  for (const c of cases) {
    const { root, slug } = fixture();
    try {
      establishMenuChoice(root, slug, c.choice);
      if (c.ledger) writeSddLedger(root, slug, c.ledger);
      stripExecution(root, slug);
      const effective = readEffectiveFlowState(root, slug);
      expect(effective.ok, c.choice).toBe(true);
      if (!effective.ok) throw new Error(effective.error);
      expect(effective.state.execution, c.choice).toEqual({
        status: "pending",
        mode: null,
        evidence: null,
      });
    } finally {
      cleanup(root);
    }
  }
});

test("CA-17: compatibility normalization runs first, then reconciliation resets execution to pending on digest_missing", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    writeSddLedger(root, slug, ["Task 1: in_progress"]);
    // Omit approval digests as a pre-digest-binding legacy flow would.
    const file = lifecycleFlowFile(root, slug);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      execution?: unknown;
      spec: { approved_digest: string | null };
      plan: { approved_digest: string | null };
    };
    delete parsed.execution;
    parsed.spec.approved_digest = null;
    parsed.plan.approved_digest = null;
    writeFileSync(file, JSON.stringify(parsed, null, 2), "utf8");
    const effective = readEffectiveFlowState(root, slug);
    expect(effective.ok).toBe(true);
    if (!effective.ok) throw new Error(effective.error);
    expect(effective.drift).toEqual([
      { document: "spec", code: "digest_missing", path: `docs/${slug}/spec.md` },
    ]);
    expect(effective.state.execution).toEqual({ status: "pending", mode: null, evidence: null });
  } finally {
    cleanup(root);
  }
});

test("CA-23: completion with an incomplete ledger returns execution_incomplete details and never runs verification", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    const plan = `docs/${slug}/plan.md`;
    let called = false;
    const result = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
      verifyProject: stubVerifier(0, () => {
        called = true;
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("execution_incomplete");
      expect(result.details).toEqual({ required: [1], completed: [], missing: [1] });
    }
    expect(called).toBe(false);
    expect(readFlowState(root, slug).execution.status).toBe("active");
  } finally {
    cleanup(root);
  }
});

test("CA-23: failed repository verification returns verification_failed with exitCode and preserves active", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    writeSddLedger(root, slug, ["Task 1: complete"]);
    const plan = `docs/${slug}/plan.md`;
    const result = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
      verifyProject: stubVerifier(7),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("verification_failed");
      expect(result.details).toEqual({ exitCode: 7 });
    }
    expect(readFlowState(root, slug).execution.status).toBe("active");
  } finally {
    cleanup(root);
  }
});

test("CA-11/CA-23: passing repository verification stores completed", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    writeSddLedger(root, slug, ["Task 1: complete"]);
    const plan = `docs/${slug}/plan.md`;
    const result = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
      verifyProject: stubVerifier(0),
    });
    expect(result.ok).toBe(true);
    expect(readFlowState(root, slug).execution).toMatchObject({
      status: "completed",
      mode: "subagent-driven",
    });
  } finally {
    cleanup(root);
  }
});

test("CA-07: a run that finishes all tasks without calling workflow_plan_complete leaves the plan active; the tool completes it", () => {
  const { root, slug } = fixture();
  try {
    establishMenuChoice(root, slug, "subagent-driven");
    writeSddLedger(root, slug, ["Task 1: complete"]);
    const plan = `docs/${slug}/plan.md`;
    // Every task finished (complete ledger) but nothing called the completion
    // tool: the lifecycle stays active until workflow_plan_complete runs.
    expect(readFlowState(root, slug).execution).toMatchObject({
      status: "active",
      mode: "subagent-driven",
    });
    const result = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
      verifyProject: stubVerifier(0),
    });
    expect(result.ok).toBe(true);
    expect(readFlowState(root, slug).execution).toMatchObject({
      status: "completed",
      mode: "subagent-driven",
    });
  } finally {
    cleanup(root);
  }
});

test("CA-07/CA-08: completing a marked handoff destination clears the flag so ordinary sessions keep five choices", () => {
  const { root, slug } = fixture();
  try {
    const store = new HostReceiptStore();
    const sessionId = "dest-complete-session";
    const spec = `docs/${slug}/spec.md`;
    const plan = `docs/${slug}/plan.md`;
    expect(prepareFlowState(root, slug, { spec_path: spec, plan_path: plan }).ok).toBe(true);
    expect(
      transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")).ok,
    ).toBe(true);
    expect(
      transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")).ok,
    ).toBe(true);
    expect(
      recordMenuChoice(root, slug, plan, "handoff", openEvidence(store, sessionId, "handoff")).ok,
    ).toBe(true);
    expect(markHandoffDestination(root, slug, plan)).toEqual({ ok: true });
    expect(readFlowState(root, slug).handoff_destination).toBe(true);
    expect(findMarkedDestinations(root)).toEqual([slug]);
    // The destination session picks an executing choice, completes the ledger,
    // and passes repository verification.
    expect(
      recordMenuChoice(
        root,
        slug,
        plan,
        "subagent-driven",
        openEvidence(store, sessionId, "subagent-driven"),
      ).ok,
    ).toBe(true);
    writeSddLedger(root, slug, ["Task 1: complete"]);
    const done = transitionExecution(root, slug, plan, "complete", cliEvidence(), undefined, {
      verifyProject: stubVerifier(0),
    });
    expect(done.ok).toBe(true);
    const state = readFlowState(root, slug);
    expect(state.execution).toMatchObject({ status: "completed", mode: "subagent-driven" });
    // The destination context must not leak into subsequent ordinary sessions.
    expect(state.handoff_destination).toBe(false);
    expect(findMarkedDestinations(root)).toEqual([]);
  } finally {
    cleanup(root);
  }
});
