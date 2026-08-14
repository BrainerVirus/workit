import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findActiveSubagentDrivenPlans,
  detectConfigGapError,
  detectBacktickDocRefs,
  detectRawDocDelivery,
} from "../../packages/workit-core/src/core/detector";
import {
  HostReceiptStore,
  prepareFlowState,
  markHandoffDestination,
  recordMenuChoice,
  transitionExecution,
  transitionPlan,
  transitionSpec,
} from "../../packages/workit-core/src/core/flow-state";
import plugin from "../../packages/workit-opencode/src/plugin";
import {
  shouldInjectSddReminder,
  SDD_REMINDER_TEXT,
  CONFIG_GUARD_TEXT,
  shouldInjectConfigGuard,
  DOC_DELIVERY_TEXT,
  DOC_RENDER_TEXT,
  shouldInjectDocRender,
  REMINDER_TEXT,
  DESTINATION_REMINDER_TEXT,
  reminderTextFor,
} from "../../packages/workit-core/src/core/reminder";
import {
  DESTINATION_MENU_LABELS,
  HANDOFF_DESTINATION_MARKER,
} from "../../packages/workit-core/src/core/flow-state";
import { openEvidence } from "../workit-core/flow-fixtures";

const REMINDER_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const REMINDER_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const writeDocs = (root: string, slug: string) => {
  mkdirSync(path.join(root, "docs", slug), { recursive: true });
  writeFileSync(path.join(root, "docs", slug, "spec.md"), REMINDER_SPEC(slug));
  writeFileSync(path.join(root, "docs", slug, "plan.md"), REMINDER_PLAN(slug));
};

const writeSddLedger = (root: string, slug: string, lines: string[]) => {
  const dir = path.join(root, "docs", slug, "sdd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "progress.md"), lines.join("\n") + "\n", "utf8");
};

/** Approve spec+plan and record the given post-plan menu choice. */
const establishMenuChoice = (root: string, slug: string, choice: string) => {
  writeDocs(root, slug);
  const spec = `docs/${slug}/spec.md`;
  const plan = `docs/${slug}/plan.md`;
  const store = new HostReceiptStore();
  const sessionId = "reminder-session";
  const prep = prepareFlowState(root, slug, { spec_path: spec, plan_path: plan });
  if (!prep.ok) throw new Error(prep.error);
  for (const step of [
    transitionSpec(root, slug, spec, openEvidence(store, sessionId, "Approve spec")),
    transitionPlan(root, slug, plan, openEvidence(store, sessionId, "Approve plan")),
  ])
    if (!step.ok) throw new Error(step.error);
  const menu = recordMenuChoice(root, slug, plan, choice, openEvidence(store, sessionId, choice));
  if (!menu.ok) throw new Error(menu.error);
};

const cliEvidence = () => ({ host: "cli", attested: false, confirmation: "flag" }) as const;

test("CA-11: a real active subagent-driven flow is discovered", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "foo", "subagent-driven");
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["foo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-11/CA-13: pending, paused, completed, and active inline flows are never discovered", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "pending", "handoff");
    establishMenuChoice(root, "inline", "inline");
    establishMenuChoice(root, "paused", "subagent-driven");
    expect(
      transitionExecution(root, "paused", "docs/paused/plan.md", "pause", cliEvidence()).ok,
    ).toBe(true);
    establishMenuChoice(root, "done", "subagent-driven");
    writeSddLedger(root, "done", ["Task 1: complete"]);
    const finished = transitionExecution(
      root,
      "done",
      "docs/done/plan.md",
      "complete",
      cliEvidence(),
      undefined,
      { verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: root }) },
    );
    expect(finished.ok).toBe(true);
    // Only the real active subagent-driven flow appears — a completed ledger
    // does not end an active execution; only the completed STATE does.
    expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns only the active slug among mixed plans", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "active", "subagent-driven");
    establishMenuChoice(root, "inactive", "handoff");
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

test("CA-17: a drift-reset active flow is not discovered after the plan changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "drift", "subagent-driven");
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["drift"]);
    writeFileSync(
      path.join(root, "docs", "drift", "plan.md"),
      REMINDER_PLAN("drift").replace("do it", "do it now"),
    );
    // The effective read reconciles the drift and resets execution to pending.
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

test("CA-08: the destination reminder carries the marker and never offers Handoff", () => {
  expect(DESTINATION_REMINDER_TEXT).toContain(HANDOFF_DESTINATION_MARKER);
  expect(DESTINATION_REMINDER_TEXT).not.toContain("Handoff");
  for (const label of DESTINATION_MENU_LABELS) {
    expect(DESTINATION_REMINDER_TEXT).toContain(label);
  }
  expect(reminderTextFor(true)).toBe(DESTINATION_REMINDER_TEXT);
  expect(reminderTextFor(false)).toBe(REMINDER_TEXT);
  expect(REMINDER_TEXT).toContain("Handoff");
});

test("CA-13: the SDD rail reminder never mentions the post-plan menu or Handoff", () => {
  expect(SDD_REMINDER_TEXT).toContain("subagent-driven");
  expect(SDD_REMINDER_TEXT).not.toContain("Handoff");
  expect(SDD_REMINDER_TEXT).not.toContain("Inline");
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

test("I-1: only a completed EXECUTION turns the rail off; a full ledger on an active flow does not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    // An active subagent-driven flow stays discovered even with a complete
    // ledger — completion is an explicit execution transition, not a ledger scan.
    establishMenuChoice(root, "active-full", "subagent-driven");
    writeSddLedger(root, "active-full", ["Task 1: complete"]);
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["active-full"]);

    // A completed execution is gone regardless of the ledger.
    establishMenuChoice(root, "executed", "subagent-driven");
    writeSddLedger(root, "executed", ["Task 1: complete"]);
    const finished = transitionExecution(
      root,
      "executed",
      "docs/executed/plan.md",
      "complete",
      cliEvidence(),
      undefined,
      { verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: root }) },
    );
    expect(finished.ok).toBe(true);
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["active-full"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-1: a missing or incomplete ledger keeps an active execution discovered", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "no-ledger", "subagent-driven");
    establishMenuChoice(root, "partial", "subagent-driven");
    writeSddLedger(root, "partial", ["Task 1: complete", "Task 2: in_progress"]);
    expect(findActiveSubagentDrivenPlans(root).sort()).toEqual(["no-ledger", "partial"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2: active execution is discovered regardless of last-task ledger coverage", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "p", "subagent-driven");
    writeSddLedger(root, "p", ["Task 1: complete", "Task 2: complete"]);
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
    writeSddLedger(root, "p", ["Task 1: complete", "Task 2: complete", "Task 3: complete"]);
    // Ledger coverage alone never ends an active execution.
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I-2d: an unreadable plan.md on an active flow fails closed (excluded via drift reset)", () => {
  if (process.platform === "win32") return; // chmod is not advisory on win32
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "p", "subagent-driven");
    expect(findActiveSubagentDrivenPlans(root)).toEqual(["p"]);
    const plan = path.join(root, "docs", "p", "plan.md");
    chmodSync(plan, 0o000);
    let unreadable = true;
    try {
      readFileSync(plan, "utf8");
      unreadable = false;
    } catch {
      // unreadable
    }
    if (unreadable) {
      expect(findActiveSubagentDrivenPlans(root)).toEqual([]);
    }
  } finally {
    chmodSync(path.join(root, "docs", "p", "plan.md"), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test("M-3: unreadable flow.json (EACCES) is skipped without throwing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    establishMenuChoice(root, "locked", "subagent-driven");
    const dir = path.join(root, "docs", "locked", "sdd");
    const flow = path.join(dir, "flow.json");
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
    chmodSync(path.join(root, "docs", "locked", "sdd", "flow.json"), 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

const reminderUserMessage = (text: string) => ({
  info: { role: "user" as const, id: "u", sessionID: "s", time: { created: 0, updated: 0 } },
  parts: [
    {
      type: "text" as const,
      text,
      id: "p",
      messageID: "u",
      sessionID: "s",
      time: { created: 0, updated: 0 },
    },
  ],
});

/** Drive the real OpenCode plugin's chat.messages.transform hook and return the injected turn text. */
const reminderInjectedText = async (root: string, message = "continue"): Promise<string> => {
  const hooks = await plugin({
    directory: root,
    worktree: root,
    serverUrl: new URL("http://localhost"),
  } as never);
  const output = { messages: [reminderUserMessage(message)] };
  await hooks["experimental.chat.messages.transform"]?.({} as never, output as never);
  return output.messages[0].parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
};

test("CA-08: a marked-destination flow drives the real plugin to inject the four-choice destination reminder", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-dest-"));
  try {
    establishMenuChoice(root, "dest", "handoff");
    const marked = markHandoffDestination(root, "dest", "docs/dest/plan.md");
    expect(marked.ok).toBe(true);

    const text = await reminderInjectedText(root);
    expect(text).toContain(DESTINATION_REMINDER_TEXT);
    expect(text).not.toContain(REMINDER_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA-08: ordinary, pending, paused, completed, and active-inline flows keep the five-choice source reminder", async () => {
  const roots: string[] = [];
  const buildRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-src-"));
    roots.push(root);
    return root;
  };
  const rootInline = buildRoot();
  const rootPending = buildRoot();
  const rootPaused = buildRoot();
  const rootDone = buildRoot();
  try {
    // active inline
    establishMenuChoice(rootInline, "inline", "inline");

    // pending (handoff chosen but destination never marked)
    establishMenuChoice(rootPending, "pending", "handoff");

    // paused subagent-driven
    establishMenuChoice(rootPaused, "paused", "subagent-driven");
    expect(
      transitionExecution(rootPaused, "paused", "docs/paused/plan.md", "pause", cliEvidence()).ok,
    ).toBe(true);

    // completed subagent-driven
    establishMenuChoice(rootDone, "done", "subagent-driven");
    writeSddLedger(rootDone, "done", ["Task 1: complete"]);
    const finished = transitionExecution(
      rootDone,
      "done",
      "docs/done/plan.md",
      "complete",
      cliEvidence(),
      undefined,
      { verifyProject: () => ({ stdout: "", stderr: "", exitCode: 0, cwd: rootDone }) },
    );
    expect(finished.ok).toBe(true);

    for (const root of [rootInline, rootPending, rootPaused, rootDone]) {
      const text = await reminderInjectedText(root);
      expect(text).toContain(REMINDER_TEXT);
      expect(text).not.toContain(DESTINATION_REMINDER_TEXT);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
