import { expect, test } from "bun:test";
import {
  canonicalJson,
  operationJsonSchema,
  operationSchemas,
  parseOperation,
} from "../../packages/workit-core/src/core/task-contract";
import { operationCorpus, taskStartRequest } from "./task-fixtures";

const resultDataOrIssues = (result: {
  success: boolean;
  data?: unknown;
  error?: { issues: unknown[] };
}) =>
  result.success
    ? result.data
    : result.error?.issues.map(({ path, code, message }: any) => ({ path, code, message }));

test("rejects unknown payload fields instead of stripping them", () => {
  const result = parseOperation("task", { ...taskStartRequest(), surprise: true });
  expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  if (!result.ok) expect(result.details.fields?.[0]?.path).toBe("surprise");
});

test("canonical JSON sorts objects but preserves array and string bytes", () => {
  expect(canonicalJson({ z: ["e\u0301", "é"], a: 1 })).toBe('{"a":1,"z":["é","é"]}');
});

test("compiled operation parsing preserves the canonical schema result", () => {
  for (const fixture of operationCorpus()) {
    const raw = operationSchemas[fixture.family].safeParse(fixture.input);
    const compiled = parseOperation(fixture.family, fixture.input);
    expect(
      resultDataOrIssues(
        compiled.ok
          ? { success: true, data: compiled.data }
          : { success: false, error: { issues: compiled.details.fields ?? [] } },
      ),
    ).toEqual(resultDataOrIssues(raw));
  }
});

test("MCP schemas are derived as JSON Schema 2020-12", () => {
  expect(operationJsonSchema("task").$schema).toBe("https://json-schema.org/draft/2020-12/schema");
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
});
