import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import {
  TaskStore,
  WorkitCore,
  rewriteRecordRefs,
  success,
  type NativeWorkerVerifier,
  type OperationContext,
  type Ref,
  type TaskView,
} from "@/packages/workit-core/src/core";
import { refSchema, taskRecordSchema } from "@/packages/workit-core/src/core/task-contract";
import { caller, scope, taskStartRequest } from "./task-fixtures";

const now = "2026-01-01T00:00:00Z";

const context = (root: string, options: Partial<OperationContext> = {}): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now,
  ...options,
});

const active = (options: Partial<OperationContext> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "workit-revport-"));
  writeFileSync(join(root, "a.ts"), "before");
  const store = new TaskStore(root);
  const core = new WorkitCore(store, context(root, options));
  const started = core.task(taskStartRequest());
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("active state missing");
  return { root, store, core, task: task.data, workspace: workspace.data };
};

test("the expectedTaskRevision alias is gone", () => {
  const value = active();
  try {
    const workspace = value.store.readWorkspace();
    if (!workspace.ok || !workspace.data) throw new Error("workspace missing");
    const result = value.store.mutateTaskAndWorkspace({
      taskId: value.task.id,
      expectedTaskRevision: value.task.revision,
      expectedWorkspaceRevision: workspace.data.revision,
      task: (current: unknown) => success(null, null, current as never),
      workspace: (current: unknown, mutation: { revision: string }) =>
        success(mutation.revision, mutation.revision, current as never),
    } as never);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

const observationVerifier = (): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller: actualCaller }) =>
    success(null, null, {
      kind: "host_observed",
      host: actualCaller.host,
      session: expected.session,
      workerId: expected.workerId,
      receipts: [{ kind: "host", host: actualCaller.host, handle: "native-event" }],
    }),
});

const viewOf = (value: ReturnType<typeof active>) => {
  const inspected = value.core.task({
    schemaVersion: 1,
    action: "inspect",
    taskId: value.task.id,
    view: "full",
  });
  if (!inspected.ok) throw new Error(inspected.error);
  return inspected.data as TaskView;
};

test("reconcile anchors observations on fresh reads, not the passed view", () => {
  const value = active({ nativeWorker: observationVerifier() });
  try {
    const workerId = randomUUID();
    const worker = {
      id: workerId,
      recordedAt: value.task.createdAt,
      provenance: value.task.intent.provenance,
      data: {
        assignment: {
          role: "investigator",
          objective: "observe",
          scope: scope(),
          decisionIds: [],
          requirementIds: [],
          candidateId: null,
          stoppingCondition: "report",
        },
        state: "running",
        session: null,
        report: null,
      },
    } as never;
    const staleView = { ...viewOf(value), task: { ...value.task, workers: [worker] } } as TaskView;
    const progressed = value.core.task({
      schemaVersion: 1,
      action: "progress",
      taskId: value.task.id,
      progress: { summary: "moved on", nextAction: null, blockers: [] },
    });
    if (!progressed.ok) throw new Error(progressed.error);
    const fresh = value.store.readTask(value.task.id);
    const freshWorkspace = value.store.readWorkspace();
    if (!fresh.ok || !freshWorkspace.ok || !freshWorkspace.data) throw new Error("state missing");
    const reconciled = value.core.reconcileResume(staleView, [
      {
        taskId: value.task.id,
        workerId,
        expectedRevision: fresh.data.revision,
        expectedWorkspaceRevision: freshWorkspace.data.revision,
        state: "unknown" as const,
        session: null,
        observation: { event: "worker-unknown" },
      },
    ]);
    expect(reconciled).toMatchObject({ ok: true });
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rewriteRecordRefs drops, nulls, and remaps by schema shape", () => {
  const keep = { kind: "file", path: "a.ts", digest: null } as Ref;
  const drop = { kind: "host", host: "opencode", handle: "s" } as Ref;
  const record = {
    kind: "record",
    collection: "evidence",
    id: "00000000-0000-4000-8000-0000000000e1",
  } as Ref;
  const dropIt = (ref: Ref): Ref | null => (ref.kind === "host" ? null : ref);
  expect(rewriteRecordRefs([keep, drop], z.array(refSchema), dropIt)).toEqual([keep]);
  expect(rewriteRecordRefs(drop, refSchema, dropIt)).toBeNull();
  expect(rewriteRecordRefs(keep, refSchema, dropIt)).toEqual(keep);
  expect(
    rewriteRecordRefs({ nested: [record, drop] }, z.object({ nested: z.array(refSchema) }), dropIt),
  ).toEqual({ nested: [record] });
  const rename = (ref: Ref): Ref | null =>
    ref.kind === "record" ? { ...ref, id: "00000000-0000-4000-8000-0000000000e2" } : ref;
  expect(rewriteRecordRefs([record], z.array(refSchema), rename)).toEqual([
    { kind: "record", collection: "evidence", id: "00000000-0000-4000-8000-0000000000e2" },
  ]);
  expect(refSchema.safeParse(keep).success).toBe(true);
});

test("exported bundles carry no host sessions, receipts, or unmapped refs", () => {
  const value = active();
  try {
    const reviewer = new WorkitCore(value.store, {
      ...context(value.root),
      caller: caller({ actor: "reviewer" }),
    });
    const assessed = value.core.policy({
      schemaVersion: 1,
      action: "assess",
      taskId: value.task.id,
      assessment: {
        facts: [],
        signals: {
          approachUnknown: { value: false, basis: "inferred", reason: "k", refs: [] },
          productChoiceOpen: { value: false, basis: "inferred", reason: "k", refs: [] },
          behaviorChange: {
            value: true,
            basis: "observed",
            reason: "b",
            refs: [{ kind: "external", url: "https://example.test/x" }],
          },
          mechanicalLowRisk: { value: false, basis: "inferred", reason: "k", refs: [] },
          durableAgreementNeeded: { value: false, basis: "inferred", reason: "k", refs: [] },
          coordinationPlanNeeded: { value: false, basis: "inferred", reason: "k", refs: [] },
          helperUseful: { value: false, basis: "inferred", reason: "k", refs: [] },
          testFirstPractical: { value: false, basis: "inferred", reason: "k", refs: [] },
        },
        consequences: [],
        verification: [],
      },
    });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error(assessed.error);
    const task = value.store.readTask(value.task.id);
    if (!task.ok || !task.data.policy) throw new Error("policy missing");
    const reviewRequirement = task.data.policy.requirements.find(
      (item) => item.dimension === "review",
    )!;
    const recorded = reviewer.evidence({
      schemaVersion: 1,
      action: "record",
      taskId: value.task.id,
      evidence: {
        kind: "review",
        claim: "review",
        requirementIds: [reviewRequirement.id],
        result: "passed",
        summary: "review passed",
        refs: [{ kind: "external", url: "https://example.test/x" }],
        exitCode: 0,
        reviewContext: { kind: "host", host: "workit_cli", handle: "reviewer" },
      },
    });
    expect(recorded.ok).toBe(true);
    const exported = value.core.state({
      schemaVersion: 1,
      action: "export",
      taskId: value.task.id,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error(exported.error);
    const bundle = (exported.data as { task: unknown }).task;
    expect(taskRecordSchema.safeParse(bundle).success).toBe(true);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("reviewer");
    const scan = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) scan(item);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.kind === "host") throw new Error(`host ref leaked: ${JSON.stringify(node)}`);
      if (record.kind === "record" && typeof record.id === "string" && record.id.length === 0)
        throw new Error("empty record id");
      for (const value of Object.values(record)) scan(value);
    };
    scan(bundle);
    const receipts: unknown[] = [];
    const sessions: unknown[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.receipts)) receipts.push(...record.receipts);
      if (record.session !== undefined) sessions.push(record.session);
      for (const value of Object.values(record)) collect(value);
    };
    collect(bundle);
    expect(receipts).toEqual([]);
    expect(sessions.every((session) => session === null)).toBe(true);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
