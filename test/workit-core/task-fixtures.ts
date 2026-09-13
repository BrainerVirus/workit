import type {
  Caller,
  OperationRequest,
  Scope,
  Assessment,
  OperationFamily,
  Ref,
  TaskStartRequest,
} from "@/packages/workit-core/src/core/task-contract";

const id = "00000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);

export const scope = (overrides: Partial<Scope> = {}): Scope => ({
  description: "the checkout",
  paths: ["."],
  exclusions: [],
  ...overrides,
});

export const ref = (overrides: Partial<Ref> = {}): Ref =>
  ({
    kind: "external",
    url: "https://example.test/reference",
    ...overrides,
  }) as Ref;

export const caller = (overrides: Partial<Caller> = {}): Caller => ({
  host: "workit_cli",
  actor: "test",
  ...overrides,
});

export const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  facts: [],
  signals: {
    approachUnknown: { value: "unknown", basis: "unknown", reason: "not assessed", refs: [] },
    productChoiceOpen: { value: "unknown", basis: "unknown", reason: "not assessed", refs: [] },
    behaviorChange: { value: false, basis: "inferred", reason: "fixture", refs: [] },
    mechanicalLowRisk: { value: true, basis: "inferred", reason: "fixture", refs: [] },
    durableAgreementNeeded: { value: false, basis: "inferred", reason: "fixture", refs: [] },
    coordinationPlanNeeded: { value: false, basis: "inferred", reason: "fixture", refs: [] },
    helperUseful: { value: false, basis: "inferred", reason: "fixture", refs: [] },
    testFirstPractical: { value: true, basis: "inferred", reason: "fixture", refs: [] },
  },
  consequences: [],
  verification: [],
  ...overrides,
});

export const taskStartRequest = (overrides: Partial<TaskStartRequest> = {}): TaskStartRequest => ({
  schemaVersion: 1,
  action: "start",
  expectedWorkspaceRevision: null,
  intent: {
    objective: "test task",
    scope: scope(),
    authorityRefs: [ref()],
  },
  ...overrides,
});

const taskId = id;
const revision = id;
const operation = (action: string, fields: Record<string, unknown> = {}) =>
  ({ schemaVersion: 1, action, ...fields }) as OperationRequest;
const evidence = {
  kind: "check",
  claim: "x",
  requirementIds: [digest],
  beforeCandidateId: null,
  candidateId: null,
  result: "passed",
  summary: "x",
  refs: [],
  exitCode: 0,
  reviewContext: null,
};
const binding = {
  taskId,
  workspaceId: id,
  scope: scope(),
  presented: "yes",
  approvedContent: "yes",
  contentRefs: [],
};
const workerReport = { outcome: "completed", summary: "x", evidenceIds: [], findingIds: [] };
const provenance = {
  kind: "host_observed",
  host: "workit_cli",
  session: null,
  workerId: null,
  receipts: [],
};
const task = {
  schemaVersion: 1,
  id: taskId,
  workspaceId: id,
  revision,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  origin: null,
  intent: { id, recordedAt: "2026-01-01T00:00:00Z", provenance, data: taskStartRequest().intent },
  constraints: [],
  status: "active",
  closure: null,
  progress: { summary: "x", nextAction: null, blockers: [] },
  assessments: [],
  policy: null,
  policyChanges: [],
  candidates: [],
  evidence: [],
  decisions: [],
  findings: [],
  workers: [],
};

export const operationCorpus = (): Array<{ family: OperationFamily; input: OperationRequest }> => [
  ...[
    taskStartRequest(),
    operation("list"),
    operation("inspect", { taskId, view: "summary" }),
    operation("revise", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      intent: taskStartRequest().intent,
      reason: "x",
    }),
    operation("progress", {
      taskId,
      expectedRevision: revision,
      progress: { summary: "x", nextAction: null, blockers: [] },
    }),
    operation("pause", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      reason: "x",
    }),
    operation("resume", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      authorityRefs: [],
    }),
    operation("close", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      outcome: "stopped",
      summary: "x",
      decisionIds: [],
    }),
  ].map((input) => ({ family: "task" as const, input })),
  ...[
    operation("assess", { taskId, expectedRevision: revision, assessment: assessment() }),
    operation("preview", { taskId, assessment: assessment() }),
    operation("explain", { taskId }),
  ].map((input) => ({ family: "policy" as const, input })),
  {
    family: "evidence",
    input: operation("record", { taskId, expectedRevision: revision, evidence }),
  },
  ...[
    operation("record", {
      taskId,
      expectedRevision: revision,
      claim: "x",
      consequence: "x",
      scope: scope(),
      candidateId: null,
      refs: [],
    }),
    operation("resolve", {
      taskId,
      expectedRevision: revision,
      findingId: id,
      disposition: "dismissed",
      reason: "x",
      evidenceIds: [],
      decisionIds: [],
    }),
  ].map((input) => ({ family: "finding" as const, input })),
  ...[
    operation("record", {
      taskId,
      expectedRevision: revision,
      purpose: "design",
      binding,
      response: "approved",
      requirementIds: [digest],
    }),
    operation("revoke", { taskId, expectedRevision: revision, decisionId: id, reason: "x" }),
  ].map((input) => ({ family: "decision" as const, input })),
  ...[
    operation("assign", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      assignment: {
        role: "investigator",
        objective: "x",
        scope: scope(),
        decisionIds: [],
        requirementIds: [],
        candidateId: null,
        stoppingCondition: "x",
      },
    }),
    operation("report", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      workerId: id,
      report: workerReport,
    }),
    operation("cancel", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      workerId: id,
      reason: "x",
    }),
  ].map((input) => ({ family: "worker" as const, input })),
  ...[
    operation("acquire", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      workerId: null,
    }),
    operation("release", {
      taskId,
      expectedRevision: revision,
      expectedWorkspaceRevision: revision,
      reason: "x",
    }),
  ].map((input) => ({ family: "writer" as const, input })),
  ...[
    operation("export", { taskId }),
    operation("import", {
      expectedWorkspaceRevision: null,
      bundle: {
        schemaVersion: 1,
        exportedAt: "2026-01-01T00:00:00Z",
        sourceWorkspaceId: id,
        task,
        digest,
      },
      authorityRefs: [],
    }),
    operation("recover", {
      taskId,
      expectedWorkspaceRevision: revision,
      target: "task",
      expectedBytes: digest,
      snapshotDigest: digest,
      reason: "x",
      authorityRefs: [],
    }),
  ].map((input) => ({ family: "state" as const, input })),
];

export { id, digest };
