import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  compactTaskContext,
  sha256,
  success,
  type Assessment,
  type TaskView,
} from "@/packages/workit-core/src/core";
import { fileSignature, racySignature } from "@/packages/workit-core/src/core/task-store";
import * as evaluation from "@/packages/workit-core/src/core/task-evaluation";
import { compactContextFor, unfinishedTaskOfferFor } from "@/packages/workit-opencode/src/runtime";
import { assessment, ref, scope, taskStartRequest } from "@/test/workit-core/task-fixtures";

const withRoot = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "workit-index-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const coreFor = (root: string, actor: string) =>
  new WorkitCore(new TaskStore(root), {
    root,
    caller: { host: "opencode", actor },
    capabilities: [],
    constraints: [],
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });

const start = (root: string, actor: string, objective: string) => {
  const { expectedWorkspaceRevision: _, ...request } = taskStartRequest({
    intent: { objective, scope: scope(), authorityRefs: [] },
  });
  const started = coreFor(root, actor).task(request);
  if (!started.ok) throw new Error(started.error);
  return started.data as { id: string; revision: string };
};

const indexPath = (root: string) => join(root, ".workit", "index.json");

test("task writes maintain the index without a listing pass", () => {
  withRoot((root) => {
    const task = start(root, "lead", "indexed on write");
    const index = JSON.parse(readFileSync(indexPath(root), "utf8"));
    expect(index.tasks[task.id]).toMatchObject({
      id: task.id,
      status: "active",
      objective: "indexed on write",
      sessions: [{ host: "opencode", handle: "lead", workerId: null }],
    });
  });
});

test("Given the index is missing or corrupt, Then listing rebuilds it from the records", () => {
  withRoot((root) => {
    const first = start(root, "a", "first");
    const second = start(root, "b", "second");
    const store = new TaskStore(root);
    const expected = store.listTasks();
    if (!expected.ok) throw new Error(expected.error);

    for (const damage of [
      () => rmSync(indexPath(root)),
      () => writeFileSync(indexPath(root), "{not json"),
    ]) {
      damage();
      const listed = store.listTaskIndex();
      if (!listed.ok) throw new Error(listed.error);
      expect(listed.data.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
      expect(listed.data.map((entry) => entry.revision).sort()).toEqual(
        expected.data.map((task) => task.revision).sort(),
      );
      const rebuilt = JSON.parse(readFileSync(indexPath(root), "utf8"));
      expect(Object.keys(rebuilt.tasks).sort()).toEqual([first.id, second.id].sort());
    }
  });
});

test("index entries follow records changed outside the index (older writers)", () => {
  withRoot((root) => {
    const task = start(root, "lead", "original objective");
    const file = join(root, ".workit", "tasks", `${task.id}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.progress.summary = "written by an older runtime";
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const listed = new TaskStore(root).listTaskIndex();
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.data[0]!.progress.summary).toBe("written by an older runtime");
  });
});

test("index listing reports invalid records like listTasks", () => {
  withRoot((root) => {
    const task = start(root, "lead", "will break");
    writeFileSync(join(root, ".workit", "tasks", `${task.id}.json`), "{broken");
    const store = new TaskStore(root);
    const listed = store.listTaskIndex();
    expect(listed.ok).toBe(false);
    expect(listed.ok ? null : listed.code).toBe("recovery_required");
  });
});

test("Given a task is updated, Then the next turn's context reflects it", () => {
  withRoot((root) => {
    const task = start(root, "turns", "cached context");
    const first = compactContextFor(root, "turns");
    expect(first).not.toBeNull();
    expect(JSON.parse(first!).nextAction).toBeNull();
    expect(compactContextFor(root, "turns")).toBe(first);

    const progressed = coreFor(root, "turns").task({
      schemaVersion: 1,
      action: "progress",
      taskId: task.id,
      expectedRevision: task.revision,
      progress: { summary: "halfway", nextAction: "write the tests", blockers: [] },
    });
    if (!progressed.ok) throw new Error(progressed.error);
    expect(JSON.parse(compactContextFor(root, "turns")!).nextAction).toBe("write the tests");

    rmSync(indexPath(root));
    expect(JSON.parse(compactContextFor(root, "turns")!).nextAction).toBe("write the tests");
    expect(existsSync(indexPath(root))).toBe(true);
  });
});

test("context injection never captures a candidate; full inspection still does", () => {
  withRoot((root) => {
    const task = start(root, "lead", "no capture");
    const capture = spyOn(evaluation, "captureCandidate");
    try {
      expect(compactContextFor(root, "lead")).not.toBeNull();
      writeFileSync(join(root, "product.txt"), "changed");
      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(capture).not.toHaveBeenCalled();
      coreFor(root, "lead").task({
        schemaVersion: 1,
        action: "inspect",
        taskId: task.id,
        view: "full",
      });
      expect(capture).toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });
});

test("history offers come from the index and exclude the current session", () => {
  withRoot((root) => {
    start(root, "mine", "my task");
    const other = start(root, "other", "parked <topic>");
    const offer = unfinishedTaskOfferFor(root, "opencode", "mine");
    expect(offer).toContain(other.id);
    expect(offer).toContain('"parked  topic "');
    expect(offer).not.toContain("my task");
  });
});

const behavioral = (): Assessment["signals"] => ({
  approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
  productChoiceOpen: { value: false, basis: "inferred", reason: "settled", refs: [] },
  behaviorChange: { value: true, basis: "observed", reason: "behavior", refs: [ref()] },
  mechanicalLowRisk: { value: false, basis: "inferred", reason: "behavioral", refs: [] },
  durableAgreementNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
  coordinationPlanNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
  helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
  testFirstPractical: { value: false, basis: "inferred", reason: "none", refs: [] },
});

test("capture-free context matches full inspection when a passing baseline precedes GREEN", () => {
  withRoot((root) => {
    writeFileSync(join(root, "a.ts"), "before");
    const core = coreFor(root, "lead");
    const task = start(root, "lead", "baseline then green");
    const assessed = core.policy({
      schemaVersion: 1,
      action: "assess",
      taskId: task.id,
      assessment: assessment({ signals: behavioral() }),
    });
    if (!assessed.ok) throw new Error(assessed.error);
    const record = new TaskStore(root).readTask(task.id);
    if (!record.ok) throw new Error(record.error);
    const testing = record.data.policy!.requirements.find((item) => item.dimension === "testing")!;
    const check = (claim: string) =>
      core.evidence({
        schemaVersion: 1,
        action: "record",
        taskId: task.id,
        evidence: {
          kind: "check",
          claim,
          requirementIds: [testing.id],
          result: "passed",
          summary: claim,
          refs: [],
          exitCode: 0,
          reviewContext: null,
        },
      });
    expect(check("baseline on C1").ok).toBe(true);
    writeFileSync(join(root, "a.ts"), "after");
    expect(check("green on C2").ok).toBe(true);

    const full = core.task({ schemaVersion: 1, action: "inspect", taskId: task.id, view: "full" });
    if (!full.ok) throw new Error(full.error);
    const fast = core.compactContext(task.id);
    if (!fast.ok) throw new Error(fast.error);
    expect(JSON.parse(fast.data).gaps).toEqual(
      JSON.parse(compactTaskContext(full.data as TaskView)).gaps,
    );
    expect(fast.data).toBe(compactTaskContext(full.data as TaskView));
  });
});

test("cached context invalidates when a cited decision document or the workspace changes", () => {
  withRoot((root) => {
    const task = start(root, "lead", "cited documents");
    const store = new TaskStore(root);
    // Let the document age past the racy-signature window (ctime cannot be back-dated).
    const settle = () => Bun.sleepSync(2100);
    writeFileSync(join(root, "decision.md"), "approved design");
    settle();
    const current = store.readTask(task.id);
    if (!current.ok) throw new Error(current.error);
    const injected = store.mutateTask(task.id, current.data.revision, (record) =>
      success(null, null, {
        ...record,
        decisions: [
          {
            id: "00000000-0000-4000-8000-0000000000d1",
            recordedAt: record.createdAt,
            provenance: record.intent.provenance,
            data: {
              purpose: "design",
              binding: {
                taskId: record.id,
                workspaceId: record.workspaceId,
                scope: scope(),
                presented: "design",
                approvedContent: "design",
                contentRefs: [{ kind: "file", path: "decision.md", digest: sha256("x") }],
              },
              digest: sha256("design"),
              response: "approved",
              requirementIds: [],
              revoked: null,
              consumption: null,
            },
          },
        ],
      }),
    );
    if (!injected.ok) throw new Error(injected.error);

    const built = spyOn(WorkitCore.prototype, "compactContext");
    try {
      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(built).toHaveBeenCalledTimes(1);

      writeFileSync(join(root, "decision.md"), "edited design document");
      settle();
      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(built).toHaveBeenCalledTimes(2);

      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(built).toHaveBeenCalledTimes(2);

      const workspace = store.readWorkspace();
      if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
      const touched = store.mutateWorkspace(workspace.data.revision, (value) =>
        success(null, null, value),
      );
      if (!touched.ok) throw new Error(touched.error);
      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(built).toHaveBeenCalledTimes(3);

      expect(compactContextFor(root, "lead")).not.toBeNull();
      expect(built).toHaveBeenCalledTimes(3);
    } finally {
      built.mockRestore();
    }
  });
}, 15_000);

test("a document changed within the racy window is never served from cache", () => {
  withRoot((root) => {
    const task = start(root, "lead", "racy document");
    const store = new TaskStore(root);
    writeFileSync(join(root, "doc.md"), "fresh");
    const current = store.readTask(task.id);
    if (!current.ok) throw new Error(current.error);
    const injected = store.mutateTask(task.id, current.data.revision, (record) =>
      success(null, null, {
        ...record,
        decisions: [
          {
            id: "00000000-0000-4000-8000-0000000000d2",
            recordedAt: record.createdAt,
            provenance: record.intent.provenance,
            data: {
              purpose: "design",
              binding: {
                taskId: record.id,
                workspaceId: record.workspaceId,
                scope: scope(),
                presented: "design",
                approvedContent: "design",
                contentRefs: [{ kind: "file", path: "doc.md", digest: sha256("x") }],
              },
              digest: sha256("design"),
              response: "approved",
              requirementIds: [],
              revoked: null,
              consumption: null,
            },
          },
        ],
      }),
    );
    if (!injected.ok) throw new Error(injected.error);
    const built = spyOn(WorkitCore.prototype, "compactContext");
    try {
      compactContextFor(root, "lead");
      compactContextFor(root, "lead");
      expect(built).toHaveBeenCalledTimes(2);
    } finally {
      built.mockRestore();
    }
  });
});

test("a back-dated mtime does not hide a recent change (ctime counts)", () => {
  withRoot((root) => {
    const file = join(root, "copied.md");
    writeFileSync(file, "copied with cp -p");
    utimesSync(file, new Date(0), new Date(Date.now() - 60_000));
    expect(racySignature(fileSignature(file)!)).toBe(true);
  });
});
