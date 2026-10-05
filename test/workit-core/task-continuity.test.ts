import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  sha256,
  type OperationContext,
  type TaskView,
} from "@/packages/workit-core/src/core";
import {
  compactTaskContext,
  reconcileResume,
  type ResumeObservation,
} from "@/packages/workit-core/src/core/task-context";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { caller, scope, taskStartRequest } from "./task-fixtures";

const root = () => mkdtempSync(join(tmpdir(), "workit-continuity-"));
const context = (checkout: string): OperationContext => ({
  root: checkout,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
});

const started = () => {
  const checkout = root();
  const store = new TaskStore(checkout);
  const core = new WorkitCore(store, context(checkout));
  const result = core.task(taskStartRequest());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const task = store.readTask((result.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("task setup failed");
  return { checkout, store, core, task: task.data, workspace: workspace.data };
};

test("export digest excludes its own digest and never exports live workspace ownership", () => {
  const source = started();
  const writer = {
    state: "held" as const,
    owner: {
      taskId: source.task.id,
      workerId: null,
      session: {
        kind: "host" as const,
        host: "workit_cli" as const,
        handle: "credential",
      },
    },
    acquiredAt: "2026-01-01T00:00:00Z",
  };
  writeFileSync(
    join(source.checkout, ".workit", "workspace.json"),
    `${JSON.stringify({ ...source.workspace, writer })}\n`,
  );
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const bundle = exported.data as any;
  expect(bundle).not.toHaveProperty("workspace");
  expect(JSON.stringify(bundle)).not.toContain("credential");
  expect(bundle.digest).toBe(
    sha256({
      schemaVersion: bundle.schemaVersion,
      exportedAt: bundle.exportedAt,
      sourceWorkspaceId: bundle.sourceWorkspaceId,
      task: bundle.task,
    }),
  );
  expect(bundle.digest).not.toBe(sha256({ ...bundle, digest: bundle.digest }));
});

test("import creates a paused task with fresh destination identity and non-authorizing provenance", () => {
  const source = started();
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const destinationCheckout = root();
  const destinationStore = new TaskStore(destinationCheckout);
  const destinationCore = new WorkitCore(destinationStore, context(destinationCheckout));
  const imported = destinationCore.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: null,
    bundle: exported.data as any,
  });
  expect(imported).toMatchObject({ ok: true, data: { status: "paused" } });
  if (!imported.ok) throw new Error(imported.error);
  const importedData = imported.data as any;
  expect(importedData.id).not.toBe(source.task.id);
  const destinationWorkspace = destinationStore.readWorkspace();
  if (!destinationWorkspace.ok || !destinationWorkspace.data)
    throw new Error("destination workspace missing");
  const importedTask = destinationStore.readTask(importedData.id);
  if (!importedTask.ok) throw new Error(importedTask.error);
  expect(importedTask.data.workspaceId).toBe(destinationWorkspace.data.id);
  expect(importedTask.data.revision).not.toBe(source.task.revision);
  expect(importedTask.data.origin).toEqual({
    workspaceId: source.workspace.id,
    taskId: source.task.id,
    exportDigest: (exported.data as any).digest,
  });
  expect(importedTask.data.closure).toBeNull();
  expect(importedTask.data.intent.provenance.kind).toBe("imported");
  expect(
    destinationCore.task({
      schemaVersion: 1,
      action: "resume",
      taskId: importedData.id,
      expectedRevision: importedData.revision,
      expectedWorkspaceRevision: importedData.workspaceRevision,
    }),
  ).toMatchObject({ ok: false, code: "needs_input" });
});

test("same-store import reuses the source task", () => {
  const source = started();
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const imported = source.core.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: source.workspace.revision,
    bundle: exported.data as any,
  });
  expect(imported).toMatchObject({ ok: true, data: { id: source.task.id } });
  const tasks = source.store.listTasks();
  expect(tasks.ok).toBe(true);
  if (!tasks.ok) throw new Error(tasks.error);
  expect(tasks.data).toHaveLength(1);
});

test("portable import retries reuse one mapping and changed exports require reconciliation", () => {
  const source = started();
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const bundle = exported.data as any;
  const destinationCheckout = root();
  const destinationStore = new TaskStore(destinationCheckout);
  const destinationCore = new WorkitCore(destinationStore, context(destinationCheckout));
  const request = {
    schemaVersion: 1,
    action: "import" as const,
    expectedWorkspaceRevision: null,
    bundle,
  };
  const first = destinationCore.state(request);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error);
  const firstId = (first.data as { id: string }).id;
  const retry = destinationCore.state(request);
  expect(retry).toMatchObject({ ok: true, data: { id: firstId } });

  const changedTask = {
    ...bundle.task,
    progress: { ...bundle.task.progress, summary: "new source revision" },
  };
  const changedBundle = {
    ...bundle,
    task: changedTask,
    digest: sha256({
      schemaVersion: bundle.schemaVersion,
      exportedAt: bundle.exportedAt,
      sourceWorkspaceId: bundle.sourceWorkspaceId,
      task: changedTask,
    }),
  };
  const changed = destinationCore.state({ ...request, bundle: changedBundle });
  expect(changed).toMatchObject({ ok: false, code: "revision_conflict" });
  if (changed.ok) throw new Error("changed source export must require reconciliation");
  expect(changed.details.taskId).toBe(firstId);
  const tasks = destinationStore.listTasks();
  expect(tasks.ok).toBe(true);
  if (!tasks.ok) throw new Error(tasks.error);
  expect(tasks.data.filter((task) => task.origin?.taskId === source.task.id)).toHaveLength(1);
});

test("unknown policy versions require reassessment and resume reports stale evidence and workers", () => {
  const value = started();
  const before = captureCandidate(value.checkout, value.task.intent.data.scope, []);
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error(before.error);
  writeFileSync(join(value.checkout, "changed.txt"), "changed");
  const after = captureCandidate(value.checkout, value.task.intent.data.scope, []);
  expect(after.ok).toBe(true);
  if (!after.ok) throw new Error(after.error);
  const unknownWorker = {
    id: randomUUID(),
    recordedAt: "2026-01-01T00:00:00Z",
    provenance: {
      kind: "host_observed" as const,
      host: "workit_cli" as const,
      session: null,
      workerId: null,
    },
    data: {
      assignment: {
        role: "investigator" as const,
        objective: "inspect",
        scope: scope(),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "report",
      },
      state: "unknown" as const,
      session: null,
      report: null,
    },
  };
  const view = {
    task: {
      ...value.task,
      policy: {
        policyVersion: "9.9.9",
        inputDigest: "a".repeat(64),
        requirements: [],
      },
      candidates: [before.data],
      evidence: [
        {
          id: randomUUID(),
          recordedAt: "2026-01-01T00:00:00Z",
          provenance: value.task.intent.provenance,
          data: {
            kind: "check",
            claim: "check",
            requirementIds: [],
            beforeCandidateId: before.data.id,
            candidateId: before.data.id,
            result: "passed",
            summary: "passed",
            refs: [],
            exitCode: 0,
            reviewContext: null,
          },
        },
      ],
      workers: [unknownWorker],
    },
    workspace: value.workspace,
    capabilities: [],
    requirements: [],
    evidence: [],
  } as unknown as TaskView;
  const result = reconcileResume(view, []);
  expect(result).toMatchObject({
    ok: true,
    data: { reassessmentRequired: true },
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.data.staleEvidenceIds.length).toBeGreaterThan(0);
  expect(result.data.blockers.map((item) => item.reason)).toContain(
    "worker state requires reconciliation",
  );
});

test("resume reconciliation accepts only trusted worker observations", () => {
  const value = started();
  const observation = {
    taskId: value.task.id,
    workerId: randomUUID(),
    expectedRevision: value.task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
    state: "stopped" as const,
    session: null,
    observation: { event: "claimed" },
  };
  const untrusted: ResumeObservation = { observation, authority: null };
  expect(
    reconcileResume(
      {
        task: value.task,
        workspace: value.workspace,
        capabilities: [],
        requirements: [],
        evidence: [],
      },
      [untrusted],
    ),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("state import rejects records that are not v1 export bundles", () => {
  const value = started();
  expect(
    value.core.state({
      schemaVersion: 1,
      action: "import",
      expectedWorkspaceRevision: value.workspace.revision,
      bundle: { legacy: true },
    }),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("compact context contains decisions, gaps, and next action once without transcript history", () => {
  const value = started();
  const decisionText = "choose the small fix";
  const view = {
    task: {
      ...value.task,
      progress: { summary: "summary", nextAction: "run checks", blockers: [] },
      decisions: [
        {
          id: randomUUID(),
          recordedAt: "2026-01-01T00:00:00Z",
          provenance: value.task.intent.provenance,
          data: {
            purpose: "design" as const,
            binding: {
              taskId: value.task.id,
              workspaceId: value.workspace.id,
              scope: scope(),
              presented: decisionText,
              contentRefs: [],
            },
            digest: "a".repeat(64),
            response: "approved" as const,
            requirementIds: [],
            revoked: null,
          },
        },
      ],
    },
    workspace: value.workspace,
    capabilities: [],
    requirements: [
      {
        requirementId: "b".repeat(64),
        status: "unsatisfied",
        evidenceIds: [],
        decisionIds: [],
        reason: "missing check",
      },
    ],
    evidence: [],
  } as unknown as TaskView;
  const compact = compactTaskContext(view);
  const parsed = JSON.parse(compact) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    nextAction: "run checks",
    gaps: ["missing check"],
  });
  expect(parsed.decisions).toEqual([
    {
      id: expect.any(String),
      purpose: "design",
      status: "approved",
      digest: "a".repeat(64),
      choice: decisionText,
      references: [],
    },
  ]);
  expect(compact).not.toContain("transcript");
  expect(compact).toContain(decisionText);
  expect(compact.match(/run checks/g)?.length).toBe(1);
});
