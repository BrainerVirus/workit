import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TaskStore, WorkitCore, parseOperation } from "@/packages/workit-core/src/core";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { assessment, taskStartRequest } from "@/test/workit-core/task-fixtures";

const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const gitRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-protocol-"));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "T"],
  ])
    spawnSync("git", args, { cwd: root });
  writeFileSync(path.join(root, "base.txt"), "base\n");
  spawnSync("git", ["add", "base.txt"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
};

const coreFor = (root: string) =>
  new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "workit_cli", actor: "protocol-test" },
    capabilities: [],
    constraints: [],
    now: "2026-01-01T00:00:00Z",
  });

test("close accepts omitted decisionIds and writer reason is symmetric", () => {
  const close = parseOperation("task", {
    schemaVersion: 1,
    action: "close",
    taskId: TASK_ID,
    outcome: "verified",
    summary: "done",
  });
  expect(close.ok).toBe(true);
  const acquire = parseOperation("writer", {
    schemaVersion: 1,
    action: "acquire",
    taskId: TASK_ID,
    reason: "handoff",
  });
  expect(acquire.ok).toBe(true);
  const release = parseOperation("writer", {
    schemaVersion: 1,
    action: "release",
    taskId: TASK_ID,
  });
  expect(release.ok).toBe(true);
});

test("revision conflicts teach omission instead of blind retries", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const result = core.task({
      schemaVersion: 1,
      action: "progress",
      taskId: (started.data as { id: string }).id,
      expectedRevision: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      progress: { summary: "x", nextAction: null, blockers: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("revision_conflict");
      expect(result.error).toContain("omit expectedRevision");
      expect(result.details.actualRevision).toBeDefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope escapes teach one-task-per-repository with linked tasks", () => {
  const root = gitRepo();
  try {
    const result = captureCandidate(root, {
      description: "outside",
      paths: ["../outside"],
      exclusions: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("linked task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy placeholders are gone and summaries carry timestamps", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    expect(typeof (started.data as { createdAt?: unknown }).createdAt).toBe("string");
    expect(typeof (started.data as { updatedAt?: unknown }).updatedAt).toBe("string");
    const base = assessment();
    const assessed = core.policy({
      schemaVersion: 1,
      action: "assess",
      taskId: (started.data as { id: string }).id,
      assessment: {
        ...base,
        signals: {
          ...base.signals,
          productChoiceOpen: {
            value: true,
            basis: "inferred",
            reason: "an open product choice",
            refs: [],
          },
        },
      },
    });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok || !assessed.data) return;
    const product = assessed.data.requirements.find(
      (requirement) => requirement.ruleId === "product-decision",
    );
    expect(product?.dependentAction).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause keeps progress and stores the reason separately", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    expect(
      core.task({
        schemaVersion: 1,
        action: "progress",
        taskId,
        progress: { summary: "work in progress", nextAction: "next step", blockers: [] },
      }).ok,
    ).toBe(true);
    expect(
      core.task({ schemaVersion: 1, action: "pause", taskId, reason: "waiting for review" }).ok,
    ).toBe(true);
    const paused = new TaskStore(root).readTask(taskId);
    if (!paused.ok) throw new Error(paused.error);
    expect(paused.data.progress.summary).toBe("work in progress");
    expect(paused.data.progress.nextAction).toBe("next step");
    expect(paused.data.pauseReason).toBe("waiting for review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close reports rule-level remedies for unsatisfied requirements", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const assessed = core.policy({
      schemaVersion: 1,
      action: "assess",
      taskId: (started.data as { id: string }).id,
      assessment: assessment(),
    });
    expect(assessed.ok).toBe(true);
    const closed = core.task({
      schemaVersion: 1,
      action: "close",
      taskId: (started.data as { id: string }).id,
      outcome: "verified",
      summary: "done",
    });
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.code).toBe("requirements_unsatisfied");
      expect(closed.details.requirements?.length).toBeGreaterThan(0);
      const first = closed.details.requirements?.[0];
      expect(first?.ruleId).toBeTruthy();
      expect(first?.reason).toBeTruthy();
      expect(first?.satisfaction).toBeTruthy();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
