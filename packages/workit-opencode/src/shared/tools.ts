import {
  OPERATION_FAMILIES,
  OPERATION_SCHEMA_DEPTH,
  boundedOperationJsonSchema,
  externalActionHelp,
  type OperationFamily,
} from "@brainervirus/workit-core/src/core";

/** One V2 tool registration: exact name, description, and JSON Schema input.
 * The catalog is shared by every non-SDK V2 surface (and future hosts) so the
 * 10 names and shapes cannot drift per adapter; V1 keeps its Zod-typed
 * registrations until its support window ends. */
export type WorkitToolSpec = {
  name: string;
  description: string;
  input: Record<string, unknown>;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const WORKIT_EXTERNAL_ACTION_OPERATIONS = [
  "git.branch_setup",
  "git.commit",
  "git.push",
  "hosting.pull_request",
  "hosting.merge",
  "youtrack.update",
  "youtrack.time",
  "youtrack.meeting",
  "changelog.apply",
  "context.read",
] as const;

const familyTools = OPERATION_FAMILIES.map((family): WorkitToolSpec => ({
  name: `workit_${family}`,
  description: `Workit ${family} operations backed by the shared task contract.`,
  input: { type: "object", ...boundedOperationJsonSchema(family, OPERATION_SCHEMA_DEPTH) },
}));

/** The exact 10 registered Workit tool names, in registration order. */
export const WORKIT_TOOL_NAMES: readonly string[] = [
  ...familyTools.map((tool) => tool.name),
  "workit_external_action",
  "workit_init_apply",
];

export const WORKIT_TOOL_CATALOG: readonly WorkitToolSpec[] = [
  ...familyTools,
  {
    name: "workit_external_action",
    description: `Run one fixed optional action. ${externalActionHelp}`,
    input: objectSchema(
      {
        operation: {
          type: "string",
          enum: [...WORKIT_EXTERNAL_ACTION_OPERATIONS],
          description: "Fixed optional action to run.",
        },
        payload: {
          type: "object",
          description: "Operation-specific payload; Workit validates it.",
          additionalProperties: true,
        },
      },
      ["operation", "payload"],
    ),
  },
  {
    name: "workit_init_apply",
    description: "Apply a confirmed toolkit initialization action",
    input: objectSchema(
      {
        confirmed: { type: "boolean" },
        action: {
          type: "string",
          enum: [
            "youtrack_scaffold",
            "youtrack_json",
            "youtrack_token_placeholder",
            "vcs_scaffold",
            "config",
            "gitignore",
            "hygiene",
            "branch_policy",
          ],
        },
        base_url: { type: "string" },
        default_mention: { type: "string" },
        meeting_issue: { type: "string" },
        vcs_provider: { type: "string", enum: ["gitlab", "github"] },
        vcs_target_branch: { type: "string" },
        name: { type: "string" },
        develop_branch: { type: "string" },
        integration: { type: "string", enum: ["pr", "merge"] },
        locale: { type: "string" },
        locale_options: { type: "array", items: { type: "string" } },
        timezone: { type: "string" },
        branch_policy_preset: {
          type: "string",
          enum: ["gitflow", "github-flow", "trunk-based", "custom"],
        },
        branch_policy_allowed: { type: "array", items: { type: "string" } },
        branch_policy_protected: { type: "array", items: { type: "string" } },
        include_open_source: { type: "boolean" },
      },
      ["confirmed", "action"],
    ),
  },
];

export const workitFamilyOf = (toolName: string): OperationFamily | null => {
  for (const family of OPERATION_FAMILIES) if (toolName === `workit_${family}`) return family;
  return null;
};
