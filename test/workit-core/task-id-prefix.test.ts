import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, WorkitCore, type OperationContext } from "@/packages/workit-core/src/core";
import { resolveIdRef } from "@/packages/workit-core/src/core/task-contract";
import { caller, ref, scope, taskStartRequest } from "./task-fixtures";

const context = (root: string): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const recordFinding = (core: WorkitCore, taskId: string, expectedRevision: string) => {
  const recorded = core.finding({
    schemaVersion: 1,
    action: "record",
    taskId,
    expectedRevision,
    claim: "regression risk",
    consequence: "unsafe change",
    scope: scope({ paths: ["."] }),
    candidateId: null,
    refs: [ref()],
  });
  if (!recorded.ok) throw new Error(recorded.error);
  return recorded.data as { id: string };
};

const resolveWith = (core: WorkitCore, taskId: string, revision: string, findingId: string) =>
  core.finding({
    schemaVersion: 1,
    action: "resolve",
    taskId,
    expectedRevision: revision,
    findingId,
    disposition: "open",
    reason: "not an issue",
    evidenceIds: [],
    decisionIds: [],
  });

test("resolveIdRef prefers an exact id, resolves a unique prefix and lists ambiguous candidates", () => {
  const ids = ["aaaaaaaa", "aaaaaaaa-1", "aaaaaaaa-2", "bbbbbbbb-1"];
  expect(resolveIdRef("finding", "aaaaaaaa", ids)).toMatchObject({ ok: true, data: "aaaaaaaa" });
  expect(resolveIdRef("finding", "bbbbbbbb", ids)).toMatchObject({
    ok: true,
    data: "bbbbbbbb-1",
  });
  expect(resolveIdRef("finding", "aaaaaaaa-2", ids)).toMatchObject({
    ok: true,
    data: "aaaaaaaa-2",
  });
  expect(resolveIdRef("finding", "cccccccc", ids)).toMatchObject({
    ok: false,
    code: "not_found",
  });
  const ambiguous = resolveIdRef("finding", "aaaaaaaa-", ids);
  expect(ambiguous).toMatchObject({ ok: false, code: "invalid_input" });
  if (ambiguous.ok) throw new Error("expected failure");
  expect(ambiguous.error).toContain("aaaaaaaa-1");
  expect(ambiguous.error).toContain("aaaaaaaa-2");
});

test("finding resolve accepts a unique 8-char prefix and a full id, rejects a non-id", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-finding-prefix-"));
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const taskId = (started.data as any).id as string;
  const revision = () => {
    const task = store.readTask(taskId);
    if (!task.ok) throw new Error(task.error);
    return task.data.revision;
  };
  const first = recordFinding(core, taskId, revision());
  const second = recordFinding(core, taskId, revision());

  expect(resolveWith(core, taskId, revision(), "not-an-id")).toMatchObject({
    ok: false,
    code: "invalid_input",
  });
  expect(resolveWith(core, taskId, revision(), first.id.slice(0, 8))).toMatchObject({
    ok: true,
    data: { id: first.id, data: { disposition: "open" } },
  });
  expect(resolveWith(core, taskId, revision(), second.id)).toMatchObject({
    ok: true,
    data: { id: second.id },
  });
});
