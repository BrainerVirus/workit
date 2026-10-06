// Flat operation inputs (S17, principle 4). Every host advertises one flat
// tool per family: `action` plus primitive or string-array fields, no nested
// objects, so no provider needs a depth projection. The canonical nested
// request is built here; nested canonical payloads still pass through.
import {
  OPERATION_ACTIONS,
  SCHEMA_VERSION,
  advertisedOperationSchemas,
  failure,
  success,
  type Host,
  type OperationFamily,
  type Ref,
  type Result,
} from "./task-contract";

type Json = Record<string, unknown>;
type Field = { type: "string" | "integer" | "boolean" | "array" | "object"; enum?: string[] };
type FamilySpec = { fields: Record<string, Field & { d?: string }> };

const str = (d?: string, values?: string[]): Field & { d?: string } => ({
  type: "string",
  ...(values ? { enum: values } : {}),
  ...(d ? { d } : {}),
});
const list = (d?: string): Field & { d?: string } => ({ type: "array", ...(d ? { d } : {}) });
const bool = (d?: string): Field & { d?: string } => ({ type: "boolean", ...(d ? { d } : {}) });
const int = (d?: string): Field & { d?: string } => ({ type: "integer", ...(d ? { d } : {}) });

const scopeFields = {
  paths: list("Scope paths (default: whole checkout)."),
  exclusions: list(),
  scope: str("Scope description."),
};
const refs = list("Paths or URLs.");

/** Field set per family. Omit taskId for the branch's implicit task; omit revisions. */
const FLAT: Record<OperationFamily, FamilySpec> = {
  task: {
    fields: {
      objective: str(),
      ...scopeFields,
      refs,
      reason: str(),
      summary: str(),
      nextAction: str(),
      blockers: list(),
      outcome: str(undefined, ["verified", "accepted_limitations", "stopped"]),
      decisionIds: list(),
      status: str(undefined, ["open", "closed", "all"]),
      query: str(),
      limit: int(),
      view: str(undefined, ["summary", "full"]),
    },
  },
  policy: {
    fields: {
      riskTier: str("low=trivial, medium=normal.", ["trivial", "normal", "high", "low", "medium"]),
      behaviorChange: bool("Observable behavior changes."),
      productChoiceOpen: bool("A product/preference choice is still open."),
      needsPlan: bool("Needs a written plan or spec first."),
      note: str(),
      refs: list("Plan/spec paths or URLs."),
    },
  },
  evidence: {
    fields: {
      kind: str(undefined, ["check", "review", "investigation", "artifact"]),
      claim: str(),
      result: str(undefined, ["passed", "failed", "missing", "skipped"]),
      summary: str(),
      exitCode: int(),
      refs,
      requirementIds: list(),
      candidateId: str(),
      beforeCandidateId: str(),
      reviewSession: str("Reviewer session handle (review evidence)."),
    },
  },
  finding: {
    fields: {
      claim: str(),
      consequence: str(),
      ...scopeFields,
      candidateId: str(),
      refs,
      findingId: str(),
      disposition: str(undefined, ["open", "fixed", "dismissed", "deferred"]),
      reason: str(),
      evidenceIds: list(),
      decisionIds: list(),
    },
  },
  decision: {
    fields: {
      purpose: str(undefined, ["design", "action", "limitation", "preference"]),
      response: str(undefined, ["approved", "rejected", "stated"]),
      presented: str("What the user was asked."),
      choice: str("The user's stated choice (response=stated)."),
      ...scopeFields,
      refs,
      requirementIds: list(),
      decisionId: str(),
      reason: str(),
    },
  },
  worker: {
    fields: {
      role: str(undefined, ["investigator", "reviewer", "implementer"]),
      objective: str(),
      ...scopeFields,
      decisionIds: list(),
      requirementIds: list(),
      candidateId: str(),
      stoppingCondition: str(),
      workerId: str(),
      outcome: str(undefined, ["completed", "failed", "cancelled"]),
      summary: str(),
      evidenceIds: list(),
      findingIds: list(),
      reason: str(),
    },
  },
  state: {
    fields: { bundle: { type: "object", d: "An export bundle (object or JSON string)." } },
  },
};

const COMMON: Record<string, Field & { d?: string }> = {
  taskId: str("Omit for this branch's task."),
  expectedRevision: str(),
  expectedWorkspaceRevision: str(),
};

const DESCRIPTIONS: Record<OperationFamily, string> = {
  task: "Workit task lifecycle for this branch's task (optional continuity).",
  policy:
    "Judge the work in four flat calls (riskTier, behaviorChange, productChoiceOpen, needsPlan); Workit derives the checks, verdicts, decisions and plan it needs.",
  evidence: "Record a note-level evidence entry; only `workit check` runs satisfy check gates.",
  finding: "Record or resolve a review finding.",
  decision: "Record or revoke a user decision (never an authorization).",
  worker: "Assign, report or cancel a bounded helper.",
  state: "Export or import a task handoff bundle.",
};
/** One-line tool description shared by every host. */
export const operationDescription = (family: OperationFamily): string =>
  `${DESCRIPTIONS[family]} Flat fields; omit taskId and revisions.`;

const READ_TASK_FIELDS = new Set(["status", "query", "limit", "view"]);
const READ_ONLY_ACTIONS = new Set(["list", "inspect", "preview", "explain", "export"]);

/**
 * The advertised flat JSON Schema for a family: depth 1, `action` required.
 * `readOnly` limits the actions to reads (unattested MCP); `stringTolerant`
 * also accepts JSON-encoded strings for non-string fields (Pi's transport).
 * Families with no read-only action return null under `readOnly`.
 */
export function flatOperationJsonSchema(
  family: OperationFamily,
  options: { readOnly?: boolean; stringTolerant?: boolean } = {},
): Record<string, unknown> | null {
  const spec = FLAT[family];
  const actions = options.readOnly
    ? OPERATION_ACTIONS[family].filter((action) => READ_ONLY_ACTIONS.has(action))
    : [...OPERATION_ACTIONS[family]];
  if (!actions.length) return null;
  const property = (field: Field & { d?: string }): Record<string, unknown> => {
    const base =
      field.type === "array"
        ? { type: "array", items: { type: "string" } }
        : field.type === "object"
          ? { type: "object" }
          : { type: field.type };
    const tolerant =
      options.stringTolerant && field.type !== "string" ? { type: [field.type, "string"] } : {};
    return {
      ...base,
      ...tolerant,
      ...(field.enum ? { enum: field.enum } : {}),
      ...(field.d ? { description: field.d } : {}),
    };
  };
  const properties: Record<string, unknown> = { action: { type: "string", enum: actions } };
  // Reads advertise only what reads take: no revisions, and task reads only their filters.
  const readField = (name: string) =>
    name === "taskId" || (family === "task" ? READ_TASK_FIELDS.has(name) : family === "policy");
  for (const [name, field] of Object.entries({ ...COMMON, ...spec.fields }))
    if (options.readOnly ? readField(name) : !(family === "state" && name === "expectedRevision"))
      properties[name] = property(field);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required: ["action"],
  };
}

/** The advertised schema of a family (all actions). */
export const operationJsonSchema = (family: OperationFamily): Record<string, unknown> =>
  flatOperationJsonSchema(family)!;

// ---------------------------------------------------------------------------
// normalization

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON-encoded string decoded (Pi stringifies structured params). */
const decoded = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed) && !/^(true|false|null|-?\d+)$/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const strings = (value: unknown): unknown => {
  const plain = decoded(value);
  if (typeof plain === "string") return plain.trim() ? [plain] : [];
  return plain;
};

/** "docs/x.md" → file ref, "https://…" → external ref; ref objects pass through. */
export const refOf = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return /^https?:\/\//i.test(value)
    ? ({ kind: "external", url: value } satisfies Ref)
    : ({ kind: "file", path: value.replace(/^\.\//, ""), digest: null } satisfies Ref);
};
const refList = (value: unknown): unknown => {
  const items = strings(value);
  return Array.isArray(items) ? items.map(refOf) : items;
};

/** Take `keys` off `flat` (decoded), returning the ones present. */
const take = (flat: Json, keys: string[], map: (value: unknown) => unknown = decoded): Json => {
  const out: Json = {};
  for (const key of keys)
    if (key in flat) {
      out[key] = map(flat[key]);
      delete flat[key];
    }
  return out;
};

/** Merge flat values under `key`, keeping nested values the caller sent. */
const nest = (request: Json, key: string, flat: Json, defaults: Json = {}): void => {
  const nested = isObject(decoded(request[key])) ? (decoded(request[key]) as Json) : null;
  if (!nested && !Object.keys(flat).length) return;
  request[key] = { ...defaults, ...flat, ...nested };
};

const scopeOf = (flat: Json, description: unknown): Json | null => {
  const scope = decoded(flat.scope);
  const has = "paths" in flat || "exclusions" in flat || typeof scope === "string";
  const out = isObject(scope)
    ? scope
    : has
      ? {
          description: typeof scope === "string" ? scope : String(description ?? ""),
          paths: strings(flat.paths ?? ["."]),
          exclusions: strings(flat.exclusions ?? []),
        }
      : null;
  delete flat.scope;
  delete flat.paths;
  delete flat.exclusions;
  return out;
};
const defaultScope = (description: unknown): Json => ({
  description: typeof description === "string" ? description : "",
  paths: ["."],
  exclusions: [],
});

const LISTS = [
  "decisionIds",
  "evidenceIds",
  "findingIds",
  "requirementIds",
  "refs",
  "blockers",
] as const;
/** Request envelope keys; every other policy key is a judgment (mapped or ignored, D17). */
const ENVELOPE = new Set([
  "schemaVersion",
  "action",
  "taskId",
  "expectedRevision",
  "expectedWorkspaceRevision",
  "judgment",
]);

/**
 * Build the canonical request from a flat (or already canonical) one: add a
 * missing `schemaVersion`, decode stringified values, nest flat fields, and
 * default the empty lists the contract requires. Idempotent on canonical
 * input; anything it cannot map is left for the contract to reject.
 */
export function normalizeOperationInput(
  family: OperationFamily,
  input: unknown,
  host: Host,
): unknown {
  if (!isObject(input)) return input;
  const request: Json = { ...input };
  if (!("schemaVersion" in request)) request.schemaVersion = 1;
  else request.schemaVersion = decoded(request.schemaVersion);
  for (const key of ["limit", "exitCode"] as const)
    if (key in request) request[key] = decoded(request[key]);
  const action = request.action;
  const flat = request;
  switch (family) {
    case "task": {
      if (action === "start" || action === "revise") {
        const intent = isObject(decoded(request.intent)) ? (decoded(request.intent) as Json) : {};
        const objective = flat.objective ?? intent.objective;
        const scope = scopeOf(flat, objective);
        const fields = take(flat, ["objective"]);
        const authorityRefs = "refs" in flat ? refList(flat.refs) : undefined;
        delete flat.refs;
        nest(
          request,
          "intent",
          {
            ...fields,
            ...(scope ? { scope } : {}),
            ...(authorityRefs ? { authorityRefs } : {}),
          },
          { scope: defaultScope(objective), authorityRefs: [] },
        );
      } else if (action === "progress") {
        const fields = take(flat, ["summary", "nextAction"]);
        const blockers = "blockers" in flat ? strings(flat.blockers) : undefined;
        delete flat.blockers;
        nest(
          request,
          "progress",
          {
            ...fields,
            ...(Array.isArray(blockers)
              ? {
                  blockers: blockers.map((item) =>
                    typeof item === "string"
                      ? { reason: item, dependentAction: "", refs: [] }
                      : item,
                  ),
                }
              : {}),
          },
          { nextAction: null, blockers: [] },
        );
      } else if (action === "close" && "decisionIds" in flat)
        flat.decisionIds = strings(flat.decisionIds);
      break;
    }
    case "policy": {
      if (action === "assess" || action === "preview") {
        const judgment: Json = isObject(decoded(request.judgment))
          ? { ...(decoded(request.judgment) as Json) }
          : {};
        for (const key of Object.keys(flat))
          if (!ENVELOPE.has(key)) {
            if (!(key in judgment)) judgment[key] = decoded(flat[key]);
            delete flat[key];
          }
        request.judgment = judgment;
      }
      break;
    }
    case "evidence": {
      if (action === "record") {
        const review = "reviewSession" in flat ? decoded(flat.reviewSession) : undefined;
        delete flat.reviewSession;
        const fields = take(flat, [
          "kind",
          "claim",
          "result",
          "summary",
          "exitCode",
          "candidateId",
          "beforeCandidateId",
          "reviewContext",
        ]);
        if ("refs" in flat) fields.refs = refList(flat.refs);
        if ("requirementIds" in flat) fields.requirementIds = strings(flat.requirementIds);
        delete flat.refs;
        delete flat.requirementIds;
        if (typeof review === "string" && review)
          fields.reviewContext = { kind: "host", host, handle: review };
        nest(request, "evidence", fields, {
          summary: "",
          refs: [],
          requirementIds: [],
          exitCode: null,
          reviewContext: null,
        });
      }
      break;
    }
    case "finding": {
      if (action === "record") {
        const scope = scopeOf(flat, flat.claim);
        if (scope) request.scope = scope;
        else if (!("scope" in request)) request.scope = defaultScope(request.claim);
        request.refs = "refs" in flat ? refList(flat.refs) : [];
      }
      break;
    }
    case "decision": {
      if (action === "record") {
        const binding = isObject(decoded(request.binding))
          ? (decoded(request.binding) as Json)
          : {};
        const presented = flat.presented ?? binding.presented;
        const scope = scopeOf(flat, presented);
        const fields = take(flat, ["presented"]);
        const choice = flat.choice;
        delete flat.choice;
        const contentRefs = "refs" in flat ? refList(flat.refs) : undefined;
        delete flat.refs;
        nest(
          request,
          "binding",
          {
            ...fields,
            ...(scope ? { scope } : {}),
            ...(contentRefs ? { contentRefs } : {}),
            ...(typeof choice === "string"
              ? { statedChoice: { ref: "choice", text: choice } }
              : {}),
          },
          { scope: defaultScope(presented), contentRefs: [] },
        );
      }
      break;
    }
    case "worker": {
      if (action === "assign") {
        const objective = flat.objective;
        const scope = scopeOf(flat, objective);
        const fields = take(flat, ["role", "objective", "candidateId", "stoppingCondition"]);
        for (const key of ["decisionIds", "requirementIds"])
          if (key in flat) {
            fields[key] = strings(flat[key]);
            delete flat[key];
          }
        nest(
          request,
          "assignment",
          { ...fields, ...(scope ? { scope } : {}) },
          { scope: defaultScope(objective), decisionIds: [], requirementIds: [] },
        );
      } else if (action === "report") {
        const fields = take(flat, ["outcome", "summary"]);
        for (const key of ["evidenceIds", "findingIds"])
          if (key in flat) {
            fields[key] = strings(flat[key]);
            delete flat[key];
          }
        nest(request, "report", fields, { evidenceIds: [], findingIds: [] });
      }
      break;
    }
    case "state": {
      if ("bundle" in request) request.bundle = decoded(request.bundle);
      break;
    }
  }
  // Lists the contract requires but agents routinely omit.
  const defaults: Record<string, Partial<Record<string, string[]>>> = {
    finding: { resolve: ["evidenceIds", "decisionIds"] },
    decision: { record: ["requirementIds"] },
  };
  for (const key of defaults[family]?.[String(action)] ?? [])
    if (!(key in request)) request[key] = [];
  for (const key of LISTS)
    if (key in request && typeof request[key] === "string") request[key] = strings(request[key]);
  return request;
}

/**
 * Host-side validation before the engine runs: normalize, then parse against
 * the advertised contract (taskId optional: the engine resolves the branch's
 * implicit task). Returns the normalized request for the engine.
 */
export function parseAdvertisedOperation(
  family: OperationFamily,
  input: unknown,
  host: Host,
): Result<unknown> {
  const request = normalizeOperationInput(family, input, host);
  if (isObject(request) && request.schemaVersion !== SCHEMA_VERSION)
    return failure("unsupported_version", "unsupported schema version", { operation: family });
  const parsed = advertisedOperationSchemas[family].safeParse(request);
  if (parsed.success) return success(null, null, request);
  return failure("invalid_input", "operation input is invalid", {
    fields: parsed.error.issues.map((issue) => ({
      path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
      reason: issue.message,
    })),
  });
}
