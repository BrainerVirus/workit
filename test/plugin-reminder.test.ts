import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findActiveSubagentDrivenPlans } from "../src/core/detector";
import { shouldInjectSddReminder, SDD_REMINDER_TEXT } from "../src/core/reminder";

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

test("I-1: fully complete progress.md ledger turns the rail off", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wf-reminder-"));
  try {
    writeFlow(root, "done", {
      menu: { chosen: "subagent-driven" },
      plan: { status: "approved" },
    });
    const dir = path.join(root, "docs", "done", "sdd");
    writeFileSync(path.join(dir, "progress.md"), "Task 1: complete\nTask 2: COMPLETE\n");
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
