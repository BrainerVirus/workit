import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore } from "@/packages/workit-core/src/core";
import * as evaluation from "@/packages/workit-core/src/core/task-evaluation";
import { compactContextFor, unfinishedTaskOfferFor } from "@/packages/workit-opencode/src/runtime";
import { scope, taskStartRequest } from "@/test/workit-core/task-fixtures";

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
