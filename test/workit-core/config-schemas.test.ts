// Config JSON Schemas (#614): generated from the zod schemas, committed under
// packages/workit-core/schemas/, stricter than the lenient readers so an
// editor underlines what Workit would warn about and ignore.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import {
  CONFIG_SCHEMA_FILES,
  SCHEMA_KEYWORDS,
  configJsonSchema,
  configSchemaIssues,
  renderConfigSchema,
  withSchemaRef,
} from "@/packages/workit-core/src/core/config-schemas";
import { validateWorkspacesDocument } from "@/packages/workit-core/src/core/workspaces";

const SCHEMAS_DIR = path.join(import.meta.dir, "../../packages/workit-core/schemas");
const URL = "https://unpkg.com/@brainervirus/workit-core/schemas/workspaces.json";

type Json = Record<string, any>;
const workspaces: Json = configJsonSchema("workspaces.json");
const entry = workspaces.properties.workspaces.items as Json;
const field = (name: string): Json => entry.properties[name];

const VALID = {
  $schema: URL,
  models: { roles: { verifier: "sonnet", implementer: { hard: { claude_code: "opus" } } } },
  workspaces: [
    {
      name: "work",
      glob: "/home/you/work/**",
      vcs: { provider: "gitlab", account: "me", host: "git.example.com" },
      issues: { provider: "youtrack", link: true, relation: "refs" },
      branchPolicy: { preset: "gitflow", developBranch: "develop" },
      commitPolicy: { preset: "conventional" },
      autonomy: { push: true, pr: "verified", merge: false },
      defaultEndpoint: "pr",
      verification: "independent",
      delegation: "lead-orchestrates",
      changelog: "update",
      docs: "when-user-facing",
      changelogPath: ["packages/*/CHANGELOG.md", "CHANGELOG.md"],
      prTemplate: ".github/pull_request_template.md",
      releaseNotes: "review",
      fanout: { tierModels: { hard: { claude_code: "opus" }, mundane: "haiku" } },
      resources: { slots: 2, scope: false, memoryMax: "40%" },
      releaseTracks: {
        main: {
          productionBranch: "main",
          integrationBranch: "develop",
          releaseNotes: "off",
          versionSource: { kind: "package-json", path: "package.json", field: "version" },
        },
      },
    },
  ],
};

/** Every schema object nested in `schema`, the root included. */
const subschemas = (schema: unknown): Json[] => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Json;
  const children: unknown[] = [];
  for (const key of ["properties", "definitions"])
    if (node[key]) children.push(...Object.values(node[key]));
  for (const key of ["items", "additionalProperties", "propertyNames"])
    if (node[key] && typeof node[key] === "object") children.push(node[key]);
  for (const key of ["anyOf", "oneOf"]) if (node[key]) children.push(...node[key]);
  return [node, ...children.flatMap(subschemas)];
};

describe("committed schemas", () => {
  test.each([...CONFIG_SCHEMA_FILES])(
    "Given the zod schemas, When %s is rendered, Then it matches the committed file (bun run write:schemas)",
    (file) => {
      expect(readFileSync(path.join(SCHEMAS_DIR, file), "utf8")).toBe(renderConfigSchema(file));
    },
  );

  test.each([...CONFIG_SCHEMA_FILES])(
    "Given %s's schema, Then it compiles as draft-07, sits at its published URL and uses only keywords doctor's validator knows",
    (file) => {
      const schema: Json = configJsonSchema(file);
      expect(schema.$id).toBe(`https://unpkg.com/@brainervirus/workit-core/schemas/${file}`);
      expect(() => new Ajv({ strict: false }).compile(schema)).not.toThrow();
      const used = new Set(subschemas(schema).flatMap((node) => Object.keys(node)));
      expect([...used].filter((keyword) => !SCHEMA_KEYWORDS.has(keyword))).toEqual([]);
    },
  );

  test("the published package ships the schemas directory", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(SCHEMAS_DIR, "..", "package.json"), "utf8"),
    ) as Json;
    expect(pkg.files).toContain("schemas/");
  });
});

describe("workspaces.json schema", () => {
  test("Given the lenient fields, Then the editor schema enumerates their allowed values with descriptions", () => {
    expect(field("changelog").enum).toEqual(["off", "update", "create"]);
    expect(field("docs").enum).toEqual(["off", "when-user-facing"]);
    expect(field("releaseNotes").enum).toEqual(["auto", "off", "review"]);
    expect(field("defaultEndpoint").enum).toEqual(["commit", "pr", "green", "merged"]);
    expect(field("delegation").enum).toEqual(["inline-first", "lead-orchestrates"]);
    expect(field("verification").enum).toEqual(["proportional", "self", "independent"]);
    expect(field("prTemplate").anyOf[0].enum).toEqual(["auto", "repo", "workit"]);
    expect(field("autonomy").properties.merge.anyOf).toEqual([
      { type: "boolean" },
      { type: "string", const: "verified" },
    ]);
    expect(field("issues").properties.relation.enum).toEqual(["closes", "refs"]);
    expect(field("branchPolicy").properties.preset.enum).toEqual([
      "gitflow",
      "github-flow",
      "trunk-based",
      "custom",
    ]);
    for (const name of [
      "changelog",
      "docs",
      "changelogPath",
      "prTemplate",
      "releaseNotes",
      "autonomy",
      "verification",
      "defaultEndpoint",
      "delegation",
      "remotes",
      "trailers",
    ])
      expect(field(name).description?.length ?? 0).toBeGreaterThan(20);
  });

  test("Given a valid file with $schema, When validated, Then the editor schema, ajv and the runtime reader all accept it", () => {
    expect(configSchemaIssues("workspaces.json", VALID)).toEqual([]);
    expect(new Ajv({ strict: false }).validate(workspaces, VALID)).toBe(true);
    expect(validateWorkspacesDocument(VALID, "workspaces.json").status).toBe("valid");
  });

  test("Given an unknown key and bad values, When validated, Then each is an error at its JSON path", () => {
    const bad = structuredClone(VALID) as Json;
    Object.assign(bad.workspaces[0], {
      bogus: 1,
      changelog: "sometimes",
      prTemplate: "notes.txt",
      changelogPath: ["../outside/CHANGELOG.md"],
    });
    bad.workspaces[0].autonomy.push = "yes";
    bad.workspaces[0].releaseTracks.main.releaseNotes = "draft";
    const paths = configSchemaIssues("workspaces.json", bad).map((issue) => issue.path);
    expect(paths.toSorted()).toEqual(
      [
        "workspaces[0].autonomy.push",
        "workspaces[0].bogus",
        "workspaces[0].changelog",
        "workspaces[0].changelogPath[0]",
        "workspaces[0].prTemplate",
        "workspaces[0].releaseTracks.main.releaseNotes",
      ].toSorted(),
    );
    expect(new Ajv({ strict: false }).validate(workspaces, bad)).toBe(false);
    expect(configSchemaIssues("workspaces.json", bad)).toContainEqual({
      path: "workspaces[0].changelog",
      message: '"sometimes" is not one of off|update|create',
    });
  });

  test("Given a value a newer Workit added, When the runtime reads it, Then it stays lenient while the editor flags it", () => {
    const newer = structuredClone(VALID) as Json;
    newer.workspaces[0].changelog = "future-mode";
    expect(validateWorkspacesDocument(newer, "workspaces.json").status).toBe("valid");
    expect(configSchemaIssues("workspaces.json", newer).map((issue) => issue.path)).toEqual([
      "workspaces[0].changelog",
    ]);
  });

  test("Given models.roles, When a role, tier or host is unknown, Then the editor flags its path", () => {
    const doc = {
      models: {
        roles: { implementer: { epic: "opus" }, verifier: { claude_desktop: "x" }, poet: "x" },
      },
    };
    expect(
      configSchemaIssues("workspaces.json", doc)
        .map((issue) => issue.path)
        .toSorted(),
    ).toEqual([
      "models.roles.implementer.epic",
      "models.roles.poet",
      "models.roles.verifier.claude_desktop",
    ]);
  });
});

describe("the other config files", () => {
  test("Given config.json, When a key is unknown or a preset is bad, Then the path is named", () => {
    expect(
      configSchemaIssues("config.json", {
        $schema: "x",
        locale: "en",
        updates: "auto",
        branchPolicy: { preset: "gitflow", allowed: [], protected: ["main"] },
      }),
    ).toEqual([]);
    expect(
      configSchemaIssues("config.json", {
        updates: "sometimes",
        commitPolicy: { preset: "x" },
      }).map((issue) => issue.path),
    ).toEqual(["updates", "commitPolicy.preset"]);
  });

  test("Given vcs.json and youtrack.json from older setups, When they carry keys the schema does not list, Then they still validate", () => {
    expect(
      configSchemaIssues("vcs.json", {
        provider: "gitlab",
        gitlab: { host: "gitlab.com", tokenFile: "/t", legacy: true },
        extra: 1,
      }),
    ).toEqual([]);
    expect(configSchemaIssues("vcs.json", { provider: "bitbucket" })[0]?.path).toBe("provider");
    expect(
      configSchemaIssues("youtrack.json", { baseUrl: "https://yt.example", custom: "kept" }),
    ).toEqual([]);
  });
});

describe("withSchemaRef", () => {
  test("Given a document without $schema, Then the published URL is added as the first key", () => {
    const out = withSchemaRef("workspaces.json", { workspaces: [] });
    expect(Object.keys(out)).toEqual(["$schema", "workspaces"]);
    expect(out.$schema).toBe(URL);
  });

  test("Given a user's own $schema, Then it is kept and moved first", () => {
    const out = withSchemaRef("vcs.json", { provider: "github", $schema: "./my-schema.json" });
    expect(Object.keys(out)).toEqual(["$schema", "provider"]);
    expect(out.$schema).toBe("./my-schema.json");
  });
});
