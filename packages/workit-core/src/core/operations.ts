// The operation request schemas agents send (task, policy, evidence, finding,
// decision, worker, state). Built at load, so they live apart from the record
// schemas in task-contract.ts: hooks read records and never parse operations.
import * as z from "./zod-mini";
import {
  SCHEMA_VERSION,
  assignmentSchema,
  decisionSchema,
  digest,
  exportBundleSchema,
  failure,
  id,
  idRef,
  intentSchema,
  nullableDigest,
  outcomeSchema,
  progressSchema,
  refSchema,
  reportedEvidenceSchema,
  revision,
  scopeSchema,
  success,
  text,
  workerReportSchema,
  type OperationFamily,
  type Result,
} from "./task-contract";

const base = { schemaVersion: z.literal(1) };
const revisions = {
  expectedRevision: z.optional(revision),
  expectedWorkspaceRevision: z.optional(revision),
};
// Omitted revisions default to the current records inside the engine; explicit
// values are still CAS-enforced. This keeps single-call flows friction-free
// without weakening concurrent-write protection.
const taskId = { taskId: id };
const operation = <T extends z.core.$ZodLooseShape>(shape: T) =>
  z.strictObject({ ...base, ...shape });
const taskOperations = {
  start: operation({
    action: z.literal("start"),
    expectedWorkspaceRevision: z.optional(z.nullable(revision)),
    intent: intentSchema,
  }),
  list: operation({
    action: z.literal("list"),
    status: z.optional(z.enum(["open", "closed", "all"])),
    query: z.optional(z.string().check(z.trim()).check(z.minLength(1)).check(z.maxLength(200))),
    limit: z.optional(z.number().check(z.int()).check(z.gte(1)).check(z.lte(50))),
  }),
  inspect: operation({
    action: z.literal("inspect"),
    ...taskId,
    view: z.optional(z.enum(["summary", "full"])),
  }),
  revise: operation({
    action: z.literal("revise"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
    intent: intentSchema,
    reason: text,
  }),
  progress: operation({
    action: z.literal("progress"),
    ...taskId,
    expectedRevision: z.optional(revision),
    progress: progressSchema,
  }),
  pause: operation({
    action: z.literal("pause"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
    reason: text,
  }),
  resume: operation({
    action: z.literal("resume"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
  }),
  close: operation({
    action: z.literal("close"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
    outcome: outcomeSchema,
    summary: text,
    decisionIds: z.optional(z.array(id)),
  }),
};
/** Judgment values as sent; core/policy/judgment.ts maps aliases and validates. */
const rawJudgment = z.record(z.string(), z.unknown());
const policyOperations = {
  assess: operation({
    action: z.literal("assess"),
    ...taskId,
    expectedRevision: z.optional(revision),
    judgment: rawJudgment,
  }),
  preview: operation({ action: z.literal("preview"), ...taskId, judgment: rawJudgment }),
  explain: operation({ action: z.literal("explain"), ...taskId }),
};
const evidenceOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: z.optional(revision),
    evidence: reportedEvidenceSchema,
  }),
};
const findingOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: z.optional(revision),
    claim: text,
    consequence: text,
    scope: scopeSchema,
    candidateId: z.optional(nullableDigest),
    refs: z.array(refSchema),
  }),
  resolve: operation({
    action: z.literal("resolve"),
    ...taskId,
    expectedRevision: z.optional(revision),
    findingId: idRef,
    disposition: z.enum(["open", "fixed", "dismissed", "deferred"]),
    reason: text,
    evidenceIds: z.array(id),
    decisionIds: z.array(id),
  }),
};
const decisionOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: z.optional(revision),
    purpose: decisionSchema.shape.purpose,
    // The engine binds the decision to the task and workspace it records on.
    binding: z.extend(decisionSchema.shape.binding, {
      taskId: z.optional(id),
      workspaceId: z.optional(id),
    }),
    response: decisionSchema.shape.response,
    requirementIds: z.array(digest),
  }),
  revoke: operation({
    action: z.literal("revoke"),
    ...taskId,
    expectedRevision: z.optional(revision),
    decisionId: id,
    reason: text,
  }),
};
const workerOperations = {
  assign: operation({
    action: z.literal("assign"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
    assignment: assignmentSchema,
  }),
  report: operation({
    action: z.literal("report"),
    ...taskId,
    expectedRevision: z.optional(revision),
    expectedWorkspaceRevision: z.optional(revision),
    workerId: idRef,
    report: workerReportSchema,
  }),
  cancel: operation({
    action: z.literal("cancel"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: z.optional(revision),
    workerId: idRef,
    reason: text,
  }),
};
const stateOperations = {
  export: operation({ action: z.literal("export"), ...taskId }),
  import: operation({
    action: z.literal("import"),
    expectedWorkspaceRevision: z.optional(z.nullable(revision)),
    bundle: exportBundleSchema,
  }),
};

export const operationSchemas = {
  task: z.discriminatedUnion("action", Object.values(taskOperations) as any),
  policy: z.discriminatedUnion("action", Object.values(policyOperations) as any),
  evidence: z.discriminatedUnion("action", Object.values(evidenceOperations) as any),
  finding: z.discriminatedUnion("action", Object.values(findingOperations) as any),
  decision: z.discriminatedUnion("action", Object.values(decisionOperations) as any),
  worker: z.discriminatedUnion("action", Object.values(workerOperations) as any),
  state: z.discriminatedUnion("action", Object.values(stateOperations) as any),
} as const;
export type OperationRequest = z.infer<(typeof operationSchemas)[OperationFamily]>;
/** Every action of each family, in contract order: the one action table. */
export const OPERATION_ACTIONS: Record<OperationFamily, readonly string[]> = {
  task: Object.keys(taskOperations),
  policy: Object.keys(policyOperations),
  evidence: Object.keys(evidenceOperations),
  finding: Object.keys(findingOperations),
  decision: Object.keys(decisionOperations),
  worker: Object.keys(workerOperations),
  state: Object.keys(stateOperations),
};

/**
 * Schemas advertised to hosts. Every `taskId` is optional there: an operation
 * without one applies to the implicit task of the caller's branch (D3); the
 * engine fills it in before parsing against `operationSchemas`.
 */
const withImplicitTask = (options: Record<string, z.ZodMiniObject>) =>
  Object.values(options).map((option) =>
    "taskId" in option.shape ? z.extend(option, { taskId: z.optional(id) }) : option,
  );
const advertised = (options: Record<string, z.ZodMiniObject>) =>
  z.discriminatedUnion("action", withImplicitTask(options) as any);
export const advertisedOperationSchemas = {
  task: advertised(taskOperations),
  policy: advertised(policyOperations),
  evidence: advertised(evidenceOperations),
  finding: advertised(findingOperations),
  decision: advertised(decisionOperations),
  worker: advertised(workerOperations),
  state: advertised(stateOperations),
} as const;
export type TaskStartRequest = z.infer<typeof taskOperations.start>;

export function parseOperation(family: OperationFamily, input: unknown): Result<OperationRequest> {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  )
    return failure("unsupported_version", "unsupported schema version", { operation: family });
  const parsed = operationSchemas[family].safeParse(input);
  if (parsed.success) return success(null, null, parsed.data);
  const fields = parsed.error.issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
    reason: issue.message,
  }));
  return failure("invalid_input", "operation input is invalid", { fields });
}
