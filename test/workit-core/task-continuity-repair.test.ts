import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskStore,
  WorkitCore,
  compactTaskContext,
  decisionDigest,
  reconcileResume,
  sha256,
  success,
  type NativeWorkerVerifier,
  type NativeAuthorityVerifier,
  type OperationContext,
  type ExportBundle,
  type Ref,
  type TaskView,
} from "@/packages/workit-core/src/core";
import { captureCandidate } from "@/packages/workit-core/src/core/task-evaluation";
import { assessment, caller, ref, scope, taskStartRequest } from "./task-fixtures";

const makeRoot = () => mkdtempSync(join(tmpdir(), "workit-continuity-repair-"));
const makeContext = (
  root: string,
  nativeWorker?: NativeWorkerVerifier,
  nativeAuthority?: NativeAuthorityVerifier,
): OperationContext => ({
  root,
  caller: caller(),
  capabilities: [],
  constraints: [],
  now: "2026-01-01T00:00:00Z",
  nativeWorker,
  nativeAuthority,
});
const active = (nativeWorker?: NativeWorkerVerifier) => {
  const root = makeRoot();
  const store = new TaskStore(root);
  const core = new WorkitCore(store, makeContext(root, nativeWorker));
  const started = core.task(taskStartRequest());
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error);
  const task = store.readTask((started.data as { id: string }).id);
  const workspace = store.readWorkspace();
  if (!task.ok || !workspace.ok || !workspace.data) throw new Error("setup failed");
  return { root, store, core, task: task.data, workspace: workspace.data };
};
const viewOf = (value: ReturnType<typeof active>): TaskView => ({
  task: value.task,
  workspace: value.workspace,
  capabilities: [],
  requirements: [],
  evidence: [],
});

test("raw caller-built host provenance cannot authorize resume reconciliation", () => {
  const value = active();
  const workerId = randomUUID();
  const observation = {
    taskId: value.task.id,
    workerId,
    expectedRevision: value.task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
    state: "unknown" as const,
    session: null,
    observation: { event: "forged" },
  };
  const forged = {
    kind: "host_observed" as const,
    host: "workit_cli" as const,
    session: null,
    workerId,
    receipts: [{ kind: "host" as const, host: "workit_cli" as const, handle: "forged" }],
  };
  expect(
    reconcileResume(
      {
        ...viewOf(value),
        task: { ...value.task, workers: [{ id: workerId } as never] },
      } as TaskView,
      [{ observation, authority: forged }],
    ),
  ).toMatchObject({ ok: false, code: "permission_denied" });
});

test("imported resume requires destination assessment, reconciliation, and native approval", () => {
  const source = active();
  const exported = source.core.state({
    schemaVersion: 1,
    action: "export",
    taskId: source.task.id,
  });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const nativeAuthority: NativeAuthorityVerifier = {
    verifyDecision: ({ caller: actualCaller }) =>
      success(null, null, {
        kind: "host_observed",
        host: actualCaller.host,
        session: { kind: "host", host: actualCaller.host, handle: actualCaller.actor },
        workerId: null,
        receipts: [{ kind: "host", host: actualCaller.host, handle: "native-resume" }],
      }),
    verifyAction: () => {
      throw new Error("action authority is not used by resume approval");
    },
  };
  const destinationRoot = makeRoot();
  const destinationStore = new TaskStore(destinationRoot);
  const destination = new WorkitCore(
    destinationStore,
    makeContext(destinationRoot, undefined, nativeAuthority),
  );
  const imported = destination.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: null,
    bundle: exported.data as any,
    authorityRefs: [],
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error(imported.error);
  const destinationTask = destinationStore.readTask((imported.data as { id: string }).id);
  const destinationWorkspace = destinationStore.readWorkspace();
  if (!destinationTask.ok || !destinationWorkspace.ok || !destinationWorkspace.data)
    throw new Error("destination state missing");
  expect(destinationTask.data.policy).toBeNull();
  expect(
    destination.task({
      schemaVersion: 1,
      action: "resume",
      taskId: destinationTask.data.id,
      expectedRevision: destinationTask.data.revision,
      expectedWorkspaceRevision: destinationWorkspace.data.revision,
      authorityRefs: [ref()],
    }),
  ).toMatchObject({ ok: false, code: "needs_input" });
  const assessed = destination.policy({
    schemaVersion: 1,
    action: "assess",
    taskId: destinationTask.data.id,
    expectedRevision: destinationTask.data.revision,
    assessment: assessment({
      signals: {
        approachUnknown: { value: false, basis: "inferred", reason: "known", refs: [] },
        productChoiceOpen: { value: false, basis: "inferred", reason: "known", refs: [] },
        behaviorChange: { value: false, basis: "inferred", reason: "mechanical", refs: [] },
        mechanicalLowRisk: { value: false, basis: "inferred", reason: "not mechanical", refs: [] },
        durableAgreementNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
        coordinationPlanNeeded: { value: false, basis: "inferred", reason: "none", refs: [] },
        helperUseful: { value: false, basis: "inferred", reason: "none", refs: [] },
        testFirstPractical: { value: true, basis: "inferred", reason: "yes", refs: [] },
      },
    }),
  });
  expect(assessed).toMatchObject({ ok: true });
  if (!assessed.ok) throw new Error(assessed.error);
  const afterAssessment = destinationStore.readTask(destinationTask.data.id);
  const afterAssessmentWorkspace = destinationStore.readWorkspace();
  if (!afterAssessment.ok || !afterAssessmentWorkspace.ok || !afterAssessmentWorkspace.data)
    throw new Error("assessed destination state missing");
  expect(
    destination.task({
      schemaVersion: 1,
      action: "resume",
      taskId: afterAssessment.data.id,
      expectedRevision: afterAssessment.data.revision,
      expectedWorkspaceRevision: afterAssessmentWorkspace.data.revision,
      authorityRefs: [ref()],
    }),
  ).toMatchObject({ ok: false });
  const binding = {
    taskId: afterAssessment.data.id,
    workspaceId: afterAssessmentWorkspace.data.id,
    scope: afterAssessment.data.intent.data.scope,
    presented: "resume imported task",
    approvedContent: "resume",
    contentRefs: [],
  };
  const approved = destination.observeDecision(
    {
      schemaVersion: 1,
      action: "record",
      taskId: afterAssessment.data.id,
      expectedRevision: afterAssessment.data.revision,
      purpose: "design",
      binding,
      response: "approved",
      requirementIds: [],
    },
    { kind: "resume-approval" },
  );
  expect(approved).toMatchObject({ ok: true });
  if (!approved.ok) throw new Error(approved.error);
  const currentTask = destinationStore.readTask(afterAssessment.data.id);
  const currentWorkspace = destinationStore.readWorkspace();
  if (!currentTask.ok || !currentWorkspace.ok || !currentWorkspace.data)
    throw new Error("approved destination state missing");
  const view = destination.task({
    schemaVersion: 1,
    action: "inspect",
    taskId: currentTask.data.id,
    view: "full",
  });
  expect(view).toMatchObject({ ok: true });
  if (!view.ok) throw new Error(view.error);
  const reconciled = destination.reconcileResume(view.data as TaskView, []);
  expect(reconciled).toMatchObject({ ok: true });
  const resumed = destination.task({
    schemaVersion: 1,
    action: "resume",
    taskId: currentTask.data.id,
    expectedRevision: currentTask.data.revision,
    expectedWorkspaceRevision: currentWorkspace.data.revision,
    authorityRefs: [{ kind: "record", collection: "decisions", id: approved.data.id }],
  });
  expect(resumed).toMatchObject({ ok: true, data: { status: "active" } });
});

test("export omits candidate environment values", () => {
  const value = active();
  const candidate = captureCandidate(value.root, value.task.intent.data.scope, [
    { name: "TOKEN", value: "TOP_SECRET_VALUE" },
  ]);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) throw new Error(candidate.error);
  const changed = value.store.mutateTask(value.task.id, value.task.revision, (task, mutation) =>
    success(mutation.revision, null, { ...task, candidates: [candidate.data] }),
  );
  expect(changed.ok).toBe(true);
  const exported = value.core.state({ schemaVersion: 1, action: "export", taskId: value.task.id });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  expect(JSON.stringify(exported.data)).not.toContain("TOP_SECRET_VALUE");
});

test("verified unknown observations remain a reconciliation blocker", () => {
  let observedWorker = "";
  const verifier: NativeWorkerVerifier = {
    verifyWorker: ({ expected, caller: actualCaller }) => {
      observedWorker = expected.workerId;
      return success(null, null, {
        kind: "host_observed",
        host: actualCaller.host,
        session: expected.session,
        workerId: expected.workerId,
        receipts: [{ kind: "host", host: actualCaller.host, handle: "native" }],
      });
    },
  };
  const value = active(verifier);
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
  const task = { ...value.task, workers: [worker] } as typeof value.task;
  const view = { ...viewOf(value), task } as TaskView;
  const observation = {
    taskId: task.id,
    workerId,
    expectedRevision: task.revision,
    expectedWorkspaceRevision: value.workspace.revision,
    state: "unknown" as const,
    session: null,
    observation: { event: "worker-unknown" },
  };
  const result = value.core.reconcileResume(view, [observation]);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  expect(observedWorker).toBe(workerId);
  expect(result.data.blockers.map((item) => item.reason)).toContain(
    "worker state requires reconciliation",
  );
});

test("compact context is bounded, redacts approved text, and reports stale evidence gaps", () => {
  const value = active();
  const secret = "APPROVED_SECRET_" + "x".repeat(5000);
  const view = {
    ...viewOf(value),
    task: {
      ...value.task,
      intent: { ...value.task.intent, data: { ...value.task.intent.data, objective: secret } },
      progress: { ...value.task.progress, nextAction: "run checks" },
      decisions: [
        {
          id: randomUUID(),
          recordedAt: value.task.createdAt,
          provenance: value.task.intent.provenance,
          data: {
            purpose: "design",
            binding: {
              taskId: value.task.id,
              workspaceId: value.workspace.id,
              scope: scope(),
              presented: secret,
              approvedContent: secret,
              contentRefs: [],
            },
            digest: sha256(secret),
            response: "approved",
            requirementIds: [],
            revoked: null,
            consumption: null,
          },
        },
      ],
    },
    evidence: [{ evidenceId: "evidence-stale", status: "stale", reason: "changed" }],
    requirements: [],
  } as unknown as TaskView;
  const compact = compactTaskContext(view);
  expect(compact.length).toBeLessThanOrEqual(4096);
  expect(compact).not.toContain(secret);
  expect(compact).toContain("evidence-stale");
  expect(compact.match(/run checks/g)?.length).toBe(1);
});

test("compact context enforces UTF-8 bounds and redacts credential-like text everywhere", () => {
  const value = active();
  const multibyte = "ࠀ".repeat(128);
  const sensitive = "TOKEN=short-secret authorization: Bearer abc";
  const refs = Array.from({ length: 8 }, (_, index) => ({
    kind: "file" as const,
    path: `${sensitive}-${index}-${multibyte}`,
    digest: "a".repeat(64),
  }));
  const view = {
    ...viewOf(value),
    task: {
      ...value.task,
      intent: {
        ...value.task.intent,
        data: { ...value.task.intent.data, objective: `${sensitive} ${multibyte}` },
      },
      progress: {
        ...value.task.progress,
        nextAction: `${sensitive} ${multibyte}`,
        blockers: [{ reason: `${sensitive} ${multibyte}`, dependentAction: "resume", refs }],
      },
      decisions: refs.map((contentRef, index) => ({
        id: randomUUID(),
        recordedAt: value.task.createdAt,
        provenance: value.task.intent.provenance,
        data: {
          purpose: "design" as const,
          binding: {
            taskId: value.task.id,
            workspaceId: value.workspace.id,
            scope: scope(),
            presented: `${sensitive}-${index}`,
            approvedContent: `${sensitive}-${index}`,
            contentRefs: [contentRef],
          },
          digest: sha256(`${sensitive}-${index}`),
          response: "approved" as const,
          requirementIds: [],
          revoked: null,
          consumption: null,
        },
      })),
    },
    evidence: [{ evidenceId: "stale-ࠀ", status: "stale", reason: `${sensitive} ${multibyte}` }],
  } as unknown as TaskView;
  const compact = compactTaskContext(view);
  expect(Buffer.byteLength(compact, "utf8")).toBeLessThanOrEqual(4096);
  expect(compact).not.toContain("short-secret");
  expect(compact).not.toContain("Bearer abc");
  expect(compact.match(/nextAction/g)?.length).toBe(1);
});

test("export omits host and external refs throughout portable history", () => {
  const value = active();
  const evidenceId = randomUUID();
  const hostRefs: Ref[] = [
    { kind: "host", host: "workit_cli", handle: "HOST_SENTINEL_TOKEN" },
    { kind: "external", url: "https://user:EXTERNAL_SENTINEL_TOKEN@example.test/ref" },
  ];
  const fileRef: Ref = { kind: "file", path: "historical.txt", digest: "a".repeat(64) };
  const recordRef: Ref = {
    kind: "record",
    collection: "evidence",
    id: evidenceId,
  };
  const refs = [...hostRefs, fileRef, recordRef];
  const baseAssessment = assessment();
  const assessmentWithRefs = {
    ...baseAssessment,
    facts: [{ statement: "fact", basis: "observed" as const, refs }],
    signals: Object.fromEntries(
      Object.entries(baseAssessment.signals).map(([name, signal]) => [name, { ...signal, refs }]),
    ) as typeof baseAssessment.signals,
    consequences: [
      {
        area: "security" as const,
        fact: { statement: "consequence", basis: "observed" as const, refs },
      },
    ],
    verification: [{ claim: "verify", scope: scope(), availableChecks: refs, gaps: [] }],
  };
  const requirement = {
    kind: "check" as const,
    scope: scope(),
    refs,
    method: null,
    before: "close" as const,
    dependentAction: null,
  };
  const constraint = {
    id: "constraint",
    kind: "host" as const,
    statement: "constraint",
    source: hostRefs[0],
    acceptanceAllowed: false,
    requires: [requirement],
  };
  const evidence = {
    kind: "check" as const,
    claim: "evidence",
    requirementIds: [],
    beforeCandidateId: null,
    candidateId: null,
    result: "passed" as const,
    summary: "evidence",
    refs,
    exitCode: 0,
    reviewContext: hostRefs[0],
  };
  const decisionBase = {
    purpose: "design" as const,
    binding: {
      taskId: value.task.id,
      workspaceId: value.workspace.id,
      scope: scope(),
      presented: "decision",
      approvedContent: "decision",
      contentRefs: refs,
    },
    response: "approved" as const,
    requirementIds: [],
    revoked: null,
    consumption: null,
  };
  const finding = {
    id: randomUUID(),
    recordedAt: value.task.createdAt,
    provenance: value.task.intent.provenance,
    data: {
      claim: "finding",
      consequence: "finding",
      scope: scope(),
      candidateId: null,
      refs,
      disposition: "open" as const,
      resolution: null,
    },
  };
  const changed = value.store.mutateTask(value.task.id, value.task.revision, (task, mutation) =>
    success(mutation.revision, null, {
      ...task,
      intent: { ...task.intent, data: { ...task.intent.data, authorityRefs: refs } },
      constraints: [constraint],
      assessments: [
        {
          id: randomUUID(),
          recordedAt: mutation.now,
          provenance: task.intent.provenance,
          data: assessmentWithRefs,
        },
      ],
      progress: {
        ...task.progress,
        blockers: [{ reason: "blocked", dependentAction: "resume", refs }],
      },
      evidence: [
        {
          id: evidenceId,
          recordedAt: mutation.now,
          provenance: task.intent.provenance,
          data: evidence,
        },
      ],
      decisions: [
        {
          id: randomUUID(),
          recordedAt: mutation.now,
          provenance: task.intent.provenance,
          data: { ...decisionBase, digest: decisionDigest(decisionBase) },
        },
      ],
      findings: [finding],
    }),
  );
  expect(changed.ok).toBe(true);
  const exported = value.core.state({ schemaVersion: 1, action: "export", taskId: value.task.id });
  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  const serialized = JSON.stringify(exported.data);
  expect(serialized).not.toContain("HOST_SENTINEL_TOKEN");
  expect(serialized).not.toContain("EXTERNAL_SENTINEL_TOKEN");
  expect(serialized).toContain("historical.txt");
  expect(serialized).toContain(recordRef.id);
  const destinationRoot = makeRoot();
  const destinationStore = new TaskStore(destinationRoot);
  const destination = new WorkitCore(destinationStore, makeContext(destinationRoot));
  const imported = destination.state({
    schemaVersion: 1,
    action: "import",
    expectedWorkspaceRevision: null,
    bundle: exported.data,
    authorityRefs: [],
  });
  expect(imported).toMatchObject({ ok: true });
  if (!imported.ok) throw new Error(imported.error);
  const importedTask = destinationStore.readTask((imported.data as { id: string }).id);
  expect(importedTask).toMatchObject({ ok: true });
  if (!importedTask.ok) throw new Error(importedTask.error);
  const importedRecord = importedTask.data.intent.data.authorityRefs.find(
    (ref) => ref.kind === "record",
  );
  expect(importedRecord).toMatchObject({ kind: "record" });
  expect(importedRecord && importedRecord.id).not.toBe(evidenceId);
});

test("portable assessment state remains truthful and importable after host refs are removed", () => {
  const value = active();
  const hostRef: Ref = { kind: "host", host: "workit_cli", handle: "HOST_ONLY" };
  const fileRef: Ref = { kind: "file", path: "portable.txt", digest: "b".repeat(64) };
  const base = assessment();
  const assessmentWithHostOnlyState = {
    ...base,
    facts: [
      { statement: "host-only fact", basis: "observed" as const, refs: [hostRef] },
      { statement: "mixed fact", basis: "observed" as const, refs: [hostRef, fileRef] },
    ],
    signals: {
      ...base.signals,
      behaviorChange: {
        value: false,
        basis: "observed" as const,
        reason: "host-only observation",
        refs: [hostRef],
      },
      mechanicalLowRisk: {
        value: true,
        basis: "observed" as const,
        reason: "mixed observation",
        refs: [hostRef, fileRef],
      },
    },
    consequences: [
      {
        area: "security" as const,
        fact: { statement: "host-only consequence", basis: "observed" as const, refs: [hostRef] },
      },
    ],
  };
  const changed = value.store.mutateTask(value.task.id, value.task.revision, (task, mutation) =>
    success(mutation.revision, null, {
      ...task,
      assessments: [
        {
          id: randomUUID(),
          recordedAt: mutation.now,
          provenance: task.intent.provenance,
          data: assessmentWithHostOnlyState,
        },
      ],
    }),
  );
  expect(changed.ok).toBe(true);

  const exported = value.core.state({ schemaVersion: 1, action: "export", taskId: value.task.id });
  expect(exported).toMatchObject({ ok: true });
  if (!exported.ok) throw new Error(exported.error);
  const bundle = exported.data as ExportBundle;
  const portableAssessment = bundle.task.assessments[0].data;
  expect(portableAssessment.facts[0]).toMatchObject({ basis: "unknown", refs: [] });
  expect(portableAssessment.facts[1]).toMatchObject({ basis: "observed", refs: [fileRef] });
  expect(portableAssessment.signals.behaviorChange).toMatchObject({
    value: "unknown",
    basis: "unknown",
    refs: [],
  });
  expect(portableAssessment.signals.behaviorChange.reason).toContain("portable");
  expect(portableAssessment.signals.mechanicalLowRisk).toMatchObject({
    value: true,
    basis: "observed",
    refs: [fileRef],
  });
  expect(portableAssessment.consequences[0].fact).toMatchObject({ basis: "unknown", refs: [] });

  const destinationRoot = makeRoot();
  const destination = new WorkitCore(new TaskStore(destinationRoot), makeContext(destinationRoot));
  expect(
    destination.state({
      schemaVersion: 1,
      action: "import",
      expectedWorkspaceRevision: null,
      bundle,
      authorityRefs: [],
    }),
  ).toMatchObject({ ok: true });
});
