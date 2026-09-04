import { expect, test } from "bun:test";
import {
  canonicalJson,
  candidateSchema,
  candidateDigest,
  requirementId,
  signalSchema,
  utcSchema,
  operationJsonSchema,
  operationSchemas,
  parseOperation,
} from "../../packages/workit-core/src/core/task-contract";
import { id, operationCorpus, taskStartRequest } from "./task-fixtures";

const normalizedIssues = (issues: any[]) =>
  issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? issue.keys.join(".") : issue.path.join("."),
    reason: issue.message,
  }));

test("rejects unknown payload fields instead of stripping them", () => {
  const result = parseOperation("task", { ...taskStartRequest(), surprise: true });
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  if (!result.ok) expect(result.details.fields?.[0]?.path).toBe("surprise");
});

test("canonical JSON sorts objects but preserves array and string bytes", () => {
  expect(canonicalJson({ z: ["e\u0301", "é"], a: 1 })).toBe('{"a":1,"z":["é","é"]}');
});

test("compiled operation parsing preserves the canonical schema result", () => {
  const corpus = [
    ...operationCorpus(),
    ...operationCorpus()
      .filter(
        (fixture, index, all) =>
          all.findIndex((other) => other.family === fixture.family) === index,
      )
      .map((fixture) => ({ ...fixture, input: { ...fixture.input, action: "unknown" } as never })),
  ];
  for (const fixture of corpus) {
    const raw = operationSchemas[fixture.family].safeParse(fixture.input);
    const compiled = parseOperation(fixture.family, fixture.input);
    if (raw.success) expect(compiled).toMatchObject({ ok: true, data: raw.data });
    else {
      expect(compiled.ok).toBe(false);
      if (!compiled.ok) expect(compiled.details.fields).toEqual(normalizedIssues(raw.error.issues));
    }
  }
});

test("MCP schemas are derived as JSON Schema 2020-12", () => {
  expect(operationJsonSchema("task").$schema).toBe("https://json-schema.org/draft/2020-12/schema");
});

test("unsupported schema versions use the stable unsupported_version code", () => {
  expect(parseOperation("task", { ...taskStartRequest(), schemaVersion: 2 })).toMatchObject({
    ok: false,
    code: "unsupported_version",
  });
});

test("candidate files enforce path, digest, and executable invariants", () => {
  const candidate = {
    id: "a".repeat(64),
    scope: { description: "x", paths: ["."], exclusions: [] },
    completeness: "known",
    files: [{ path: "../escape", kind: "absent", digest: "a".repeat(64), executable: false }],
    environment: [],
    head: null,
  };
  expect(candidateSchema.safeParse(candidate).success).toBe(false);
  for (const file of [
    { path: "a", kind: "absent", digest: "a".repeat(64), executable: false },
    { path: "a", kind: "file", digest: null, executable: true },
    { path: "a", kind: "symlink", digest: "a".repeat(64), executable: true },
  ]) {
    expect(candidateSchema.safeParse({ ...candidate, files: [file] }).success).toBe(false);
  }
});

test("signals require unknown values to use unknown basis and booleans to use known basis", () => {
  expect(
    signalSchema.safeParse({ value: "unknown", basis: "inferred", reason: "x", refs: [] }).success,
  ).toBe(false);
  expect(
    signalSchema.safeParse({ value: true, basis: "unknown", reason: "x", refs: [] }).success,
  ).toBe(false);
});

test("workspace-sensitive mutations require both revisions", () => {
  const common = { schemaVersion: 1, taskId: id, expectedRevision: id };
  const report = {
    ...common,
    action: "report",
    workerId: id,
    report: { outcome: "completed", summary: "x", evidenceIds: [], findingIds: [] },
  };
  expect(parseOperation("worker", report).ok).toBe(false);
  expect(parseOperation("worker", { ...report, expectedWorkspaceRevision: id }).ok).toBe(true);
  const release = {
    schemaVersion: 1,
    action: "release",
    taskId: id,
    expectedWorkspaceRevision: id,
    reason: "x",
  };
  expect(parseOperation("writer", release).ok).toBe(false);
  expect(parseOperation("writer", { ...release, expectedRevision: id }).ok).toBe(true);
});

test("canonical JSON rejects invalid Unicode keys and impossible timestamps", () => {
  expect(() => canonicalJson(Object.fromEntries([["\ud800", 1]]))).toThrow();
  expect(utcSchema.safeParse("2024-02-30T00:00:00Z").success).toBe(false);
});

test("candidate and requirement digests ignore unordered scope and inventory order", () => {
  const candidate = {
    id: "a".repeat(64),
    scope: { description: "x", paths: ["b", "a"], exclusions: ["z", "y"] },
    completeness: "known" as const,
    files: [
      { path: "b", kind: "file" as const, digest: "b".repeat(64), executable: false },
      { path: "a", kind: "symlink" as const, digest: "c".repeat(64), executable: null },
    ],
    environment: [
      { name: "B", value: "2", refs: [] },
      { name: "A", value: "1", refs: [] },
    ],
    head: null,
  };
  const reordered = {
    ...candidate,
    scope: { ...candidate.scope, paths: ["a", "b"], exclusions: ["y", "z"] },
    files: [...candidate.files].reverse(),
    environment: [...candidate.environment].reverse(),
  };
  expect(candidateDigest(candidate)).toBe(candidateDigest(reordered));
  expect(
    requirementId({
      ruleId: "rule",
      scope: candidate.scope,
      satisfaction: "yes",
      before: "write",
      dependentAction: null,
    }),
  ).toBe(
    requirementId({
      ruleId: "rule",
      scope: reordered.scope,
      satisfaction: "yes",
      before: "write",
      dependentAction: null,
    }),
  );
});

test("candidate identity ordering is independent of localeCompare", () => {
  const candidate = {
    id: "a".repeat(64),
    scope: { description: "x", paths: ["ä", "z"], exclusions: [] },
    completeness: "known" as const,
    files: [
      { path: "ä", kind: "file" as const, digest: "a".repeat(64), executable: false },
      { path: "z", kind: "file" as const, digest: "b".repeat(64), executable: false },
    ],
    environment: [
      { name: "ä", value: "1", refs: [] },
      { name: "z", value: "2", refs: [] },
    ],
    head: null,
  };
  const localeCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error("locale-sensitive ordering is not allowed");
  };
  try {
    expect(candidateDigest(candidate)).toBeString();
  } finally {
    String.prototype.localeCompare = localeCompare;
  }
});

test("canonical JSON rejects arrays with missing indices", () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  expect(() => canonicalJson(sparse)).toThrow("sparse array");
});

test("rejects malformed versions, paths, numbers, Unicode, duplicates, UUIDs, digests, and timestamps", () => {
  const base = taskStartRequest();
  for (const input of [
    { ...base, schemaVersion: 2 },
    { ...base, intent: { ...base.intent, scope: { ...base.intent.scope, paths: ["/tmp"] } } },
    { ...base, intent: { ...base.intent, scope: { ...base.intent.scope, paths: ["../escape"] } } },
    { ...base, intent: { ...base.intent, objective: Number.MAX_SAFE_INTEGER + 1 } },
    { ...base, intent: { ...base.intent, objective: "\ud800" } },
    {
      ...base,
      intent: { ...base.intent, authorityRefs: [{ kind: "file", path: "a", digest: "bad" }] },
    },
  ]) {
    expect(parseOperation("task", input).ok).toBe(false);
  }
  expect(utcSchema.safeParse("2024-13-01T00:00:00Z").success).toBe(false);
  expect(utcSchema.safeParse("2024-01-01T24:00:00Z").success).toBe(false);
  expect(
    candidateSchema.safeParse({
      id: "a".repeat(64),
      scope: { description: "x", paths: ["."], exclusions: [] },
      completeness: "known",
      files: [],
      environment: [
        { name: "DUPLICATE", value: "1", refs: [] },
        { name: "DUPLICATE", value: "2", refs: [] },
      ],
      head: null,
    }).success,
  ).toBe(false);
});
