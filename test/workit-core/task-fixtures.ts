import type {
  Caller,
  OperationRequest,
  Scope,
  Assessment,
  Ref,
  TaskStartRequest,
} from "../../packages/workit-core/src/core/task-contract";

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

export const operationCorpus = (): Array<{ family: "task"; input: OperationRequest }> => [
  { family: "task", input: taskStartRequest() },
  {
    family: "task",
    input: { schemaVersion: 1, action: "list" } as OperationRequest,
  },
];

export { id, digest };
