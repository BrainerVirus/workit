import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findActiveSubagentDrivenPlans, detectConfigGapError, detectBacktickDocRefs, detectRawDocDelivery } from "../packages/workit/src/core/detector";
import { shouldInjectSddReminder, SDD_REMINDER_TEXT, CONFIG_GUARD_TEXT, shouldInjectConfigGuard, DOC_DELIVERY_TEXT, DOC_RENDER_TEXT, shouldInjectDocRender, REMINDER_TEXT } from "../packages/workit/src/core/reminder";

const writeFlow = (root: string, slug: string, flow: unknown) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "flow.json"), JSON.stringify(flow));
};

test("CA-02: returns slug when menu.chosen is subagent-driven and plan is approved", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "foo", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["foo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-02b: excludes plans not chosen subagent-driven or not approved", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "a", { menu: { chosen: "inline" }, plan: { status: "approved" } });
    writeFlow(root, "b", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "self_reviewed" },
    });
    writeFlow(root, "c", {
      menu: { chosen: "review-spec" },
      plan: { status: "approved" },
    });
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns only the active slug among mixed plans", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "active", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    writeFlow(root, "inactive", {
      menu: { chosen: "handoff" },
      plan: { status: "approved" },
    });
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["active"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-04: no docs dir yields empty list", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-04: malformed flow.json is skipped without throwing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    const dir = path.join(root, "docs", "bad", "sdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "flow.json"), "{ not json");
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-04: empty flow.json is skipped without throwing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    const dir = path.join(root, "docs", "empty", "sdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "flow.json"), "");
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-03: reminder is injected only when the marker is absent (idempotent)", () => {
  expect(shouldInjectSddReminder("plain user message")).toBe(true);
  expect(shouldInjectSddReminder(SDD_REMINDER_TEXT)).toBe(false);
  expect(shouldInjectSddReminder(`message with ${SDD_REMINDER_TEXT} marker`)).toBe(false);
  expect(shouldInjectSddReminder("partial <workflow-sdd-reminder> tag alone")).toBe(true);
});

test("CA-06: contract reminder carries the superpowers self-review ritual line", () => {
  expect(REMINDER_TEXT).toContain("Self-Review checklist");
  expect(REMINDER_TEXT).toContain("spec coverage (every spec requirement maps to a task)");
  expect(REMINDER_TEXT).toContain("placeholder scan");
  expect(REMINDER_TEXT).toContain("type consistency");
  expect(REMINDER_TEXT).toContain("workflow_spec_approve");
  expect(REMINDER_TEXT).toContain("workflow_plan_approve");
});

test("CA-03: config-gap marker in assistant text → detector true, guard injects", () => {
  const assistant =
    "Error: workflow config missing: youtrack_json. Run `npx workit init` or `/wk-init` to configure.";
  expect(detectConfigGapError(assistant)).toBe(true);
  expect(shouldInjectConfigGuard("plain user message")).toBe(true);
});

test("CA-03: no config-gap marker in assistant text → detector false, no injection", () => {
  expect(detectConfigGapError("tool ran fine, nothing missing")).toBe(false);
  expect(detectConfigGapError("")).toBe(false);
});

test("CA-03: idempotent — text already containing CONFIG_GUARD_TEXT → helper false", () => {
  expect(shouldInjectConfigGuard(CONFIG_GUARD_TEXT)).toBe(false);
  expect(shouldInjectConfigGuard(`message with ${CONFIG_GUARD_TEXT} marker`)).toBe(false);
  expect(shouldInjectConfigGuard("partial <workflow-config-guard> tag alone")).toBe(true);
});

test("CA-05: fail-closed — detector never throws on empty/plain input", () => {
  expect(detectConfigGapError("")).toBe(false);
  expect(detectConfigGapError("no config mentions here")).toBe(false);
});

test("CA-04: CONFIG_GUARD_TEXT asks a native question with exactly three options", () => {
  expect(CONFIG_GUARD_TEXT).toContain("question");
  expect(CONFIG_GUARD_TEXT).toContain("configure only what's missing");
  expect(CONFIG_GUARD_TEXT).toContain("npx workit init");
  expect(CONFIG_GUARD_TEXT).toContain("skip");
});

test("CA-03: raw fenced # Spec: block → detector true, render helper true", () => {
  const assistant =
    "Here is the spec:\n```\n# Spec: docs/foo/spec.md\n**Branch:** feature/foo\n```";
  expect(detectRawDocDelivery(assistant)).toBe(true);
  expect(shouldInjectDocRender("plain user message")).toBe(true);
});

test("CA-03: text without fences → detector false", () => {
  expect(detectRawDocDelivery("no fences here # Spec")).toBe(false);
  expect(detectRawDocDelivery("``` alone without markers")).toBe(false);
  expect(detectRawDocDelivery("plain message")).toBe(false);
});

test("I-1: rendered doc with labeled mermaid fence is NOT raw delivery", () => {
  const assistant =
    "Here's the spec:\n```mermaid\nflowchart TD\n  a --> b\n```\n# Spec: docs/foo/spec.md\n**Branch:** feature/foo";
  expect(detectRawDocDelivery(assistant)).toBe(false);
});

test("I-1: plain unlabeled fence carrying # Spec: IS raw delivery", () => {
  const assistant =
    "Here is the spec:\n```\n# Spec: docs/foo/spec.md\n**Branch:** feature/foo\n```";
  expect(detectRawDocDelivery(assistant)).toBe(true);
});

test("CA-03: idempotent — text already containing DOC_RENDER_TEXT → helper false", () => {
  expect(shouldInjectDocRender(DOC_RENDER_TEXT)).toBe(false);
  expect(shouldInjectDocRender(`message with ${DOC_RENDER_TEXT} marker`)).toBe(false);
  expect(shouldInjectDocRender("partial <workflow-doc-render> tag alone")).toBe(true);
});

test("CA-05: fail-closed — raw-delivery detector never throws on empty/weird input", () => {
  expect(detectRawDocDelivery("")).toBe(false);
  expect(detectRawDocDelivery("```\n```")).toBe(false);
  expect(detectRawDocDelivery("\u0000\u0001\u0002")).toBe(false);
});

test("CA-03: composition — backtick doc ref and raw fenced spec can both fire", () => {
  const assistant =
    "See `docs/foo/spec.md`\n```\n# Spec: docs/foo/spec.md\n**Branch:** feature/foo\n```";
  expect(detectBacktickDocRefs(assistant)).not.toBeNull();
  expect(detectRawDocDelivery(assistant)).toBe(true);
  expect(`${DOC_DELIVERY_TEXT}\n${DOC_RENDER_TEXT}`).toContain("workflow-doc-delivery");
  expect(`${DOC_DELIVERY_TEXT}\n${DOC_RENDER_TEXT}`).toContain("workflow-doc-render");
});

test("I-1: fully complete progress.md ledger turns the rail off", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "done", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "done", "sdd");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: COMPLETE\n");
    writeFileSync(path.join(root, "docs", "done", "plan.md"), "### Task 1: A\n### Task 2: B\n");
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-1: missing or incomplete progress.md keeps the slug active", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "no-ledger", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    writeFlow(root, "partial", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "partial", "sdd");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: in_progress\n");
    expect(findActiveSubagentDrivenPlans(root).sort()).toEqual(["no-ledger", "partial"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2a: last task present but not complete keeps the rail on", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "p", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "p", "sdd");
    writeFileSync(path.join(root, "docs", "p", "plan.md"), "### Task 1: A\n### Task 2: B\n### Task 3: C\n");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: complete\nTask 3: in_progress\n");
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2b: last task missing from the ledger keeps the rail on", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "p", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "p", "sdd");
    writeFileSync(path.join(root, "docs", "p", "plan.md"), "### Task 1: A\n### Task 2: B\n### Task 3: C\n");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: complete\n");
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2c: ledger covering all plan tasks turns the rail off", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "p", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "p", "sdd");
    writeFileSync(path.join(root, "docs", "p", "plan.md"), "### Task 1: A\n### Task 2: B\n### Task 3: C\n");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: complete\nTask 3: complete\n");
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2d: unreadable plan.md keeps the rail on", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "p", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "p", "sdd");
    const plan = path.join(root, "docs", "p", "plan.md");
    writeFileSync(plan, "### Task 1: A\n### Task 2: B\n### Task 3: C\n");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: complete\nTask 3: complete\n");
    chmodSync(plan, 0o000);
    let stillReadable = true;
    try {
      readFileSync(plan, "utf8");
    } catch {
      stillReadable = false;
    }
    if (!stillReadable) {
      expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M-3: unreadable flow.json (EACCES) is skipped without throwing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    const dir = path.join(root, "docs", "locked", "sdd");
    mkdirSync(dir, { recursive: true });
    const flow = path.join(dir, "flow.json");
    writeFileSync(
      flow,
      JSON.stringify({ menu: { chosen: "subagent-driven" }, plan: { status: "approved" } }),
    );
    chmodSync(flow, 0o000);
    let stillReadable = true;
    try {
      readFileSync(flow, "utf8");
    } catch {
      stillReadable = false;
    }
    if (!stillReadable) {
      expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
