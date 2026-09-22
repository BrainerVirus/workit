import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TaskStore,
  WorkitCore,
  externalActionDescriptor,
  externalActionHelp,
  parseOperation,
  planCommitBinding,
  runtimeVersion,
} from "@/packages/workit-core/src/core";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { assessment, scope, taskStartRequest } from "@/test/workit-core/task-fixtures";

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
  expect(
    parseOperation("task", {
      schemaVersion: 1,
      action: "inspect",
      taskId: TASK_ID,
    }).ok,
  ).toBe(true);
  expect(
    parseOperation("task", {
      schemaVersion: 1,
      action: "resume",
      taskId: TASK_ID,
    }).ok,
  ).toBe(true);
  expect(externalActionHelp).toContain("{branch:string}");
  expect(externalActionHelp).toContain("github_issue");
});

test("ordinary paused tasks resume without imported-task authority refs", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    expect(core.task({ schemaVersion: 1, action: "pause", taskId, reason: "park" })).toMatchObject({
      ok: true,
      data: { status: "paused" },
    });
    expect(core.task({ schemaVersion: 1, action: "resume", taskId })).toMatchObject({
      ok: true,
      data: { status: "active" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker scope denials identify both conflicting scopes", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(
      taskStartRequest({
        intent: { ...taskStartRequest().intent, scope: scope({ paths: ["src"] }) },
      }),
    );
    if (!started.ok) throw new Error(started.error);
    const denied = core.worker({
      schemaVersion: 1,
      action: "assign",
      taskId: (started.data as { id: string }).id,
      assignment: {
        role: "implementer",
        objective: "outside",
        scope: scope({ paths: ["other"] }),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
    });
    expect(denied).toMatchObject({
      ok: false,
      code: "permission_denied",
      details: {
        fields: [{ path: "assignment.scope" }, { path: "task.intent.scope" }],
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task list defaults to a bounded compact open-task projection", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    for (let index = 0; index < 22; index += 1) {
      const started = core.task(
        taskStartRequest({
          expectedWorkspaceRevision: undefined,
          intent: { ...taskStartRequest().intent, objective: `closed ${index}` },
        }),
      );
      if (!started.ok) throw new Error(started.error);
      const closed = core.task({
        schemaVersion: 1,
        action: "close",
        taskId: (started.data as { id: string }).id,
        outcome: "stopped",
        summary: "stopped",
      });
      if (!closed.ok) throw new Error(closed.error);
    }
    const active = core.task(
      taskStartRequest({
        expectedWorkspaceRevision: undefined,
        intent: { ...taskStartRequest().intent, objective: "active" },
      }),
    );
    if (!active.ok) throw new Error(active.error);

    const open = core.task({ schemaVersion: 1, action: "list" });
    expect(open).toMatchObject({ ok: true, data: [{ objective: "active", status: "active" }] });
    if (!open.ok || !Array.isArray(open.data)) throw new Error("task list failed");
    expect(open.data).toHaveLength(1);
    expect(open.data[0]).not.toHaveProperty("policy");
    expect(open.data[0]).not.toHaveProperty("requirements");

    const history = core.task({ schemaVersion: 1, action: "list", status: "closed", limit: 5 });
    if (!history.ok || !Array.isArray(history.data)) throw new Error("task history failed");
    expect(history.data).toHaveLength(5);
    expect(history.data.every((item) => "writer" in item && item.writer === null)).toBe(true);

    const inspected = core.task({
      schemaVersion: 1,
      action: "inspect",
      taskId: history.data[0].id,
      view: "summary",
    });
    expect(inspected).toMatchObject({ ok: true, data: { status: "closed", writer: null } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing A to B to A history retains A as the closure candidate", () => {
  const root = gitRepo();
  try {
    const store = new TaskStore(root);
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const task = store.readTask(taskId);
    if (!task.ok) throw new Error(task.error);
    const a = captureCandidate(root, task.data.intent.data.scope, {});
    if (!a.ok) throw new Error(a.error);
    writeFileSync(path.join(root, "base.txt"), "changed\n");
    const b = captureCandidate(root, task.data.intent.data.scope, {});
    if (!b.ok) throw new Error(b.error);
    const seeded = store.mutateTask(taskId, task.data.revision, (value, mutation) => ({
      ok: true,
      schemaVersion: 1,
      revision: mutation.revision,
      workspaceRevision: null,
      data: { ...value, candidates: [a.data, b.data] },
    }));
    if (!seeded.ok) throw new Error(seeded.error);
    writeFileSync(path.join(root, "base.txt"), "base\n");
    const closed = core.task({
      schemaVersion: 1,
      action: "close",
      taskId,
      outcome: "stopped",
      summary: "stopped",
    });
    if (!closed.ok) throw new Error(closed.error);
    const persisted = store.readTask(taskId);
    if (!persisted.ok) throw new Error(persisted.error);
    expect(persisted.data.candidates.map((candidate) => candidate.id)).toEqual([
      a.data.id,
      b.data.id,
      a.data.id,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("new and legacy records carry truthful runtime versions", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const version = runtimeVersion();
    expect(
      (started.data as { runtime?: { createdWith?: string; updatedWith?: string } }).runtime,
    ).toEqual({ createdWith: version, updatedWith: version });
    const workspace = new TaskStore(root).readWorkspace();
    if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
    expect(workspace.data.runtime).toEqual({ createdWith: version, updatedWith: version });

    const taskFile = path.join(root, ".workit", "tasks", `${taskId}.json`);
    const raw = JSON.parse(readFileSync(taskFile, "utf8"));
    delete raw.runtime;
    writeFileSync(taskFile, JSON.stringify(raw));
    const legacy = core.task({ schemaVersion: 1, action: "inspect", taskId, view: "summary" });
    expect(legacy.ok).toBe(true);
    expect(
      core.task({
        schemaVersion: 1,
        action: "progress",
        taskId,
        progress: { summary: "stamped", nextAction: null, blockers: [] },
      }).ok,
    ).toBe(true);
    const stamped = JSON.parse(readFileSync(taskFile, "utf8"));
    expect(stamped.runtime).toEqual({ createdWith: null, updatedWith: version });

    const workspaceFile = path.join(root, ".workit", "workspace.json");
    const rawWorkspace = JSON.parse(readFileSync(workspaceFile, "utf8"));
    delete rawWorkspace.runtime;
    writeFileSync(workspaceFile, JSON.stringify(rawWorkspace));
    const acquired = core.writer({
      schemaVersion: 1,
      action: "acquire",
      taskId,
      workerId: null,
    });
    expect(acquired.ok).toBe(true);
    const workspaceAfter = JSON.parse(readFileSync(workspaceFile, "utf8"));
    expect(workspaceAfter.runtime).toEqual({ createdWith: null, updatedWith: version });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records written by a newer Workit ask for an upgrade", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const taskFile = path.join(root, ".workit", "tasks", `${taskId}.json`);
    const raw = JSON.parse(readFileSync(taskFile, "utf8"));
    raw.runtime = { createdWith: "99.0.0", updatedWith: "99.0.0" };
    raw.futureField = "unknown-to-this-runtime";
    writeFileSync(taskFile, JSON.stringify(raw));
    const task = new TaskStore(root).readTask(taskId);
    expect(task.ok).toBe(false);
    if (!task.ok) {
      expect(task.code).toBe("recovery_required");
      expect(task.error).toContain("upgrade Workit");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan commit bindings refuse branches other than the approved one", () => {
  const root = gitRepo();
  try {
    const core = coreFor(root);
    const started = core.task(taskStartRequest());
    if (!started.ok) throw new Error(started.error);
    const taskId = (started.data as { id: string }).id;
    const store = new TaskStore(root);
    const workspace = store.readWorkspace();
    const task = store.readTask(taskId);
    if (!workspace.ok || !workspace.data || !task.ok) throw new Error("state missing");
    const planDescriptor = externalActionDescriptor("git.commit", {
      plan_steps: ["chore(a): one"],
      plan_branch: "feature/plan",
      resolved: {
        head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(),
        branch: "feature/plan",
        steps: ["chore(a): one"],
      },
    });
    const taskFile = path.join(root, ".workit", "tasks", `${taskId}.json`);
    const raw = JSON.parse(readFileSync(taskFile, "utf8"));
    raw.decisions = [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        recordedAt: "2026-01-01T00:00:00Z",
        provenance: {
          kind: "host_observed",
          host: "workit_cli",
          session: { kind: "host", host: "workit_cli", handle: "protocol-test" },
          workerId: null,
          receipts: [{ kind: "host", host: "workit_cli", handle: "call-1" }],
        },
        data: {
          purpose: "action",
          binding: {
            taskId,
            workspaceId: workspace.data.id,
            scope: task.data.intent.data.scope,
            presented: "Approve the listed plan commits.",
            approvedContent: planDescriptor,
            contentRefs: [],
          },
          digest: "b".repeat(64),
          response: "approved",
          requirementIds: [],
          revoked: null,
          consumption: null,
        },
      },
    ];
    writeFileSync(taskFile, JSON.stringify(raw));
    const commitDescriptor = externalActionDescriptor("git.commit", {
      message: "chore(a): one",
      resolved: { head: "x", branch: "feature/plan", staged: "s", paths: ["x"] },
    });
    const mismatched = planCommitBinding(
      new TaskStore(root),
      "workit_cli",
      "protocol-test",
      commitDescriptor,
    );
    expect(mismatched).toBeNull();
    spawnSync("git", ["checkout", "-q", "-b", "feature/plan"], { cwd: root });
    const bound = planCommitBinding(
      new TaskStore(root),
      "workit_cli",
      "protocol-test",
      commitDescriptor,
    );
    expect(bound).toMatchObject({ step: "chore(a): one" });
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
