import { createHash, randomUUID } from "node:crypto";
import * as z from "./zod-mini";
import { scopePathCovers } from "./scope-glob";

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

export const text = z.string().check((ctx) => {
  if (invalidUnicode(ctx.value))
    ctx.issues.push({ code: "custom", input: ctx.value, message: "invalid Unicode", path: [] });
});
export const id = text.check(z.regex(uuidPattern, "expected lowercase UUID"));
/** A full id or an unambiguous lowercase prefix of one (the 8-char short id other surfaces print). */
export const idRefPattern = /^[0-9a-f][0-9a-f-]{7,35}$/;
export const idRef = text.check(
  z.regex(idRefPattern, "expected a UUID or an id prefix of 8+ characters"),
);
export const digest = text.check(z.regex(digestPattern, "expected lowercase SHA-256 digest"));
export const revision = text.check(z.regex(uuidPattern, "expected UUID revision"));
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
// Classic zod's .int().safe(): .safe() repeats the int check.
const safeInteger = z.number().check(z.int()).check(z.int());
const nonEmpty = text.check(z.minLength(1));
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
export const nullableDigest = z.nullable(digest);
const nullableId = z.nullable(id);

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

export const scopeSchema = z.strictObject({
  description: text,
  paths: z.array(pathValue),
  exclusions: z.array(pathValue),
});
export type Scope = z.infer<typeof scopeSchema>;

/**
 * The first part of `inner` that `outer` does not contain (#647): an inner
 * path no outer path covers, or an outer exclusion that cuts into an inner
 * path the inner scope does not exclude too. Null when contained.
 */
export type ScopeGap = { path: string; exclusion: string | null };

export const scopeGap = (outer: Scope, inner: Scope): ScopeGap | null => {
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
    normOuter.paths.some((base) => scopePathCovers(base, path)) && !excluded(path, normOuter);
  const innerExcludes = (path: string): boolean =>
    innerExclusions.some(
      (excludedPath) => excludedPath === path || path.startsWith(`${excludedPath}/`),
    );
  const uncovered = innerPaths.find((path) => !covers(path));
  if (uncovered !== undefined) return { path: uncovered, exclusion: null };
  for (const excludedPath of normOuter.exclusions) {
    const base = innerPaths.find(
      (path) =>
        (path === "." || excludedPath === path || excludedPath.startsWith(`${path}/`)) &&
        !innerExcludes(excludedPath),
    );
    if (base !== undefined) return { path: base, exclusion: excludedPath };
  }
  return null;
};

export const scopeCovers = (outer: Scope, inner: Scope): boolean => scopeGap(outer, inner) === null;

export const refSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path: pathValue, digest: nullableDigest }),
  z.strictObject({
    kind: z.literal("record"),
    collection: z.enum(["evidence", "decisions", "findings", "workers"]),
    id,
  }),
  z.strictObject({ kind: z.literal("host"), host: hostSchema, handle: nonEmpty }),
  z.strictObject({ kind: z.literal("external"), url: text.check(z.url()) }),
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

const rewriteNode = (value: unknown, schema: z.core.$ZodType, map: RefMap): RewriteOutcome => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    refSchema.safeParse(value).success
  ) {
    const mapped = map(value as Ref);
    return mapped === null ? { drop: true } : { drop: false, value: mapped };
  }
  let node: z.core.$ZodType = schema;
  while (
    node instanceof z.core.$ZodNullable ||
    node instanceof z.core.$ZodOptional ||
    node instanceof z.core.$ZodDefault
  ) {
    node = node._zod.def.innerType;
  }
  if (node === refSchema) {
    if (!refSchema.safeParse(value).success) return { drop: false, value };
    const mapped = map(value as Ref);
    return mapped === null ? { drop: true } : { drop: false, value: mapped };
  }
  if (node instanceof z.core.$ZodArray) {
    if (!Array.isArray(value)) return { drop: false, value };
    const out: unknown[] = [];
    for (const item of value) {
      const rewritten = rewriteNode(item, node._zod.def.element, map);
      if (!rewritten.drop) out.push(rewritten.value);
    }
    return { drop: false, value: out };
  }
  if (node instanceof z.core.$ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { drop: false, value };
    const shape = node._zod.def.shape;
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
        if (child instanceof z.core.$ZodOptional || child instanceof z.core.$ZodDefault) continue;
        if (child instanceof z.core.$ZodNullable) {
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
export const rewriteRecordRefs = (
  value: unknown,
  schema: z.core.$ZodType,
  map: RefMap,
): unknown => {
  const rewritten = rewriteNode(value, schema, map);
  return rewritten.drop ? null : rewritten.value;
};

export const provenanceSchema = z.strictObject({
  kind: z.enum(["host_observed", "agent_reported", "imported"]),
  host: hostSchema,
  session: z.nullable(refSchema),
  workerId: nullableId,
});
export type Provenance = z.infer<typeof provenanceSchema>;
export const entrySchema = <T extends z.core.SomeType>(data: T) =>
  z.strictObject({ id, recordedAt: utc, provenance: provenanceSchema, data });
export type Entry<T> = { id: Id; recordedAt: Utc; provenance: Provenance; data: T };

/** Risk tiers an agent judges; aliases (low, medium, …) are mapped on input. */
export const RISK_TIERS = ["trivial", "normal", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
/**
 * The agent's policy judgment (S17): four flat calls plus an optional note
 * and supporting refs. Everything else is derived deterministically
 * (core/policy/derive.ts).
 */
export const judgmentSchema = z.strictObject({
  riskTier: z.enum(RISK_TIERS),
  behaviorChange: z.boolean(),
  productChoiceOpen: z.boolean(),
  needsPlan: z.boolean(),
  note: z.nullable(text),
  refs: z.array(refSchema),
});
export type Judgment = z.infer<typeof judgmentSchema>;
/** A ≤6.x assessment as stored (facts/signals/…): kept verbatim, never written. */
export const legacyAssessmentSchema = z.looseObject({});

export const constraintSchema = z.strictObject({
  id: nonEmpty,
  kind: z.enum(["host", "project", "user"]),
  statement: text,
  source: refSchema,
  acceptanceAllowed: z.boolean(),
  requires: z.array(
    z
      .strictObject({
        kind: z.enum(["check", "method", "decision"]),
        scope: scopeSchema,
        refs: z.array(refSchema),
        method: z.nullable(
          z.enum([
            "investigation",
            "challenge",
            "artifacts",
            "testing",
            "verification",
            "review",
            "delegation",
            "continuity",
            "decisions",
          ]),
        ),
        before: z.enum(["dependent_action", "write", "close"]),
        dependentAction: z.nullable(text),
      })
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
});
export type Constraint = z.infer<typeof constraintSchema>;
export const intentSchema = z.strictObject({
  objective: text,
  scope: scopeSchema,
  authorityRefs: z.array(refSchema),
});
export type Intent = z.infer<typeof intentSchema>;
export const progressSchema = z.strictObject({
  summary: text,
  nextAction: z.nullable(text),
  blockers: z.array(
    z.strictObject({ reason: text, dependentAction: text, refs: z.array(refSchema) }),
  ),
});
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

export const policySchema = z.strictObject({
  policyVersion: text.check(z.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)),
  inputDigest: digest,
  requirements: z.array(
    z.strictObject({
      id: digest,
      ruleId: nonEmpty,
      dimension: dimensionSchema,
      scope: scopeSchema,
      reason: text,
      satisfaction: text,
      before: z.enum(["dependent_action", "write", "close"]),
      dependentAction: z.nullable(text),
      acceptanceAllowed: z.boolean(),
    }),
  ),
});
export type Policy = z.infer<typeof policySchema>;
export const requirementSchema = policySchema.shape.requirements._zod.def.element;
export type Requirement = z.infer<typeof requirementSchema>;
export const policyChangeSchema = z.strictObject({
  recordedAt: utc,
  fromInputDigest: nullableDigest,
  toInputDigest: digest,
  added: z.array(digest),
  retired: z.array(digest),
  reason: text,
});
export type PolicyChange = z.infer<typeof policyChangeSchema>;

export const candidateSchema = z
  .strictObject({
    id: digest,
    scope: scopeSchema,
    completeness: z.enum(["known", "uncertain"]),
    files: z.array(
      z
        .strictObject({
          path: pathValue,
          kind: z.enum(["file", "symlink", "absent"]),
          digest: nullableDigest,
          executable: z.nullable(z.boolean()),
        })
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
      .array(z.strictObject({ name: nonEmpty, value: z.nullable(text), refs: z.array(refSchema) }))
      .check((ctx) => {
        if (new Set(ctx.value.map((value) => value.name)).size !== ctx.value.length)
          ctx.issues.push({
            code: "custom",
            input: ctx.value,
            message: "duplicate environment name",
            path: [],
          });
      }),
    head: z.nullable(text),
  })
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
export const checkObservationSchema = z.strictObject({
  observer: z.literal("workit_cli"),
  /** The check name (`--name` or `workit check <name>`); null for an unnamed ad-hoc run. */
  name: z.nullable(nonEmpty),
  /** The name is configured and argv is exactly its configured command, run from the repo top. */
  configured: z.boolean(),
  argv: z.array(text).check(z.minLength(1)),
  shell: z.boolean(),
  /** Working directory relative to the repository top (posix), `.` at the top. */
  cwd: nonEmpty,
  exitCode: safeInteger,
  durationMs: safeInteger.check(z.gte(0)),
  timedOut: z.boolean(),
  head: z.nullable(text),
  /** Worktree tree key before the run; evidence is fresh while the tree key is unchanged. */
  tree: z.nullable(text),
  dirty: z.nullable(z.boolean()),
  /** Cheap stat-cached worktree signal before the run (per-turn freshness; see worktreeSignal). */
  signal: z.nullable(text),
  /** Tree key after the run; differs from `tree` when the command changed the worktree. */
  treeAfter: z.nullable(text),
  /** The command changed the worktree: the evidence is stale (fail safe). */
  modifiedWorktree: z.boolean(),
  base: z.nullable(text),
  patchId: z.nullable(text),
  /** A minimal environment fingerprint: platform, arch and allowlisted variables. */
  environment: z.strictObject({
    platform: nonEmpty,
    arch: nonEmpty,
    vars: z.record(nonEmpty, z.nullable(text)),
  }),
  logDigest: z.nullable(text),
  logRef: z.nullable(text),
  logTail: z.array(text).check(z.maxLength(40)),
  ledgerRowId: z.nullable(text),
  /** Set only when a host hook later attests the run (design §2.1 attestation). */
  attestation: z.nullable(
    z.strictObject({ host: nonEmpty, session: z.nullable(text), agentId: z.nullable(text) }),
  ),
});
export type CheckObservation = z.infer<typeof checkObservationSchema>;
/** The record path a task lists in `critical` once it stores a check observation. */
export const CHECK_OBSERVATION_PATH = "evidence.*.data.observation";
const evidenceFields = {
  kind: z.enum(["check", "review", "investigation", "artifact"]),
  claim: text,
  requirementIds: z.array(digest),
  beforeCandidateId: z.optional(nullableDigest),
  candidateId: z.optional(nullableDigest),
  result: z.enum(["passed", "failed", "missing", "skipped"]),
  summary: text,
  refs: z.array(refSchema),
  exitCode: z.nullable(safeInteger),
  reviewContext: z.nullable(refSchema),
};
export const evidenceSchema = z.strictObject({
  ...evidenceFields,
  observation: z.optional(checkObservationSchema),
});
/** Evidence as an agent may submit it: no CLI observation. */
export const reportedEvidenceSchema = z.strictObject(evidenceFields);
export type Evidence = z.infer<typeof evidenceSchema>;
export const evidenceEvaluationSchema = z.strictObject({
  evidenceId: id,
  status: z.enum(["passed", "failed", "missing", "skipped", "stale"]),
  reason: text,
});
export type EvidenceEvaluation = z.infer<typeof evidenceEvaluationSchema>;
/**
 * A durable decision record (D2, D18): agent-asserted like every other
 * recording. It satisfies `decisions` requirements and accepted limitations;
 * it never authorizes an external effect — autonomy grants and the host's
 * own permission prompt do that. Legacy keys (`approvedContent`, `displayed`,
 * `standing`, `consumption`) are dropped on read (D17).
 */
export const decisionSchema = z.strictObject({
  purpose: z.enum(["design", "action", "limitation", "preference"]),
  binding: z.strictObject({
    taskId: id,
    workspaceId: id,
    scope: scopeSchema,
    presented: text,
    contentRefs: z.array(refSchema),
    statedChoice: z.optional(z.strictObject({ ref: text, text: text })),
  }),
  digest,
  response: z.enum(["approved", "rejected", "stated"]),
  requirementIds: z.array(digest),
  revoked: z.nullable(z.strictObject({ at: utc, reason: text })),
});
export type Decision = z.infer<typeof decisionSchema>;

export const findingSchema = z.strictObject({
  claim: text,
  consequence: text,
  scope: scopeSchema,
  candidateId: nullableDigest,
  refs: z.array(refSchema),
  disposition: z.enum(["open", "fixed", "dismissed", "deferred"]),
  resolution: z.nullable(
    z.strictObject({ reason: text, evidenceIds: z.array(id), decisionIds: z.array(id) }),
  ),
  /** Set when the lead resolved a helper's finding; the helper cannot resolve it again. */
  leadOwned: z.optional(z.literal(true)),
});
export type Finding = z.infer<typeof findingSchema>;
export const assignmentSchema = z.strictObject({
  role: z.enum(["investigator", "reviewer", "implementer"]),
  objective: text,
  scope: scopeSchema,
  decisionIds: z.array(id),
  requirementIds: z.array(digest),
  candidateId: z.optional(nullableDigest),
  stoppingCondition: text,
});
export type Assignment = z.infer<typeof assignmentSchema>;
export const workerReportSchema = z.strictObject({
  outcome: z.enum(["completed", "failed", "cancelled"]),
  summary: text,
  evidenceIds: z.array(id),
  findingIds: z.array(idRef),
});
export type WorkerReport = z.infer<typeof workerReportSchema>;
export const workerSchema = z.strictObject({
  assignment: assignmentSchema,
  state: z.enum(["assigned", "dispatching", "running", "cancelling", "stopped", "unknown"]),
  session: z.nullable(refSchema),
  coordinator: z.optional(refSchema),
  report: z.nullable(workerReportSchema),
});
export type Worker = z.infer<typeof workerSchema>;
export const closureSchema = z.strictObject({
  outcome: outcomeSchema,
  at: utc,
  summary: text,
  decisionIds: z.array(id),
  evidenceIds: z.array(id),
});
export type Closure = z.infer<typeof closureSchema>;
export const runtimeSchema = z.strictObject({
  createdWith: z.nullable(text),
  updatedWith: text,
});
export type RuntimeInfo = z.infer<typeof runtimeSchema>;
export const taskRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  workspaceId: id,
  revision,
  createdAt: utc,
  updatedAt: utc,
  origin: z.nullable(z.strictObject({ workspaceId: id, taskId: id, exportDigest: digest })),
  intent: entrySchema(intentSchema),
  constraints: z.array(constraintSchema),
  status: z.enum(["active", "paused", "closed"]),
  closure: z.nullable(closureSchema),
  progress: progressSchema,
  pauseReason: z.optional(z.nullable(text)),
  runtime: z.optional(runtimeSchema),
  /** ≤6.x assessments, read-only history; judgments replace them. */
  assessments: z.array(entrySchema(legacyAssessmentSchema)),
  /** Listed in `critical` once written, so an older reader fails closed. */
  judgments: z.optional(z.array(entrySchema(judgmentSchema))),
  policy: z.nullable(policySchema),
  policyChanges: z.array(policyChangeSchema),
  candidates: z.array(candidateSchema),
  evidence: z.array(entrySchema(evidenceSchema)),
  decisions: z.array(entrySchema(decisionSchema)),
  findings: z.array(entrySchema(findingSchema)),
  workers: z.array(entrySchema(workerSchema)),
  /** Paths a reader must understand; see parseStoredRecord. */
  critical: z.optional(z.array(nonEmpty)),
});
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
  | { success: false; error: z.core.$ZodError; critical: string[] };

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
export const parseStoredRecord = <S extends z.ZodMiniType>(
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
export const workspaceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  revision,
  root: nonEmpty,
  runtime: z.optional(runtimeSchema),
  /** Paths a reader must understand; see parseStoredRecord. */
  critical: z.optional(z.array(nonEmpty)),
});
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export const capabilitySchema = z.strictObject({
  name: nonEmpty,
  surface: nonEmpty,
  assurance: assuranceSchema,
  reason: text,
  refs: z.array(refSchema),
});
export type Capability = z.infer<typeof capabilitySchema>;
export const requirementEvaluationSchema = z.strictObject({
  requirementId: digest,
  status: z.enum(["satisfied", "unsatisfied", "accepted_limitation", "unavailable"]),
  evidenceIds: z.array(id),
  decisionIds: z.array(id),
  reason: text,
});
export type RequirementEvaluation = z.infer<typeof requirementEvaluationSchema>;
export const taskViewSchema = z.strictObject({
  task: taskRecordSchema,
  workspace: workspaceRecordSchema,
  capabilities: z.array(capabilitySchema),
  requirements: z.array(requirementEvaluationSchema),
  evidence: z.array(evidenceEvaluationSchema),
});
export type TaskView = z.infer<typeof taskViewSchema>;
export const taskSummarySchema = z.strictObject({
  id,
  revision,
  workspaceRevision: revision,
  createdAt: utc,
  updatedAt: utc,
  runtime: z.nullable(runtimeSchema),
  objective: text,
  status: z.enum(["active", "paused", "closed"]),
  closure: z.nullable(closureSchema),
  progress: progressSchema,
  policy: z.nullable(policySchema),
  requirements: z.array(requirementEvaluationSchema),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;
/** Bounded `inspect` projection (`view: "summary"`): under 4 KB however long the task history is. */
export type TaskBrief = {
  id: string;
  revision: string;
  workspaceRevision: string;
  updatedAt: string;
  objective: string;
  status: TaskSummary["status"];
  closure: { outcome: Closure["outcome"]; at: string; summary: string } | null;
  progress: {
    summary: string;
    nextAction: string | null;
    blockers: { reason: string; dependentAction: string }[];
  };
  requirements: {
    total: number;
    unmet: number;
    open: { dimension: Dimension; before: string; status: RequirementEvaluation["status"] }[];
  };
  truncated: boolean;
};
// Strict like taskSummarySchema: omit and extend keep its catchall.
export const taskListItemSchema = z.extend(
  z.omit(taskSummarySchema, { policy: true, requirements: true }),
  { source: z.pick(provenanceSchema, { host: true, kind: true }) },
);
export type TaskListItem = z.infer<typeof taskListItemSchema>;
export const exportBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: utc,
  sourceWorkspaceId: id,
  task: taskRecordSchema,
  digest,
});
export type ExportBundle = z.infer<typeof exportBundleSchema>;

export const callerSchema = z.strictObject({ host: hostSchema, actor: text });
export type Caller = z.infer<typeof callerSchema>;

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

/**
 * Resolve a full id or an unambiguous prefix against the ids a task holds.
 * An exact match always wins; several prefix matches fail listing the candidates.
 */
export function resolveIdRef(kind: string, ref: string, ids: readonly string[]): Result<string> {
  if (ids.includes(ref)) return success(null, null, ref);
  const matches = ids.filter((candidate) => candidate.startsWith(ref));
  if (matches.length === 1) return success(null, null, matches[0]);
  if (matches.length === 0) return failure("not_found", `${kind} not found`);
  return failure(
    "invalid_input",
    `${kind} prefix ${ref} is ambiguous; candidates: ${matches.join(", ")}`,
  );
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
