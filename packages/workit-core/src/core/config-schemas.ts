// JSON Schemas for the hand-edited config files (#614), generated from the
// zod schemas Workit validates with so the editor schema cannot drift from
// what Workit enforces. Fields Workit reads leniently on purpose (D17: an
// older Workit tolerates a newer value) stay z.unknown() at runtime and get
// an editor-only definition here, so completion offers their allowed values.
// The editor schemas are stricter than the readers: an unknown key or a bad
// value is underlined, while Workit itself still warns and falls back.
// `bun run write:schemas` writes packages/workit-core/schemas/; a test fails
// when a committed schema is stale.
import { z } from "zod";
import { DEFAULT_ENDPOINTS } from "../autonomy";
import { COMMIT_PRESETS, LOCALE_RE, PRESETS, UPDATES_MODES } from "./config";
import { MODEL_ROLES, MODEL_TIERS } from "./role-models";
import {
  CHANGELOG_MODES,
  DELEGATION_MODES,
  DOCS_MODES,
  MODEL_HOST_KEYS,
  PR_TEMPLATE_MODES,
  RELEASE_NOTES_MODES,
  branchPreset,
  commitPreset,
  modelRoles,
  nonBlank,
  releaseTrackSchema,
  workspaceConfigSchema,
  workspacesFileSchema,
} from "./workspaces";

export const CONFIG_SCHEMA_FILES = [
  "workspaces.json",
  "config.json",
  "vcs.json",
  "youtrack.json",
] as const;
export type ConfigSchemaFile = (typeof CONFIG_SCHEMA_FILES)[number];

export const CONFIG_SCHEMA_BASE_URL = "https://unpkg.com/@brainervirus/workit-core/schemas/";

/** The published URL of a config file's schema, what `"$schema"` points at. */
export const configSchemaUrl = (file: ConfigSchemaFile): string =>
  `${CONFIG_SCHEMA_BASE_URL}${file}`;

export const isConfigSchemaFile = (name: string): name is ConfigSchemaFile =>
  (CONFIG_SCHEMA_FILES as readonly string[]).includes(name);

/**
 * `document` with `"$schema"` as its first key: the user's own value when it
 * has one, else the published schema of `file`.
 */
export const withSchemaRef = <T extends Record<string, unknown>>(
  file: ConfigSchemaFile,
  document: T,
): T & { $schema: unknown } => {
  const { $schema, ...rest } = document;
  return {
    $schema: $schema === undefined ? configSchemaUrl(file) : $schema,
    ...rest,
  } as unknown as T & {
    $schema: unknown;
  };
};

type JsonSchema = Record<string, unknown>;

const string = (description?: string): JsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
});
const enumOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const closed = (properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/** A repo-relative path or glob: not absolute, no drive letter, no `..` segment. */
const REPO_PATH = String.raw`^(?![\\/]|[A-Za-z]:)(?!(?:.*[\\/])?\.\.(?:[\\/]|$)).*\S`;
const repoPath = (description: string, suffix = ""): JsonSchema => ({
  type: "string",
  pattern: suffix ? `${REPO_PATH}.*${suffix}$` : REPO_PATH,
  description,
});
const nonBlankString: JsonSchema = { type: "string", pattern: String.raw`\S` };

const perHost = (leaf: JsonSchema): JsonSchema =>
  closed(Object.fromEntries(MODEL_HOST_KEYS.map((host) => [host, leaf])));
const perTier = (value: JsonSchema): JsonSchema =>
  closed(Object.fromEntries(MODEL_TIERS.map((tier) => [tier, value])));
const ref = (name: string): JsonSchema => ({ $ref: `#/definitions/${name}` });

/** Shared editor fragments, referenced by `$ref` so the schema stays small. */
const DEFINITIONS: Record<string, JsonSchema> = {
  modelLeaf: {
    anyOf: [
      { ...nonBlankString, description: "A model name." },
      closed({ model: string("The model name."), effort: string("The reasoning effort.") }, [
        "model",
      ]),
    ],
  },
  roleModel: { anyOf: [ref("modelLeaf"), perHost(ref("modelLeaf"))] },
  tierModel: { anyOf: [nonBlankString, perHost(nonBlankString)] },
};

const entry = workspaceConfigSchema.shape;

/** Editor-only definitions for the leniently read fields, keyed by their zod def. */
const EDITOR_DEFINITIONS = new Map<unknown, JsonSchema>([
  [entry.defaultEndpoint, enumOf(DEFAULT_ENDPOINTS)],
  [entry.delegation, enumOf(DELEGATION_MODES)],
  [entry.changelog, enumOf(CHANGELOG_MODES)],
  [entry.docs, enumOf(DOCS_MODES)],
  [
    entry.changelogPath,
    {
      anyOf: [
        repoPath("A repo-relative changelog path or glob."),
        {
          type: "array",
          minItems: 1,
          items: repoPath("A repo-relative changelog path or glob."),
        },
      ],
    },
  ],
  [
    entry.prTemplate,
    {
      anyOf: [
        enumOf(PR_TEMPLATE_MODES),
        repoPath("A repo-relative path to one .md template.", String.raw`\.[mM][dD]`),
      ],
    },
  ],
  [entry.releaseNotes, enumOf(RELEASE_NOTES_MODES)],
  [releaseTrackSchema.shape.releaseNotes, enumOf(RELEASE_NOTES_MODES)],
  [entry.vcs.unwrap().shape.host, nonBlankString],
  [entry.issues.unwrap().shape.relation, enumOf(["closes", "refs"])],
  [entry.issues.unwrap().shape.repo, string("owner/name")],
  [entry.issues.unwrap().shape.host, nonBlankString],
  [entry.fanout.unwrap().shape.tierModels, perTier(ref("tierModel"))],
  [
    modelRoles,
    closed(
      Object.fromEntries(
        MODEL_ROLES.map((role) => [
          role,
          role === "implementer" ? perTier(ref("roleModel")) : ref("roleModel"),
        ]),
      ),
    ),
  ],
  [
    entry.resources,
    closed({
      slots: {
        type: "integer",
        minimum: 1,
        maximum: 64,
        description: "How many heavy checks may run at once on this machine.",
      },
      scope: {
        type: "boolean",
        description: "False turns the systemd scope off (the lease still applies).",
      },
      heavy: {
        type: "array",
        items: { type: "string" },
        description: "Named checks that are heavy.",
      },
      light: {
        type: "array",
        items: { type: "string" },
        description: "Named checks that never take the lease.",
      },
      memoryMax: {
        type: ["string", "number"],
        description:
          'MemoryMax of a heavy check\'s scope: a percent of RAM ("40%") or a size ("8G").',
      },
      cpuQuota: {
        type: ["string", "number"],
        description: "CPUQuota of a heavy check's scope.",
      },
      wait: {
        type: ["number", "string"],
        description: "How long a heavy check waits for the lease (seconds, or a duration).",
      },
    }),
  ],
]);

const configFileSchema = z
  .object({
    locale: z
      .string()
      .regex(LOCALE_RE)
      .optional()
      .describe("The language of Workit's prompts and drafts, e.g. en or es-419."),
    localeOptions: z.array(z.string()).optional().describe("The locales the setup wizard offers."),
    branchPolicy: z
      .object({
        preset: branchPreset.describe(
          "The branch model: gitflow, github-flow, trunk-based or custom.",
        ),
        allowed: z
          .array(z.string())
          .optional()
          .describe("Branch name globs a new branch must match."),
        protected: z.array(z.string()).optional().describe("Branches nobody commits to directly."),
      })
      .strict()
      .optional()
      .describe("The global branch policy; a workspace's `branchPolicy` overrides it."),
    commitPolicy: z
      .object({
        preset: commitPreset.describe("The commit message flavor, e.g. conventional."),
        pattern: z
          .string()
          .optional()
          .describe("A regular expression every commit subject must match."),
      })
      .strict()
      .optional()
      .describe("The global commit policy; a workspace's `commitPolicy` overrides it."),
    updates: z
      .enum(UPDATES_MODES as [string, ...string[]])
      .optional()
      .describe(
        "How an interactive launch handles a newer release: prompt (default), auto or off. Set with `workit upgrade --set-updates`.",
      ),
  })
  .strict();

// vcs.json and youtrack.json predate Workit's typed readers and are read key
// by key, so their editor schemas leave unknown keys alone.
const forgeHost = (kind: string) =>
  z
    .object({
      host: z.string().optional().describe(`The ${kind} host, for a self-hosted server.`),
      apiUrl: z.string().optional().describe(`The ${kind} API URL.`),
      tokenFile: z.string().optional().describe(`A file holding the ${kind} token.`),
    })
    .passthrough()
    .optional();
const vcsFileSchema = z
  .object({
    provider: z
      .enum(["github", "gitlab"])
      .optional()
      .describe("The forge when no workspace or remote names one."),
    defaultTargetBranch: z
      .string()
      .optional()
      .describe(
        "The branch PRs target when neither the workspace nor its branch preset names one.",
      ),
    github: forgeHost("GitHub").describe("GitHub settings."),
    gitlab: forgeHost("GitLab").describe("GitLab settings."),
    pr: z
      .object({
        squashOnMerge: z.boolean().optional(),
        removeSourceBranch: z.boolean().optional(),
        pushBranch: z.boolean().optional(),
        confirmSkip: z.boolean().optional(),
      })
      .passthrough()
      .optional()
      .describe("PR style defaults."),
  })
  .passthrough();
const youtrackFileSchema = z
  .object({
    baseUrl: z.string().optional().describe("The YouTrack URL (required to use YouTrack)."),
    tokenFile: z.string().optional().describe("The file holding the YouTrack token (mode 0600)."),
    locale: z.string().optional().describe("The language of issue updates."),
    timezone: z
      .string()
      .optional()
      .describe("The IANA timezone that decides a work item's day; default the process timezone."),
    meetingIssue: z.string().optional().describe("The issue meeting time is logged on."),
    meetingIssues: z
      .record(
        z.string(),
        z
          .object({
            issue: z.string().optional(),
            label: z.string().optional(),
            workItemText: z.string().optional(),
            url: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .describe("Named meetings, each with its issue, label, work item text and URL."),
    meetingWorkItemText: z
      .string()
      .optional()
      .describe("The work item text for meeting time (default Meetings)."),
    tokenDefaults: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        profileTab: z.string().optional(),
      })
      .passthrough()
      .optional()
      .describe("What the setup wizard pre-fills when you create a token."),
  })
  .passthrough();

/** Objects whose unknown keys stay allowed in the closed files' editor schemas. */
const OPEN_OBJECTS = new Set<unknown>([
  entry.branchPolicy.unwrap().shape.prefixes.unwrap()._zod.def,
  releaseTrackSchema.shape.naming.unwrap()._zod.def,
]);

const SOURCES: Record<ConfigSchemaFile, { schema: z.ZodType; title: string; open?: true }> = {
  "workspaces.json": {
    schema: workspacesFileSchema,
    title: "Workit workspaces (~/.config/workit/workspaces.json)",
  },
  "config.json": {
    schema: configFileSchema,
    title: "Workit config (~/.config/workit/config.json)",
  },
  "vcs.json": {
    schema: vcsFileSchema,
    title: "Workit forge settings (~/.config/workit/vcs.json)",
    open: true,
  },
  "youtrack.json": {
    schema: youtrackFileSchema,
    title: "Workit YouTrack settings (~/.config/workit/youtrack.json)",
    open: true,
  },
};

const PRESET_ENUMS = new Map<unknown, readonly string[]>([
  [branchPreset._zod.def, Object.keys(PRESETS)],
  [commitPreset._zod.def, COMMIT_PRESETS],
]);
const EDITOR_BY_DEF = new Map(
  [...EDITOR_DEFINITIONS].map(([schema, json]) => [(schema as z.ZodType)._zod.def, json]),
);

const replace = (target: JsonSchema, next: JsonSchema): void => {
  const description = target.description;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next, description === undefined ? {} : { description });
};

/** The JSON Schema of one config file, as published. */
export const configJsonSchema = (file: ConfigSchemaFile): JsonSchema => {
  const { schema, title, open } = SOURCES[file];
  const generated = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema._zod.def;
      const editor = EDITOR_BY_DEF.get(def);
      if (editor) return replace(jsonSchema, editor);
      const presets = PRESET_ENUMS.get(def);
      if (presets) return replace(jsonSchema, enumOf(presets));
      if (def === nonBlank._zod.def) Object.assign(jsonSchema, { pattern: String.raw`\S` });
      if (def.type === "object" && !open && !OPEN_OBJECTS.has(def))
        jsonSchema.additionalProperties = false;
    },
  }) as JsonSchema;
  const { $schema, definitions, ...body } = generated;
  const all: Record<string, JsonSchema> = { ...(definitions as Record<string, JsonSchema>) };
  for (let grew = true; grew;) {
    const text = JSON.stringify([body, all]);
    const missing = Object.keys(DEFINITIONS).filter(
      (name) => !all[name] && text.includes(`"#/definitions/${name}"`),
    );
    for (const name of missing) all[name] = DEFINITIONS[name];
    grew = missing.length > 0;
  }
  return {
    $schema,
    $id: configSchemaUrl(file),
    title,
    ...body,
    properties: {
      $schema: string("The JSON Schema this file follows; Workit writes it and keeps your value."),
      ...(body.properties as Record<string, JsonSchema>),
    },
    ...(Object.keys(all).length ? { definitions: all } : {}),
  };
};

const PRINT_WIDTH = 100;

/** JSON in the repository formatter's layout: objects expanded, scalar lists on one line when they fit. */
const printJson = (value: unknown, indent: string, prefix: number): string => {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((item) => item === null || typeof item !== "object")) {
      const flat = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (prefix + flat.length + 1 <= PRINT_WIDTH) return flat;
    }
    const items = value.map((item) => `${inner}${printJson(item, inner, inner.length)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const lines = entries.map(([key, item]) => {
      const head = `${inner}${JSON.stringify(key)}: `;
      return `${head}${printJson(item, inner, head.length)}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

/** The committed text of one schema file. */
export const renderConfigSchema = (file: ConfigSchemaFile): string =>
  `${printJson(configJsonSchema(file), "", 0)}\n`;

export type SchemaIssue = { path: string; message: string };

/** The JSON Schema keywords validateConfigSchema understands; annotations are ignored. */
export const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "title",
  "description",
  "default",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "oneOf",
]);

const typeOf = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;

const typeMatches = (expected: unknown, value: unknown): boolean => {
  const actual = typeOf(value);
  return (Array.isArray(expected) ? expected : [expected]).some(
    (type) => type === actual || (type === "number" && actual === "integer"),
  );
};

const childPath = (base: string, key: string | number): string =>
  typeof key === "number"
    ? `${base}[${key}]`
    : /^[A-Za-z_$][\w$-]*$/u.test(key)
      ? base
        ? `${base}.${key}`
        : key
      : `${base}[${JSON.stringify(key)}]`;

const describeForm = (schema: JsonSchema): string => {
  if (Array.isArray(schema.enum)) return schema.enum.join("|");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (typeof schema.description === "string")
    return schema.description
      .replace(/^\p{Lu}/u, (first) => first.toLowerCase())
      .replace(/\.$/u, "");
  if (Array.isArray(schema.anyOf))
    return (schema.anyOf as JsonSchema[]).map(describeForm).join(", ");
  const type = Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type ?? "any");
  return schema.pattern ? `a ${type} matching ${String(schema.pattern)}` : `a ${type}`;
};

const check = (
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  at: string,
  out: SchemaIssue[],
): void => {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace(/^#\/definitions\//u, "");
    const target = (root.definitions as Record<string, JsonSchema> | undefined)?.[name];
    if (!target) throw new Error(`unresolved $ref ${schema.$ref}`);
    return check(root, target, value, at, out);
  }
  const issue = (message: string): void => {
    out.push({ path: at || "(root)", message });
  };
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (branches) {
    const results = branches.map((branch) => {
      const found: SchemaIssue[] = [];
      check(root, branch, value, at, found);
      return { branch, found };
    });
    if (results.some((result) => result.found.length === 0)) return;
    const sameType = results.filter(
      (result) => result.branch.type !== undefined && typeMatches(result.branch.type, value),
    );
    if (sameType.length === 1 && ["object", "array"].includes(typeOf(value)))
      out.push(...sameType[0].found);
    else issue(`${JSON.stringify(value)} is not ${describeForm({ anyOf: branches })}`);
    return;
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value))
    return issue(`expected ${describeForm({ type: schema.type })}, got ${typeOf(value)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return issue(`${JSON.stringify(value)} is not one of ${schema.enum.join("|")}`);
  if (schema.const !== undefined && schema.const !== value)
    return issue(`${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      issue(`must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      issue(`must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      issue(
        typeof schema.description === "string"
          ? `${JSON.stringify(value)} is not ${describeForm(schema)}`
          : `${JSON.stringify(value)} does not match ${schema.pattern}`,
      );
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      issue(`must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      issue(`must be at most ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      issue(`must be above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum)
      issue(`must be below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      issue(`must have at least ${schema.minItems} entries`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      issue(`must have at most ${schema.maxItems} entries`);
    if (schema.items && typeof schema.items === "object")
      value.forEach((item, index) =>
        check(root, schema.items as JsonSchema, item, childPath(at, index), out),
      );
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[])
      if (!Object.hasOwn(record, key)) issue(`missing required key ${JSON.stringify(key)}`);
    for (const [key, child] of Object.entries(record)) {
      const where = childPath(at, key);
      if (schema.propertyNames) check(root, schema.propertyNames as JsonSchema, key, where, out);
      if (Object.hasOwn(properties, key)) check(root, properties[key], child, where, out);
      else if (schema.additionalProperties === false)
        out.push({ path: where, message: `unknown key ${JSON.stringify(key)}` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        check(root, schema.additionalProperties as JsonSchema, child, where, out);
    }
  }
};

/** Where `value` breaks `schema`: each bad value's JSON path and why. */
export const validateConfigSchema = (schema: JsonSchema, value: unknown): SchemaIssue[] => {
  const out: SchemaIssue[] = [];
  check(schema, schema, value, "", out);
  return out;
};

/** Where a parsed config file breaks its published schema. */
export const configSchemaIssues = (file: ConfigSchemaFile, value: unknown): SchemaIssue[] =>
  validateConfigSchema(configJsonSchema(file), value);
