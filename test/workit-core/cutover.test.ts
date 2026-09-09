import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyCutover,
  applyRollback,
  classifyHostGeneration,
  countLegacyFlowRecords,
  detectCursorLatest,
  detectSourceLinkedOpenCode,
  digestFile,
  legacyFlowRecordDigests,
  previewCutover,
  previewRollback,
} from "../../packages/workit-core/src/core/cutover";
import { installV1Skills, removeLegacySkills } from "../shared/helpers/cutover-fixture";
import { applyFxCutover, approve, makeFx, resolvePathsForTest } from "./cutover-test-helpers";

test("rollback refuses to overwrite a subsequent user edit", () => {
  const fx = makeFx();
  try {
    const cutover = applyFxCutover(fx);
    writeFileSync(fx.cursorMcp, readFileSync(fx.cursorMcp, "utf8") + "\n");
    expect(applyRollback(cutover.backupId, resolvePathsForTest(fx))).toMatchObject({
      ok: false,
      code: "revision_conflict",
    });
  } finally {
    fx.cleanup();
  }
});

test("all 31 legacy workflow records stay byte-stable through cutover", () => {
  const fx = makeFx();
  try {
    const before = legacyFlowRecordDigests(fx.workspace);
    expect(before.length).toBe(31);
    applyFxCutover(fx);
    expect(legacyFlowRecordDigests(fx.workspace)).toEqual(before);
    expect(countLegacyFlowRecords(fx.workspace)).toBe(31);
  } finally {
    fx.cleanup();
  }
});

test("v1 task data and repository work are preserved on rollback conflict", () => {
  const fx = makeFx();
  try {
    const taskFile = path.join(fx.workspace, ".workit", "tasks", "task-1.json");
    const taskBefore = readFileSync(taskFile, "utf8");
    const cutover = applyFxCutover(fx);
    writeFileSync(fx.cursorSettings, '{"edited":true}\n');
    expect(applyRollback(cutover.backupId, resolvePathsForTest(fx)).ok).toBe(false);
    expect(readFileSync(taskFile, "utf8")).toBe(taskBefore);
  } finally {
    fx.cleanup();
  }
});

test("new v1 task may reference old docs without importing authority", () => {
  const fx = makeFx();
  try {
    const task = JSON.parse(
      readFileSync(path.join(fx.workspace, ".workit", "tasks", "task-1.json"), "utf8"),
    );
    expect(task.title).toContain("docs/legacy-flow-0/spec.md");
    const flow = JSON.parse(
      readFileSync(path.join(fx.workspace, "docs/legacy-flow-0/sdd/flow.json"), "utf8"),
    );
    expect(flow.execution.status).not.toBe(task.execution?.status);
  } finally {
    fx.cleanup();
  }
});

test("detects current source-linked OpenCode registration", () => {
  const fx = makeFx();
  try {
    expect(detectSourceLinkedOpenCode(fx.opencodeConfig)).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("detects Cursor @latest canonical registration", () => {
  const fx = makeFx();
  try {
    expect(detectCursorLatest(fx.cursorMcp)).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("refuses mixed host components during preview", () => {
  const fx = makeFx();
  try {
    installV1Skills(fx.pluginDir);
    expect(classifyHostGeneration("cursor", {
      home: fx.home,
      configDir: fx.configDir,
      stateDir: fx.stateDir,
      dev: fx.dev,
      workspace: fx.workspace,
      opencodeConfig: fx.opencodeConfig,
      cursorSettings: fx.cursorSettings,
      cursorMcp: fx.cursorMcp,
      cursorPluginDir: fx.pluginDir,
      sessions: [],
    })).toBe("mixed");
    expect(previewCutover(resolvePathsForTest(fx)).blocked.some((b) => b.includes("mixed"))).toBe(
      true,
    );
  } finally {
    fx.cleanup();
  }
});

test("active or unknown old sessions block activation", () => {
  const fx = makeFx();
  try {
    expect(
      previewCutover({
        ...resolvePathsForTest(fx),
        sessions: [{ host: "opencode", handle: "ses_live", state: "active" }],
      }).blocked.some((b) => b.includes("active")),
    ).toBe(true);
    expect(
      previewCutover({
        ...resolvePathsForTest(fx),
        sessions: [{ host: "cursor", handle: "ses_x", state: "unknown" }],
      }).blocked.some((b) => b.includes("unknown")),
    ).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("apply backs up managed digests and reports activation receipt", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const receipt = applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["opencode", "cursor", "codex", "pi"]),
      resolvePathsForTest(fx),
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.data.backupId).toBeTruthy();
    expect(receipt.data.managedFiles.length).toBeGreaterThan(0);
    expect(receipt.data.partial).toBe(false);
    expect(
      previewRollback(receipt.data.backupId, resolvePathsForTest(fx)).restorable.length,
    ).toBeGreaterThan(0);
  } finally {
    fx.cleanup();
  }
});

test("rollback restores managed integration files without removing v1 task state", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    const beforeMcp = readFileSync(fx.cursorMcp, "utf8");
    const applied = applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["cursor"]),
      resolvePathsForTest(fx),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(readFileSync(fx.cursorMcp, "utf8")).not.toBe(beforeMcp);
    expect(applyRollback(applied.data.backupId, resolvePathsForTest(fx)).ok).toBe(true);
    expect(readFileSync(fx.cursorMcp, "utf8")).toBe(beforeMcp);
    expect(existsSync(path.join(fx.workspace, ".workit", "tasks", "task-1.json"))).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("coherent host replacement removes legacy cursor skills", () => {
  const fx = makeFx();
  try {
    removeLegacySkills(fx.pluginDir);
    installV1Skills(fx.pluginDir);
    applyCutover(
      previewCutover(resolvePathsForTest(fx)),
      approve(["cursor"]),
      resolvePathsForTest(fx),
    );
    expect(existsSync(path.join(fx.pluginDir, "skills", "wk-init"))).toBe(false);
    expect(existsSync(path.join(fx.pluginDir, "skills", "workit-plan"))).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("previewCutover is read-only", () => {
  const fx = makeFx();
  try {
    const before = digestFile(fx.cursorMcp);
    previewCutover(resolvePathsForTest(fx));
    expect(digestFile(fx.cursorMcp)).toBe(before);
  } finally {
    fx.cleanup();
  }
});
