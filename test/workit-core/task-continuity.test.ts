import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  canonicalJson,
  sha256,
  success,
  type OperationContext,
  type TaskView,
} from "@/packages/workit-core/src/core";
import {
  compactTaskContext,
  reconcileResume,
  type ResumeObservation,
} from "@/packages/workit-core/src/core/task-context";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { assertLocalExternalActionWriter } from "@/packages/workit-core/src/core/external-action-effects";
import { caller, ref, scope, taskStartRequest } from "./task-fixtures";

const root = () => mkdtempSync(join(tmpdir(), "workit-continuity-"));
const context = (checkout: string): OperationContext => ({
  root: checkout,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  nativeRecovery: ({ writer }) =>
    success(null, null, {
      state: "accounted_for" as const,
      pid: 0,
      processStart: null,
      ownerDigest: writer ? sha256(canonicalJson(writer)) : null,
    }),
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
      session: { kind: "host" as const, host: "workit_cli" as const, handle: "credential" },
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
    authorityRefs: [],
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
      authorityRefs: [ref()],
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
    authorityRefs: [],
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
    authorityRefs: [],
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

test("portable action history keeps old IDs and outcomes without importing authority", () => {
  const source = started();
  const actionId = `external:${"b".repeat(32)}`;
  const actionDecision = (state: "reserved" | "consumed") => ({
    id: randomUUID(),
    recordedAt: "2026-01-01T00:00:00Z",
    provenance: source.task.intent.provenance,
    data: {
      purpose: "action" as const,
      binding: {
        taskId: source.task.id,
        workspaceId: source.workspace.id,
        scope: scope(),
        presented: "Create the approved pull request",
        approvedContent: "hosting.pull_request",
        contentRefs: [],
      },
      digest: "a".repeat(64),
      response: "approved" as const,
      requirementIds: [],
      revoked: null,
      consumption: {
        state,
        at: "2026-01-01T00:00:00Z",
        actionRef: { kind: "host" as const, host: "opencode" as const, handle: actionId },
      },
    },
  });
  const decisions = [actionDecision("reserved"), actionDecision("consumed")];
  const changed = source.store.mutateTask(source.task.id, source.task.revision, (task, mutation) =>
    success(mutation.revision, null, { ...task, decisions }),
  );
  expect(changed.ok).toBe(true);

  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const bundle = exported.data as any;
  expect(bundle.task.decisions.map((entry: any) => entry.data.consumption)).toEqual([
    {
      state: "uncertain",
      at: "2026-01-01T00:00:00Z",
      actionRef: {
        kind: "record",
        collection: "decisions",
        id: decisions[0].id,
      },
      historicalActionId: actionId,
    },
    {
      state: "consumed",
      at: "2026-01-01T00:00:00Z",
      actionRef: {
        kind: "record",
        collection: "decisions",
        id: decisions[1].id,
      },
      historicalActionId: actionId,
    },
  ]);

  const destinationCheckout = root();
  const destinationStore = new TaskStore(destinationCheckout);
  const destinationCore = new WorkitCore(destinationStore, context(destinationCheckout));
  const imported = destinationCore.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: null,
    bundle,
    authorityRefs: [],
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.error);
  const task = destinationStore.readTask((imported.data as { id: string }).id);
  expect(task.ok).toBe(true);
  if (!task.ok) throw new Error(task.error);
  expect(task.data.decisions.map((entry) => entry.data.consumption)).toEqual(
    bundle.task.decisions.map((entry: any, index: number) =>
      Object.assign(entry.data.consumption, {
        actionRef: {
          kind: "record",
          collection: "decisions",
          id: task.data.decisions[index].id,
        },
      }),
    ),
  );
  expect(task.data.decisions.every((entry) => entry.provenance.kind === "imported")).toBe(true);
});

test("stale workspace revisions fence managed effects after writer handoff", () => {
  const value = started();
  const acquired = value.core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId: value.task.id,
    expectedRevision: value.task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error(acquired.error);
  const oldFence = acquired.data.revision;

  const task = value.store.readTask(value.task.id);
  const workspace = value.store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("writer state missing");
  const released = value.core.writer({
    schemaVersion: 1,
    action: "release",
    taskId: task.data.id,
    expectedRevision: task.data.revision,
    expectedWorkspaceRevision: workspace.data.revision,
  });
  expect(released.ok).toBe(true);
  if (!released.ok) throw new Error(released.error);

  const releasedTask = value.store.readTask(value.task.id);
  const releasedWorkspace = value.store.readWorkspace();
  if (!releasedTask.ok || !releasedWorkspace.ok || !releasedWorkspace.data)
    throw new Error("released state missing");
  const reacquired = value.core.writer({
    schemaVersion: 1,
    action: "acquire",
    taskId: releasedTask.data.id,
    expectedRevision: releasedTask.data.revision,
    expectedWorkspaceRevision: releasedWorkspace.data.revision,
  });
  expect(reacquired.ok).toBe(true);
  if (!reacquired.ok || !reacquired.data.writer) throw new Error("writer reacquisition failed");

  const currentCaller = {
    host: reacquired.data.writer.owner.session.host,
    actor: reacquired.data.writer.owner.session.handle,
  };
  expect(
    assertLocalExternalActionWriter(value.checkout, currentCaller, ["."], oldFence),
  ).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(
    assertLocalExternalActionWriter(value.checkout, currentCaller, ["."], reacquired.data.revision)
      .ok,
  ).toBe(true);
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
      receipts: [],
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
      policy: { policyVersion: "9.9.9", inputDigest: "a".repeat(64), requirements: [] },
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
  expect(result).toMatchObject({ ok: true, data: { reassessmentRequired: true } });
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

test("corrupt-byte recovery keeps damaged bytes, invalidates old revisions, and never restores a writer", () => {
  const value = started();
  const changed = value.store.mutateTask(value.task.id, value.task.revision, (task, mutation) =>
    success(mutation.revision, null, task),
  );
  expect(changed.ok).toBe(true);
  const candidates = value.store.recoveryCandidates();
  expect(candidates.ok).toBe(true);
  if (!candidates.ok) throw new Error(candidates.error);
  const candidate = candidates.data.find((item) => item.target === "task");
  if (!candidate) throw new Error("missing recovery snapshot");
  const taskFile = join(value.checkout, ".workit", "tasks", `${value.task.id}.json`);
  writeFileSync(taskFile, "{broken");
  const recovered = value.core.state({
    schemaVersion: 1,
    action: "recover",
    taskId: value.task.id,
    expectedWorkspaceRevision: value.workspace.revision,
    target: "task",
    expectedBytes: sha256("{broken"),
    snapshotDigest: candidate.digest,
    reason: "crash recovery",
    authorityRefs: [],
  });
  expect(recovered).toMatchObject({ ok: true });
  expect(readFileSync(taskFile, "utf8")).not.toBe("{broken");
  expect(
    value.store.mutateTask(value.task.id, value.task.revision, (task) => success(null, null, task)),
  ).toMatchObject({
    ok: false,
    code: "revision_conflict",
  });
});

test("workspace recovery clears a previously held writer and closed task recovery stays closed", () => {
  const value = started();
  const held = value.store.mutateWorkspace(value.workspace.revision, (workspace, mutation) =>
    success(mutation.revision, mutation.revision, {
      ...workspace,
      writer: {
        state: "held" as const,
        owner: {
          taskId: value.task.id,
          workerId: null,
          session: { kind: "host" as const, host: "workit_cli" as const, handle: "session" },
        },
        acquiredAt: mutation.now,
      },
    }),
  );
  expect(held.ok).toBe(true);
  const heldWorkspaceBefore = value.store.readWorkspace();
  if (!heldWorkspaceBefore.ok || !heldWorkspaceBefore.data)
    throw new Error("held workspace missing");
  const heldAgain = value.store.mutateWorkspace(
    heldWorkspaceBefore.data.revision,
    (workspace, mutation) => success(mutation.revision, mutation.revision, workspace),
  );
  expect(heldAgain.ok).toBe(true);
  const heldWorkspace = value.store.readWorkspace();
  if (!heldWorkspace.ok || !heldWorkspace.data) throw new Error("held workspace missing");
  const workspaceCandidates = value.store.recoveryCandidates();
  if (!workspaceCandidates.ok) throw new Error(workspaceCandidates.error);
  const workspaceCandidate = workspaceCandidates.data.find((item) => {
    if (item.target !== "workspace") return false;
    try {
      return JSON.parse(readFileSync(item.path, "utf8")).writer?.state === "held";
    } catch {
      return false;
    }
  });
  if (!workspaceCandidate) throw new Error("missing workspace recovery snapshot");
  const workspaceFile = join(value.checkout, ".workit", "workspace.json");
  writeFileSync(workspaceFile, "{broken");
  const recoveredWorkspace = value.core.state({
    schemaVersion: 1,
    action: "recover",
    taskId: value.task.id,
    expectedWorkspaceRevision: heldWorkspace.data.revision,
    target: "workspace",
    expectedBytes: sha256("{broken"),
    snapshotDigest: workspaceCandidate.digest,
    reason: "clear writer",
    authorityRefs: [],
  });
  expect(recoveredWorkspace).toMatchObject({ ok: true, data: { writer: null } });

  const currentTask = value.store.readTask(value.task.id);
  const currentWorkspace = value.store.readWorkspace();
  if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("state missing");
  const closed = value.core.task({
    schemaVersion: 1,
    action: "close",
    taskId: currentTask.data.id,
    expectedRevision: currentTask.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
    outcome: "stopped",
    summary: "closed",
    decisionIds: [],
  });
  expect(closed.ok).toBe(true);
  const closedTask = value.store.readTask(value.task.id);
  if (!closedTask.ok) throw new Error(closedTask.error);
  const closedMutation = value.store.mutateTask(
    value.task.id,
    closedTask.data.revision,
    (task, mutation) => success(mutation.revision, null, task),
  );
  expect(closedMutation.ok).toBe(true);
  const recoveryWorkspace = value.store.readWorkspace();
  if (!recoveryWorkspace.ok || !recoveryWorkspace.data) throw new Error("workspace missing");
  const closedCandidates = value.store.recoveryCandidates();
  if (!closedCandidates.ok) throw new Error(closedCandidates.error);
  const closedCandidate = closedCandidates.data.find((item) => {
    if (item.target !== "task") return false;
    try {
      return JSON.parse(readFileSync(item.path, "utf8")).status === "closed";
    } catch {
      return false;
    }
  });
  if (!closedCandidate) throw new Error("missing closed recovery snapshot");
  writeFileSync(join(value.checkout, ".workit", "tasks", `${value.task.id}.json`), "{broken");
  const recoveredTask = value.core.state({
    schemaVersion: 1,
    action: "recover",
    taskId: value.task.id,
    expectedWorkspaceRevision: recoveryWorkspace.data.revision,
    target: "task",
    expectedBytes: sha256("{broken"),
    snapshotDigest: closedCandidate.digest,
    reason: "retain closed history",
    authorityRefs: [],
  });
  expect(recoveredTask).toMatchObject({ ok: true, data: { status: "closed" } });
  expect(closedTask.data.status).toBe("closed");
});

test("state import rejects records that are not v1 export bundles", () => {
  const value = started();
  expect(
    value.core.state({
      schemaVersion: 1,
      action: "import",
      expectedWorkspaceRevision: value.workspace.revision,
      bundle: { legacy: true },
      authorityRefs: [],
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
              approvedContent: decisionText,
              contentRefs: [],
            },
            digest: "a".repeat(64),
            response: "approved" as const,
            requirementIds: [],
            revoked: null,
            consumption: null,
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
  expect(parsed).toMatchObject({ nextAction: "run checks", gaps: ["missing check"] });
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
