import { expect, test } from "bun:test";
import { withEnvelope } from "@/packages/workit-cli/src/task";
import { failure, success } from "@/packages/workit-core/src/core/task-contract";

// `workit task … --json` carries the envelope fields every other verb has,
// added beside the engine's own fields so no existing consumer breaks.

test("Given a successful task result, When it is printed as JSON, Then it gains code ok and keeps every engine field", () => {
  const result = success("r1", "w1", [{ id: "t" }]);
  const expected: Record<string, unknown> = { ...result, code: "ok" };
  expect(withEnvelope(result) as Record<string, unknown>).toEqual(expected);
});

test("Given a revision conflict or a busy lock, When it is printed as JSON, Then it keeps its engine code and gains an unblock", () => {
  for (const code of ["revision_conflict", "busy"] as const) {
    const result = failure(code, "x");
    const shown = withEnvelope(result);
    expect(shown).toMatchObject({ ...result, code });
    expect((shown as { unblock?: string }).unblock, code).toBeString();
  }
});

test("Given a failure with no command that fixes it, When it is printed as JSON, Then it is unchanged", () => {
  const result = failure("invalid_input", "taskId: expected lowercase UUID");
  expect(withEnvelope(result) as Record<string, unknown>).toEqual({ ...result });
});
