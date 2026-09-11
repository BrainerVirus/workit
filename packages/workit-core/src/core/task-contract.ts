import { createHash, randomUUID } from "node:crypto";
import * as z from "zod";

export const SCHEMA_VERSION = 1 as const;
export const POLICY_VERSION = "1.0.0" as const;
export const OPERATION_FAMILIES = [
  "task",
  "policy",
  "evidence",
  "finding",
  "decision",
  "worker",
  "writer",
  "state",
] as const;
export type OperationFamily = (typeof OPERATION_FAMILIES)[number];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const invalidUnicode = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

const text = z.string().check((ctx) => {
  if (invalidUnicode(ctx.value))
    ctx.issues.push({ code: "custom", input: ctx.value, message: "invalid Unicode", path: [] });
});
const id = text.regex(uuidPattern, "expected lowercase UUID");
const digest = text.regex(digestPattern, "expected lowercase SHA-256 digest");
const revision = text.regex(uuidPattern, "expected UUID revision");
const validUtc = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second)
  );
};
export const utcSchema = text.check((ctx) => {
  if (!validUtc(ctx.value))
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: "expected UTC timestamp",
      path: [],
    });
});
const utc = utcSchema;
const safeInteger = z.number().int().safe();
const nonEmpty = text.min(1);
const pathValue = nonEmpty.check((ctx) => {
  if (
    ctx.value !== "." &&
    (ctx.value.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(ctx.value) ||
      ctx.value.includes("\\") ||
      ctx.value.split("/").includes(".."))
  )
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: "path must stay inside checkout",
      path: [],
    });
});
const nullableDigest = digest.nullable();
const nullableId = id.nullable();

export const hostSchema = z.enum([
  "opencode",
  "cursor",
  "codex_cli",
  "codex_desktop",
  "pi",
  "workit_cli",
]);
export type Host = z.infer<typeof hostSchema>;
export const assuranceSchema = z.enum(["enforced", "agent_guided", "unavailable"]);
export type Assurance = z.infer<typeof assuranceSchema>;
export const outcomeSchema = z.enum(["verified", "accepted_limitations", "stopped"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const scopeSchema = z
  .object({
    description: text,
    paths: z.array(pathValue),
    exclusions: z.array(pathValue),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;

export const scopeCovers = (outer: Scope, inner: Scope): boolean => {
  // Scope paths may carry trailing slashes; normalize so `docs/` covers `docs/x`.
  const strip = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, "") : value);
  const normOuter: Scope = {
    ...outer,
    paths: outer.paths.map(strip),
    exclusions: outer.exclusions.map(strip),
  };
  const innerPaths = (inner.paths.length ? inner.paths : ["."]).map(strip);
  const innerExclusions = inner.exclusions.map(strip);
  const excluded = (path: string, scope: Scope): boolean =>
    scope.exclusions.some(
      (excludedPath) => excludedPath === path || path.startsWith(`${excludedPath}/`),
    );
  const covers = (path: string): boolean =>
    normOuter.paths.some((base) => base === "." || path === base || path.startsWith(`${base}/`)) &&
    !excluded(path, normOuter);
  const innerExcludes = (path: string): boolean =>
    innerExclusions.some(
      (excludedPath) => excludedPath === path || path.startsWith(`${excludedPath}/`),
    );
  return (
    innerPaths.every(covers) &&
    !normOuter.exclusions.some((excludedPath) =>
      innerPaths.some(
        (base) =>
          (base === "." || excludedPath === base || excludedPath.startsWith(`${base}/`)) &&
          !innerExcludes(excludedPath),
      ),
    )
  );
};

export const refSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: pathValue, digest: nullableDigest }).strict(),
  z
    .object({
      kind: z.literal("record"),
      collection: z.enum(["evidence", "decisions", "findings", "workers"]),
      id,
    })
    .strict(),
  z.object({ kind: z.literal("host"), host: hostSchema, handle: nonEmpty }).strict(),
  z.object({ kind: z.literal("external"), url: text.url() }).strict(),
]);
export type Ref = z.infer<typeof refSchema>;

export const provenanceSchema = z
  .object({
    kind: z.enum(["host_observed", "agent_reported", "imported"]),
    host: hostSchema,
    session: refSchema.nullable(),
    workerId: nullableId,
    receipts: z.array(refSchema),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;
export const entrySchema = <T extends z.ZodType>(data: T) =>
  z.object({ id, recordedAt: utc, provenance: provenanceSchema, data }).strict();
export type Entry<T> = { id: Id; recordedAt: Utc; provenance: Provenance; data: T };

export const factSchema = z
  .object({
    statement: text,
    basis: z.enum(["observed", "inferred", "unknown"]),
    refs: z.array(refSchema),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.basis === "observed" && ctx.value.refs.length === 0)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "observed facts require supporting references",
        path: ["refs"],
      });
  });
export type Fact = z.infer<typeof factSchema>;
export const signalSchema = z
  .object({
    value: z.union([z.boolean(), z.literal("unknown")]),
    basis: z.enum(["observed", "inferred", "unknown"]),
    reason: text,
    refs: z.array(refSchema),
  })
  .strict()
  .check((ctx) => {
    const signal = ctx.value;
    const valid =
      signal.value === "unknown"
        ? signal.basis === "unknown"
        : signal.basis === "observed" || signal.basis === "inferred";
    if (!valid)
      ctx.issues.push({
        code: "custom",
        input: signal,
        message: "signal value and basis disagree",
        path: [],
      });
    if (signal.basis === "observed" && signal.refs.length === 0)
      ctx.issues.push({
        code: "custom",
        input: signal,
        message: "observed signals require supporting references",
        path: ["refs"],
      });
  });
export type Signal = z.infer<typeof signalSchema>;
const signalSet = z
  .object({
    approachUnknown: signalSchema,
    productChoiceOpen: signalSchema,
    behaviorChange: signalSchema,
    mechanicalLowRisk: signalSchema,
    durableAgreementNeeded: signalSchema,
    coordinationPlanNeeded: signalSchema,
    helperUseful: signalSchema,
    testFirstPractical: signalSchema,
  })
  .strict();
const consequenceSchema = z
  .object({
    area: z.enum([
      "behavior",
      "public_contract",
      "data",
      "security",
      "operations",
      "reversibility",
      "consumers",
    ]),
    fact: factSchema,
  })
  .strict();
const verificationSchema = z
  .object({
    claim: text,
    scope: scopeSchema,
    availableChecks: z.array(refSchema),
    gaps: z.array(text),
  })
  .strict();
export const assessmentSchema = z
  .object({
    facts: z.array(factSchema),
    signals: signalSet,
    consequences: z.array(consequenceSchema),
    verification: z.array(verificationSchema),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;

export const constraintSchema = z
  .object({
    id: nonEmpty,
    kind: z.enum(["host", "project", "user"]),
    statement: text,
    source: refSchema,
    acceptanceAllowed: z.boolean(),
    requires: z.array(
      z
        .object({
          kind: z.enum(["check", "method", "decision"]),
          scope: scopeSchema,
          refs: z.array(refSchema),
          method: z
            .enum([
              "investigation",
              "challenge",
              "artifacts",
              "testing",
              "verification",
              "review",
              "delegation",
              "continuity",
              "decisions",
            ])
            .nullable(),
          before: z.enum(["dependent_action", "write", "close"]),
          dependentAction: text.nullable(),
        })
        .strict()
        .check((ctx) => {
          const obligation = ctx.value;
          const validMethod =
            (obligation.kind === "method" && obligation.method !== null) ||
            (obligation.kind !== "method" && obligation.method === null);
          if (!validMethod)
            ctx.issues.push({
              code: "custom",
              input: obligation,
              message: "method obligations require a method; checks and decisions do not",
              path: ["method"],
            });
        }),
    ),
  })
  .strict();
export type Constraint = z.infer<typeof constraintSchema>;
export const intentSchema = z
  .object({ objective: text, scope: scopeSchema, authorityRefs: z.array(refSchema) })
  .strict();
export type Intent = z.infer<typeof intentSchema>;
export const progressSchema = z
  .object({
    summary: text,
    nextAction: text.nullable(),
    blockers: z.array(
      z.object({ reason: text, dependentAction: text, refs: z.array(refSchema) }).strict(),
    ),
  })
  .strict();
export type Progress = z.infer<typeof progressSchema>;

export const dimensionSchema = z.enum([
  "investigation",
  "challenge",
  "artifacts",
  "testing",
  "verification",
  "review",
  "delegation",
  "continuity",
  "decisions",
]);
export type Dimension = z.infer<typeof dimensionSchema>;

export const policySchema = z
  .object({
    policyVersion: text.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    inputDigest: digest,
    requirements: z.array(
      z
        .object({
          id: digest,
          ruleId: nonEmpty,
          dimension: dimensionSchema,
          scope: scopeSchema,
          reason: text,
          satisfaction: text,
          before: z.enum(["dependent_action", "write", "close"]),
          dependentAction: text.nullable(),
          acceptanceAllowed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;
export const requirementSchema = policySchema.shape.requirements.element;
export type Requirement = z.infer<typeof requirementSchema>;
export const policyChangeSchema = z
  .object({
    recordedAt: utc,
    fromInputDigest: nullableDigest,
    toInputDigest: digest,
    added: z.array(digest),
    retired: z.array(digest),
    reason: text,
  })
  .strict();
export type PolicyChange = z.infer<typeof policyChangeSchema>;

export const candidateSchema = z
  .object({
    id: digest,
    scope: scopeSchema,
    completeness: z.enum(["known", "uncertain"]),
    files: z.array(
      z
        .object({
          path: pathValue,
          kind: z.enum(["file", "symlink", "absent"]),
          digest: nullableDigest,
          executable: z.boolean().nullable(),
        })
        .strict()
        .check((ctx) => {
          const file = ctx.value;
          const valid =
            file.kind === "absent"
              ? file.digest === null && file.executable === null
              : file.kind === "file"
                ? file.digest !== null && typeof file.executable === "boolean"
                : file.digest !== null && file.executable === null;
          if (!valid)
            ctx.issues.push({
              code: "custom",
              input: file,
              message: "invalid file metadata",
              path: [],
            });
        }),
    ),
    environment: z
      .array(
        z.object({ name: nonEmpty, value: text.nullable(), refs: z.array(refSchema) }).strict(),
      )
      .check((ctx) => {
        if (new Set(ctx.value.map((value) => value.name)).size !== ctx.value.length)
          ctx.issues.push({
            code: "custom",
            input: ctx.value,
            message: "duplicate environment name",
            path: [],
          });
      }),
    head: text.nullable(),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.id !== candidateDigest(ctx.value))
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "candidate identity does not match its content",
        path: ["id"],
      });
  });
export type Candidate = z.infer<typeof candidateSchema>;
export const evidenceSchema = z
  .object({
    kind: z.enum(["check", "review", "investigation", "artifact"]),
    claim: text,
    requirementIds: z.array(digest),
    beforeCandidateId: nullableDigest.optional(),
    candidateId: nullableDigest.optional(),
    result: z.enum(["passed", "failed", "missing", "skipped"]),
    summary: text,
    refs: z.array(refSchema),
    exitCode: safeInteger.nullable(),
    reviewContext: refSchema.nullable(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const evidenceEvaluationSchema = z
  .object({
    evidenceId: id,
    status: z.enum(["passed", "failed", "missing", "skipped", "stale"]),
    reason: text,
  })
  .strict();
export type EvidenceEvaluation = z.infer<typeof evidenceEvaluationSchema>;
export const decisionSchema = z
  .object({
    purpose: z.enum(["design", "action", "limitation", "preference"]),
    binding: z
      .object({
        taskId: id,
        workspaceId: id,
        scope: scopeSchema,
        presented: text,
        approvedContent: text,
        contentRefs: z.array(refSchema),
      })
      .strict(),
    digest,
    response: z.enum(["approved", "rejected"]),
    requirementIds: z.array(digest),
    revoked: z.object({ at: utc, reason: text }).strict().nullable(),
    consumption: z
      .object({
        state: z.enum(["reserved", "consumed", "uncertain"]),
        at: utc,
        actionRef: refSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;
export const findingSchema = z
  .object({
    claim: text,
    consequence: text,
    scope: scopeSchema,
    candidateId: nullableDigest,
    refs: z.array(refSchema),
    disposition: z.enum(["open", "fixed", "dismissed", "deferred"]),
    resolution: z
      .object({ reason: text, evidenceIds: z.array(id), decisionIds: z.array(id) })
      .strict()
      .nullable(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
export const assignmentSchema = z
  .object({
    role: z.enum(["investigator", "reviewer", "implementer"]),
    objective: text,
    scope: scopeSchema,
    decisionIds: z.array(id),
    requirementIds: z.array(digest),
    candidateId: nullableDigest.optional(),
    stoppingCondition: text,
  })
  .strict();
export type Assignment = z.infer<typeof assignmentSchema>;
export const workerReportSchema = z
  .object({
    outcome: z.enum(["completed", "failed", "cancelled"]),
    summary: text,
    evidenceIds: z.array(id),
    findingIds: z.array(id),
  })
  .strict();
export type WorkerReport = z.infer<typeof workerReportSchema>;
export const workerSchema = z
  .object({
    assignment: assignmentSchema,
    state: z.enum(["assigned", "running", "cancelling", "stopped", "unknown"]),
    session: refSchema.nullable(),
    report: workerReportSchema.nullable(),
  })
  .strict();
export type Worker = z.infer<typeof workerSchema>;
export const ownerSchema = z
  .object({
    taskId: id,
    workerId: nullableId,
    session: z.object({ kind: z.literal("host"), host: hostSchema, handle: nonEmpty }).strict(),
  })
  .strict();
export type Owner = z.infer<typeof ownerSchema>;
export const closureSchema = z
  .object({
    outcome: outcomeSchema,
    at: utc,
    summary: text,
    decisionIds: z.array(id),
    evidenceIds: z.array(id),
  })
  .strict();
export type Closure = z.infer<typeof closureSchema>;
export const actionProgressSchema = z
  .object({
    decisionId: id,
    steps: z.array(nonEmpty),
    completedSteps: z.array(nonEmpty),
  })
  .strict()
  .check((ctx) => {
    const { steps, completedSteps } = ctx.value;
    const valid =
      new Set(steps).size === steps.length &&
      new Set(completedSteps).size === completedSteps.length &&
      completedSteps.every((step, index) => steps[index] === step);
    if (!valid)
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "completed action steps must be a unique prefix of approved steps",
        path: ["completedSteps"],
      });
  });
export type ActionProgress = z.infer<typeof actionProgressSchema>;
export const actionProgressListSchema = z.array(actionProgressSchema).check((ctx) => {
  if (new Set(ctx.value.map((progress) => progress.decisionId)).size !== ctx.value.length)
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: "action progress decision ids must be unique",
      path: ["decisionId"],
    });
});
export const taskRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    workspaceId: id,
    revision,
    createdAt: utc,
    updatedAt: utc,
    origin: z.object({ workspaceId: id, taskId: id, exportDigest: digest }).strict().nullable(),
    intent: entrySchema(intentSchema),
    constraints: z.array(constraintSchema),
    status: z.enum(["active", "paused", "closed"]),
    closure: closureSchema.nullable(),
    progress: progressSchema,
    assessments: z.array(entrySchema(assessmentSchema)),
    policy: policySchema.nullable(),
    policyChanges: z.array(policyChangeSchema),
    candidates: z.array(candidateSchema),
    evidence: z.array(entrySchema(evidenceSchema)),
    decisions: z.array(entrySchema(decisionSchema)),
    actionProgress: actionProgressListSchema.optional(),
    findings: z.array(entrySchema(findingSchema)),
    workers: z.array(entrySchema(workerSchema)),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export const workspaceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    revision,
    root: nonEmpty,
    writer: z
      .object({ state: z.enum(["held", "uncertain"]), owner: ownerSchema, acquiredAt: utc })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export const capabilitySchema = z
  .object({
    name: nonEmpty,
    surface: nonEmpty,
    assurance: assuranceSchema,
    reason: text,
    refs: z.array(refSchema),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;
export const requirementEvaluationSchema = z
  .object({
    requirementId: digest,
    status: z.enum(["satisfied", "unsatisfied", "accepted_limitation", "unavailable"]),
    evidenceIds: z.array(id),
    decisionIds: z.array(id),
    reason: text,
  })
  .strict();
export type RequirementEvaluation = z.infer<typeof requirementEvaluationSchema>;
export const taskViewSchema = z
  .object({
    task: taskRecordSchema,
    workspace: workspaceRecordSchema,
    capabilities: z.array(capabilitySchema),
    requirements: z.array(requirementEvaluationSchema),
    evidence: z.array(evidenceEvaluationSchema),
  })
  .strict();
export type TaskView = z.infer<typeof taskViewSchema>;
export const taskSummarySchema = z
  .object({
    id,
    revision,
    workspaceRevision: revision,
    objective: text,
    status: z.enum(["active", "paused", "closed"]),
    closure: closureSchema.nullable(),
    progress: progressSchema,
    policy: policySchema.nullable(),
    requirements: z.array(requirementEvaluationSchema),
    writer: workspaceRecordSchema.shape.writer,
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const exportBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: utc,
    sourceWorkspaceId: id,
    task: taskRecordSchema,
    digest,
  })
  .strict();
export type ExportBundle = z.infer<typeof exportBundleSchema>;

export const callerSchema = z.object({ host: hostSchema, actor: text }).strict();
export type Caller = z.infer<typeof callerSchema>;

const base = { schemaVersion: z.literal(1) };
const revisions = {
  expectedRevision: revision.optional(),
  expectedWorkspaceRevision: revision.optional(),
};
// Omitted revisions default to the current records inside the engine; explicit
// values are still CAS-enforced. This keeps single-call flows friction-free
// without weakening concurrent-write protection.
const taskId = { taskId: id };
const operation = <T extends z.ZodRawShape>(shape: T) => z.object({ ...base, ...shape }).strict();
const taskOperations = {
  start: operation({
    action: z.literal("start"),
    expectedWorkspaceRevision: revision.nullable().optional(),
    intent: intentSchema,
  }),
  list: operation({ action: z.literal("list") }),
  inspect: operation({
    action: z.literal("inspect"),
    ...taskId,
    view: z.enum(["summary", "full"]),
  }),
  revise: operation({
    action: z.literal("revise"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    intent: intentSchema,
    reason: text,
  }),
  progress: operation({
    action: z.literal("progress"),
    ...taskId,
    expectedRevision: revision.optional(),
    progress: progressSchema,
  }),
  pause: operation({
    action: z.literal("pause"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    reason: text,
  }),
  resume: operation({
    action: z.literal("resume"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    authorityRefs: z.array(refSchema),
  }),
  close: operation({
    action: z.literal("close"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    outcome: outcomeSchema,
    summary: text,
    decisionIds: z.array(id),
  }),
};
const policyOperations = {
  assess: operation({
    action: z.literal("assess"),
    ...taskId,
    expectedRevision: revision.optional(),
    assessment: assessmentSchema,
  }),
  preview: operation({ action: z.literal("preview"), ...taskId, assessment: assessmentSchema }),
  explain: operation({ action: z.literal("explain"), ...taskId }),
};
const evidenceOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: revision.optional(),
    evidence: evidenceSchema,
  }),
};
const findingOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: revision.optional(),
    claim: text,
    consequence: text,
    scope: scopeSchema,
    candidateId: nullableDigest.optional(),
    refs: z.array(refSchema),
  }),
  resolve: operation({
    action: z.literal("resolve"),
    ...taskId,
    expectedRevision: revision.optional(),
    findingId: id,
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
    expectedRevision: revision.optional(),
    purpose: decisionSchema.shape.purpose,
    binding: decisionSchema.shape.binding,
    response: decisionSchema.shape.response,
    requirementIds: z.array(digest),
  }),
  revoke: operation({
    action: z.literal("revoke"),
    ...taskId,
    expectedRevision: revision.optional(),
    decisionId: id,
    reason: text,
  }),
};
const workerOperations = {
  assign: operation({
    action: z.literal("assign"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    assignment: assignmentSchema,
  }),
  report: operation({
    action: z.literal("report"),
    ...taskId,
    expectedRevision: revision.optional(),
    expectedWorkspaceRevision: revision.optional(),
    workerId: id,
    report: workerReportSchema,
  }),
  cancel: operation({
    action: z.literal("cancel"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    workerId: id,
    reason: text,
  }),
};
const writerOperations = {
  acquire: operation({
    action: z.literal("acquire"),
    ...taskId,
    expectedRevision: revision.optional(),
    expectedWorkspaceRevision: revision.optional(),
    workerId: nullableId.optional(),
  }),
  release: operation({
    action: z.literal("release"),
    ...taskId,
    expectedRevision: revision.optional(),
    expectedWorkspaceRevision: revision.optional(),
    reason: text,
  }),
};
const stateOperations = {
  export: operation({ action: z.literal("export"), ...taskId }),
  import: operation({
    action: z.literal("import"),
    expectedWorkspaceRevision: revision.nullable().optional(),
    bundle: exportBundleSchema,
    authorityRefs: z.array(refSchema),
  }),
  recover: operation({
    action: z.literal("recover"),
    taskId: id.optional(),
    expectedWorkspaceRevision: revision.optional(),
    target: z.enum(["task", "workspace"]),
    expectedBytes: digest,
    snapshotDigest: digest,
    reason: text,
    authorityRefs: z.array(refSchema),
  }),
};

export const operationSchemas = {
  task: z.discriminatedUnion("action", Object.values(taskOperations) as any),
  policy: z.discriminatedUnion("action", Object.values(policyOperations) as any),
  evidence: z.discriminatedUnion("action", Object.values(evidenceOperations) as any),
  finding: z.discriminatedUnion("action", Object.values(findingOperations) as any),
  decision: z.discriminatedUnion("action", Object.values(decisionOperations) as any),
  worker: z.discriminatedUnion("action", Object.values(workerOperations) as any),
  writer: z.discriminatedUnion("action", Object.values(writerOperations) as any),
  state: z.discriminatedUnion("action", Object.values(stateOperations) as any),
} as const;
export type OperationRequest = z.infer<(typeof operationSchemas)[OperationFamily]>;
export type TaskStartRequest = z.infer<typeof taskOperations.start>;

const compiledOperationSchemas = Object.fromEntries(
  OPERATION_FAMILIES.map((family) => [family, z.compile(operationSchemas[family])]),
) as typeof operationSchemas;

export type Id = string;
export type Revision = string;
export type Digest = string;
export type Utc = string;

export type ErrorCode =
  | "invalid_input"
  | "unsupported_version"
  | "not_found"
  | "invalid_transition"
  | "revision_conflict"
  | "needs_input"
  | "permission_denied"
  | "capability_unavailable"
  | "requirements_unsatisfied"
  | "writer_conflict"
  | "recovery_required"
  | "storage_error"
  | "external_outcome_unknown";
export type ErrorDetails = {
  fields?: { path: string; reason: string }[];
  taskId?: Id;
  expectedRevision?: Revision;
  actualRevision?: Revision;
  expectedWorkspaceRevision?: Revision | null;
  actualWorkspaceRevision?: Revision | null;
  requirementIds?: Digest[];
  capability?: string;
  owner?: Owner;
  path?: string;
  operation?: string;
  outcome?: "not_started" | "pending" | "unknown";
};
export type Result<T> =
  | {
      ok: true;
      schemaVersion: 1;
      revision: Revision | null;
      workspaceRevision: Revision | null;
      data: T;
    }
  | { ok: false; schemaVersion: 1; code: ErrorCode; error: string; details: ErrorDetails };

export const success = <T>(
  revisionValue: Revision | null,
  workspaceRevisionValue: Revision | null,
  data: T,
): Result<T> => ({
  ok: true,
  schemaVersion: 1,
  revision: revisionValue,
  workspaceRevision: workspaceRevisionValue,
  data,
});
export const failure = (
  code: ErrorCode,
  error: string,
  details: ErrorDetails = {},
): Result<never> => ({ ok: false, schemaVersion: 1, code, error, details });

export function parseOperation(family: OperationFamily, input: unknown): Result<OperationRequest> {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
  )
    return failure("unsupported_version", "unsupported schema version", { operation: family });
  const compiled = compiledOperationSchemas[family].safeParse(input);
  const parsed = compiled.success ? operationSchemas[family].safeParse(input) : compiled;
  if (parsed.success) return success(null, null, parsed.data as OperationRequest);
  const fields = parsed.error.issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
    reason: issue.message,
  }));
  return failure("invalid_input", "operation input is invalid", { fields });
}

export function operationJsonSchema(family: OperationFamily): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(operationSchemas[family], { target: "draft-2020-12" });
}

/**
 * Advertised object depth shared by every host projection. Runtime validation
 * stays full-depth in parseOperation; this bound only keeps provider tool
 * schemas (e.g. Pi, MCP) within model nesting limits.
 */
export const OPERATION_SCHEMA_DEPTH = 1;

/** Provider nesting limit every advertised Workit schema must stay within. */
export const OPERATION_SCHEMA_MAX_DEPTH = 10;

export const canonicalFieldsDescription = (fields: string[]): string =>
  `Canonical object fields: ${fields.join(", ")}. Workit validates the complete nested value.`;

/**
 * Provider-safe projection of an operation JSON schema. Objects deeper than
 * maxDepth collapse to a described generic object that still names the
 * canonical fields, so models know what to send while providers accept the
 * shape. The full contract in operationJsonSchema is unchanged.
 *
 * With stringifiedObjects, every object, array, and primitive-const node also
 * accepts its JSON-encoded string form. Pi's transport stringifies nested
 * params before its own validation runs, so Pi publishes the tolerant shape
 * and decodes after validation; transports that carry real JSON stay strict.
 */
export function boundedOperationJsonSchema(
  family: OperationFamily,
  maxDepth: number = OPERATION_SCHEMA_DEPTH,
  stringifiedObjects = false,
): Record<string, unknown> {
  const tolerate = (projected: Record<string, unknown>): Record<string, unknown> => {
    if (!stringifiedObjects) return projected;
    if (projected.properties && typeof projected.properties === "object")
      return { ...projected, type: ["object", "string"] };
    if (projected.items) return { ...projected, type: ["array", "string"] };
    if (
      "const" in projected &&
      (typeof projected.const === "number" || typeof projected.const === "boolean")
    )
      return { anyOf: [projected, { const: String(projected.const) }] };
    if (projected.type === "object") return { ...projected, type: ["object", "string"] };
    if (projected.type === "array") return { ...projected, type: ["array", "string"] };
    return projected;
  };
  const collapse = (node: unknown, currentDepth: number): unknown => {
    if (Array.isArray(node)) return node.map((item) => collapse(item, currentDepth));
    if (typeof node !== "object" || node === null) return node;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      const fields = Object.keys(record.properties as Record<string, unknown>);
      if (currentDepth >= maxDepth || fields.length === 0) {
        const description = stringifiedObjects
          ? `${canonicalFieldsDescription(fields)} A JSON-encoded string is also accepted.`
          : canonicalFieldsDescription(fields);
        return tolerate({ type: "object", description });
      }
      return tolerate({
        ...record,
        properties: Object.fromEntries(
          Object.entries(record.properties as Record<string, unknown>).map(([key, child]) => [
            key,
            collapse(child, currentDepth + 1),
          ]),
        ),
      });
    }
    if (record.items) return tolerate({ ...record, items: collapse(record.items, currentDepth) });
    const composed = (["anyOf", "oneOf", "allOf"] as const).filter((key) =>
      Array.isArray(record[key]),
    );
    if (composed.length > 0) {
      const projected: Record<string, unknown> = { ...record };
      for (const key of composed)
        projected[key] = (record[key] as unknown[]).map((item) => collapse(item, currentDepth));
      return projected;
    }
    if ("const" in record) return tolerate({ ...record });
    return node;
  };
  return collapse(operationJsonSchema(family), 0) as Record<string, unknown>;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function canonical(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && invalidUnicode(value)) throw new TypeError("invalid Unicode");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("number must be a finite safe integer");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("value is not JSON serializable");
  if (seen.has(value)) throw new TypeError("cyclic value");
  seen.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("sparse array");
    }
    result = value.map((item) => canonical(item, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError("value is not a JSON object");
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
      throw new TypeError("symbol key is not JSON");
    if (Object.keys(value).some((key) => invalidUnicode(key)))
      throw new TypeError("invalid Unicode");
    result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key], seen)]),
    );
  }
  seen.delete(value);
  return result;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new Set()));
}
export function sha256(value: unknown): Digest {
  if (typeof value === "string" && invalidUnicode(value)) throw new TypeError("invalid Unicode");
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value), "utf8")
    .digest("hex");
}
export function newId(): Id {
  return randomUUID().toLowerCase();
}
export function newRevision(): Revision {
  return randomUUID().toLowerCase();
}
const compareCodeUnits = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};
const compareNullableText = (left: string | null, right: string | null): number =>
  left === right ? 0 : left === null ? -1 : right === null ? 1 : compareCodeUnits(left, right);
const compareBooleanNullable = (left: boolean | null, right: boolean | null): number =>
  left === right ? 0 : left === null ? -1 : right === null ? 1 : Number(left) - Number(right);
export function decisionDigest(input: Omit<Decision, "digest"> | Decision): Digest {
  const {
    digest: _ignored,
    revoked: _revoked,
    consumption: _consumption,
    ...value
  } = input as Decision;
  return sha256(value);
}
export function candidateDigest(input: Candidate): Digest {
  const normalizedScope = {
    description: input.scope.description,
    paths: [...input.scope.paths].sort(compareCodeUnits),
    exclusions: [...input.scope.exclusions].sort(compareCodeUnits),
  };
  return sha256({
    scope: normalizedScope,
    completeness: input.completeness,
    files: [...input.files].sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) ||
        compareCodeUnits(left.kind, right.kind) ||
        compareNullableText(left.digest, right.digest) ||
        compareBooleanNullable(left.executable, right.executable),
    ),
    environment: input.environment
      .map(({ name, value }) => ({ name, value }))
      .sort(
        (left, right) =>
          compareCodeUnits(left.name, right.name) || compareNullableText(left.value, right.value),
      ),
    head: input.head,
  });
}
export function requirementId(input: {
  ruleId: string;
  scope: Scope;
  satisfaction: string;
  before: string;
  dependentAction: string | null;
}): Digest {
  return sha256({
    ...input,
    scope: {
      description: input.scope.description,
      paths: [...input.scope.paths].sort(compareCodeUnits),
      exclusions: [...input.scope.exclusions].sort(compareCodeUnits),
    },
  });
}
