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
  if (ctx.value !== "." && (ctx.value.includes("\\") || ctx.value.split("/").includes(".."))) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: "invalid path",
      path: [],
    });
  }
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
  "claude_code",
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

/** Maps one reference during record traversal. Returning null marks the
 * reference unportable: arrays drop it, nullable fields null it, and
 * non-nullable positions propagate the drop to their owner. */
export type RefMap = (ref: Ref) => Ref | null;

type RewriteOutcome = { drop: boolean; value?: unknown };

const rewriteUnknown = (value: unknown, map: RefMap): RewriteOutcome => {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const rewritten = rewriteUnknown(item, map);
      if (!rewritten.drop) out.push(rewritten.value);
    }
    return { drop: false, value: out };
  }
  if (typeof value === "object" && value !== null) {
    if (refSchema.safeParse(value).success) {
      const mapped = map(value as Ref);
      return mapped === null ? { drop: true } : { drop: false, value: mapped };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const rewritten = rewriteUnknown(item, map);
      out[key] = rewritten.drop ? null : rewritten.value;
    }
    return { drop: false, value: out };
  }
  return { drop: false, value };
};

const rewriteNode = (value: unknown, schema: z.ZodType, map: RefMap): RewriteOutcome => {
  // Note: this zod version's classic accessors return core types, hence the
  // casts below. Runtime behavior is identical; only the annotations differ.
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    refSchema.safeParse(value).success
  ) {
    const mapped = map(value as Ref);
    return mapped === null ? { drop: true } : { drop: false, value: mapped };
  }
  let node: z.ZodType = schema;
  while (
    node instanceof z.ZodNullable ||
    node instanceof z.ZodOptional ||
    node instanceof z.ZodDefault
  ) {
    node = node.unwrap() as z.ZodType;
  }
  if (node === refSchema) {
    if (!refSchema.safeParse(value).success) return { drop: false, value };
    const mapped = map(value as Ref);
    return mapped === null ? { drop: true } : { drop: false, value: mapped };
  }
  if (node instanceof z.ZodArray) {
    if (!Array.isArray(value)) return { drop: false, value };
    const out: unknown[] = [];
    for (const item of value) {
      const rewritten = rewriteNode(item, node.element as z.ZodType, map);
      if (!rewritten.drop) out.push(rewritten.value);
    }
    return { drop: false, value: out };
  }
  if (node instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { drop: false, value };
    const shape = node.shape as Record<string, z.ZodType>;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (!(key in shape)) {
        const scrubbed = rewriteUnknown(item, map);
        out[key] = scrubbed.drop ? null : scrubbed.value;
        continue;
      }
      const child = shape[key];
      const rewritten = rewriteNode(item, child, map);
      if (rewritten.drop) {
        if (child instanceof z.ZodOptional || child instanceof z.ZodDefault) continue;
        if (child instanceof z.ZodNullable) {
          out[key] = null;
          continue;
        }
        return { drop: true };
      }
      out[key] = rewritten.value;
    }
    return { drop: false, value: out };
  }
  return { drop: false, value };
};

/**
 * Schema-driven reference rewrite over an already-validated record subtree.
 * Every `Ref` anywhere in the value is mapped; unportable references are
 * dropped from arrays, nulled in nullable fields, and propagated upward
 * anywhere else — so a new ref-bearing field can never silently slip
 * through export or import. Unknown (schema-absent) keys are scrubbed the
 * same way. Returns null only when the root itself is an unportable ref.
 */
export const rewriteRecordRefs = (value: unknown, schema: z.ZodType, map: RefMap): unknown => {
  const rewritten = rewriteNode(value, schema, map);
  return rewritten.drop ? null : rewritten.value;
};

export const provenanceSchema = z
  .object({
    kind: z.enum(["host_observed", "agent_reported", "imported"]),
    host: hostSchema,
    session: refSchema.nullable(),
    workerId: nullableId,
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;
export const entrySchema = <T extends z.ZodType>(data: T) =>
  z.object({ id, recordedAt: utc, provenance: provenanceSchema, data }).strict();
export type Entry<T> = { id: Id; recordedAt: Utc; provenance: Provenance; data: T };

/** Risk tiers an agent judges; aliases (low, medium, …) are mapped on input. */
export const RISK_TIERS = ["trivial", "normal", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
/**
 * The agent's policy judgment (S17): four flat calls plus an optional note
 * and supporting refs. Everything else is derived deterministically
 * (core/policy/derive.ts).
 */
export const judgmentSchema = z
  .object({
    riskTier: z.enum(RISK_TIERS),
    behaviorChange: z.boolean(),
    productChoiceOpen: z.boolean(),
    needsPlan: z.boolean(),
    note: text.nullable(),
    refs: z.array(refSchema),
  })
  .strict();
export type Judgment = z.infer<typeof judgmentSchema>;
/** A ≤6.x assessment as stored (facts/signals/…): kept verbatim, never written. */
export const legacyAssessmentSchema = z.looseObject({});

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
/**
 * What `workit check` observed (design §2.1 S9, §2.2). Only the CLI's
 * observing path writes it (WorkitCore.observeCheck); the agent-facing
 * `evidence.record` operation rejects it. A task that holds one lists
 * `evidence.*.data.observation` in `critical`, so an older reader fails
 * closed instead of reading the check without it.
 */
export const checkObservationSchema = z
  .object({
    observer: z.literal("workit_cli"),
    /** The check name (`--name` or `workit check <name>`); null for an unnamed ad-hoc run. */
    name: nonEmpty.nullable(),
    /** The name is configured and argv is exactly its configured command, run from the repo top. */
    configured: z.boolean(),
    argv: z.array(text).min(1),
    shell: z.boolean(),
    /** Working directory relative to the repository top (posix), `.` at the top. */
    cwd: nonEmpty,
    exitCode: safeInteger,
    durationMs: safeInteger.min(0),
    timedOut: z.boolean(),
    head: text.nullable(),
    /** Worktree tree key before the run; evidence is fresh while the tree key is unchanged. */
    tree: text.nullable(),
    dirty: z.boolean().nullable(),
    /** Cheap stat-cached worktree signal before the run (per-turn freshness; see worktreeSignal). */
    signal: text.nullable(),
    /** Tree key after the run; differs from `tree` when the command changed the worktree. */
    treeAfter: text.nullable(),
    /** The command changed the worktree: the evidence is stale (fail safe). */
    modifiedWorktree: z.boolean(),
    base: text.nullable(),
    patchId: text.nullable(),
    /** A minimal environment fingerprint: platform, arch and allowlisted variables. */
    environment: z
      .object({
        platform: nonEmpty,
        arch: nonEmpty,
        vars: z.record(nonEmpty, text.nullable()),
      })
      .strict(),
    logDigest: text.nullable(),
    logRef: text.nullable(),
    logTail: z.array(text).max(40),
    ledgerRowId: text.nullable(),
    /** Set only when a host hook later attests the run (design §2.1 attestation). */
    attestation: z
      .object({ host: nonEmpty, session: text.nullable(), agentId: text.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type CheckObservation = z.infer<typeof checkObservationSchema>;
/** The record path a task lists in `critical` once it stores a check observation. */
export const CHECK_OBSERVATION_PATH = "evidence.*.data.observation";
const evidenceFields = {
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
};
export const evidenceSchema = z
  .object({ ...evidenceFields, observation: checkObservationSchema.optional() })
  .strict();
/** Evidence as an agent may submit it: no CLI observation. */
const reportedEvidenceSchema = z.object(evidenceFields).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const evidenceEvaluationSchema = z
  .object({
    evidenceId: id,
    status: z.enum(["passed", "failed", "missing", "skipped", "stale"]),
    reason: text,
  })
  .strict();
export type EvidenceEvaluation = z.infer<typeof evidenceEvaluationSchema>;
/**
 * A durable decision record (D2, D18): agent-asserted like every other
 * recording. It satisfies `decisions` requirements and accepted limitations;
 * it never authorizes an external effect — autonomy grants and the host's
 * own permission prompt do that. Legacy keys (`approvedContent`, `displayed`,
 * `standing`, `consumption`) are dropped on read (D17).
 */
export const decisionSchema = z
  .object({
    purpose: z.enum(["design", "action", "limitation", "preference"]),
    binding: z
      .object({
        taskId: id,
        workspaceId: id,
        scope: scopeSchema,
        presented: text,
        contentRefs: z.array(refSchema),
        statedChoice: z.object({ ref: text, text: text }).strict().optional(),
      })
      .strict(),
    digest,
    response: z.enum(["approved", "rejected", "stated"]),
    requirementIds: z.array(digest),
    revoked: z.object({ at: utc, reason: text }).strict().nullable(),
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
    state: z.enum(["assigned", "dispatching", "running", "cancelling", "stopped", "unknown"]),
    session: refSchema.nullable(),
    coordinator: refSchema.optional(),
    report: workerReportSchema.nullable(),
  })
  .strict();
export type Worker = z.infer<typeof workerSchema>;
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
export const runtimeSchema = z
  .object({
    createdWith: text.nullable(),
    updatedWith: text,
  })
  .strict();
export type RuntimeInfo = z.infer<typeof runtimeSchema>;
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
    pauseReason: text.nullable().optional(),
    runtime: runtimeSchema.optional(),
    /** ≤6.x assessments, read-only history; judgments replace them. */
    assessments: z.array(entrySchema(legacyAssessmentSchema)),
    /** Listed in `critical` once written, so an older reader fails closed. */
    judgments: z.array(entrySchema(judgmentSchema)).optional(),
    policy: policySchema.nullable(),
    policyChanges: z.array(policyChangeSchema),
    candidates: z.array(candidateSchema),
    evidence: z.array(entrySchema(evidenceSchema)),
    decisions: z.array(entrySchema(decisionSchema)),
    findings: z.array(entrySchema(findingSchema)),
    workers: z.array(entrySchema(workerSchema)),
    /** Paths a reader must understand; see parseStoredRecord. */
    critical: z.array(nonEmpty).optional(),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

type Strip = { path: PropertyKey[]; keys: string[] };
const stripCount = (strips: Strip[]) => strips.reduce((sum, strip) => sum + strip.keys.length, 0);
/** Unknown-key issues only, flattened; null when any issue is a real schema
 * violation. For a union, the branch that strips the fewest keys wins, so a
 * key one branch knows is never dropped in favor of a narrower branch. */
const strippable = (
  issues: readonly z.core.$ZodIssue[],
  prefix: PropertyKey[] = [],
): Strip[] | null => {
  const strips: Strip[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      strips.push({ path: [...prefix, ...issue.path], keys: issue.keys });
      continue;
    }
    if (issue.code !== "invalid_union") return null;
    const branch = issue.errors
      .map((errors) => strippable(errors, [...prefix, ...issue.path]))
      .filter((found): found is Strip[] => found !== null && found.length > 0)
      .reduce<Strip[] | null>(
        (best, found) => (best === null || stripCount(found) < stripCount(best) ? found : best),
        null,
      );
    if (!branch) return null;
    strips.push(...branch);
  }
  return strips;
};

/** A dotted record path with array indices as `*`, e.g. `evidence.*.data.observer`. */
const recordPath = (path: PropertyKey[]): string =>
  path.map((key) => (typeof key === "number" ? "*" : String(key))).join(".");
const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);

export type StoredRecordParse<T> =
  | { success: true; data: T; stripped: string[] }
  | { success: false; error: z.ZodError; critical: string[] };

/**
 * Reader tolerance for stored records (D17). A record written by a newer
 * runtime may carry keys this reader does not know; exactly the keys zod
 * reports as unrecognized are dropped and the value is parsed again, and
 * every other violation still fails. Writes keep parsing strictly.
 *
 * The rule for new record fields: a field must be safe for an older reader
 * to ignore (and to lose when that reader rewrites the record), or the writer
 * must list its path in the record's top-level `critical` array. A reader
 * that would strip a critical path fails closed instead (`critical` names the
 * paths), so it neither acts on nor rewrites a record it cannot represent.
 */
export const parseStoredRecord = <S extends z.ZodType>(
  schema: S,
  value: unknown,
): StoredRecordParse<z.output<S>> => {
  let parsed = schema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data, stripped: [] };
  const first = { success: false as const, error: parsed.error, critical: [] as string[] };
  const declared =
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { critical?: unknown }).critical)
      ? (value as { critical: unknown[] }).critical
          .filter((item): item is string => typeof item === "string")
          // An array index in a declaration means any element, like `*`.
          .map((item) =>
            item
              .split(".")
              .map((key) => (/^\d+$/.test(key) ? "*" : key))
              .join("."),
          )
      : [];
  const stripped: string[] = [];
  let current: unknown = structuredClone(value);
  for (let round = 0; round < 8 && !parsed.success; round++) {
    const strips = strippable(parsed.error.issues);
    if (strips === null || strips.length === 0) return first;
    for (const strip of strips) {
      let target: unknown = current;
      for (const key of strip.path)
        target =
          typeof target === "object" && target !== null
            ? (target as Record<PropertyKey, unknown>)[key]
            : undefined;
      if (typeof target !== "object" || target === null) return first;
      for (const key of strip.keys) {
        stripped.push(recordPath([...strip.path, key]));
        delete (target as Record<string, unknown>)[key];
      }
    }
    parsed = schema.safeParse(current);
  }
  if (!parsed.success) return first;
  const critical = [
    ...new Set(stripped.filter((item) => declared.some((path) => overlaps(item, path)))),
  ];
  if (critical.length > 0) return { ...first, critical };
  return { success: true, data: parsed.data, stripped: [...new Set(stripped)] };
};
export const workspaceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    revision,
    root: nonEmpty,
    runtime: runtimeSchema.optional(),
    /** Paths a reader must understand; see parseStoredRecord. */
    critical: z.array(nonEmpty).optional(),
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
    createdAt: utc,
    updatedAt: utc,
    runtime: runtimeSchema.nullable(),
    objective: text,
    status: z.enum(["active", "paused", "closed"]),
    closure: closureSchema.nullable(),
    progress: progressSchema,
    policy: policySchema.nullable(),
    requirements: z.array(requirementEvaluationSchema),
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskListItemSchema = taskSummarySchema
  .omit({ policy: true, requirements: true })
  .extend({ source: provenanceSchema.pick({ host: true, kind: true }) })
  .strict();
export type TaskListItem = z.infer<typeof taskListItemSchema>;
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
  list: operation({
    action: z.literal("list"),
    status: z.enum(["open", "closed", "all"]).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  inspect: operation({
    action: z.literal("inspect"),
    ...taskId,
    view: z.enum(["summary", "full"]).optional(),
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
  }),
  close: operation({
    action: z.literal("close"),
    ...taskId,
    ...revisions,
    expectedWorkspaceRevision: revision.optional(),
    outcome: outcomeSchema,
    summary: text,
    decisionIds: z.array(id).optional(),
  }),
};
/** Judgment values as sent; core/policy/judgment.ts maps aliases and validates. */
const rawJudgment = z.record(z.string(), z.unknown());
const policyOperations = {
  assess: operation({
    action: z.literal("assess"),
    ...taskId,
    expectedRevision: revision.optional(),
    judgment: rawJudgment,
  }),
  preview: operation({ action: z.literal("preview"), ...taskId, judgment: rawJudgment }),
  explain: operation({ action: z.literal("explain"), ...taskId }),
};
const evidenceOperations = {
  record: operation({
    action: z.literal("record"),
    ...taskId,
    expectedRevision: revision.optional(),
    evidence: reportedEvidenceSchema,
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
    // The engine binds the decision to the task and workspace it records on.
    binding: decisionSchema.shape.binding.extend({
      taskId: id.optional(),
      workspaceId: id.optional(),
    }),
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
const stateOperations = {
  export: operation({ action: z.literal("export"), ...taskId }),
  import: operation({
    action: z.literal("import"),
    expectedWorkspaceRevision: revision.nullable().optional(),
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
const withImplicitTask = (options: Record<string, z.ZodObject>) =>
  Object.values(options).map((option) =>
    "taskId" in option.shape ? option.extend({ taskId: id.optional() }) : option,
  );
const advertised = (options: Record<string, z.ZodObject>) =>
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
  /** Retryable: another live Workit call holds the checkout's metadata lock. */
  | "busy"
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
  path?: string;
  operation?: string;
  outcome?: "not_started" | "pending" | "unknown";
  guidance?: string;
  /** Structured remedy for unsatisfied requirements: rule, reason, and
   * satisfaction text instead of opaque requirement hashes alone. */
  requirements?: {
    requirementId: string;
    ruleId: string;
    reason: string;
    satisfaction: string;
    dependentAction: string | null;
  }[];
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
  if (parsed.success) return success(null, null, parsed.data);
  const fields = parsed.error.issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
    reason: issue.message,
  }));
  return failure("invalid_input", "operation input is invalid", { fields });
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
        .toSorted()
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
  const { digest: _ignored, revoked: _revoked, ...value } = input as Decision;
  return sha256(value);
}
export function candidateDigest(input: Candidate): Digest {
  const normalizedScope = {
    description: input.scope.description,
    paths: [...input.scope.paths].toSorted(compareCodeUnits),
    exclusions: [...input.scope.exclusions].toSorted(compareCodeUnits),
  };
  return sha256({
    scope: normalizedScope,
    completeness: input.completeness,
    files: [...input.files].toSorted(
      (left, right) =>
        compareCodeUnits(left.path, right.path) ||
        compareCodeUnits(left.kind, right.kind) ||
        compareNullableText(left.digest, right.digest) ||
        compareBooleanNullable(left.executable, right.executable),
    ),
    environment: input.environment
      .map(({ name, value }) => ({ name, value }))
      .toSorted(
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
      paths: [...input.scope.paths].toSorted(compareCodeUnits),
      exclusions: [...input.scope.exclusions].toSorted(compareCodeUnits),
    },
  });
}
