import { expect, test } from "bun:test";
import { requireConfirmed } from "@/packages/workit-opencode/src/shared/repo-result";

// workit_init_apply forwards raw tool input; only the boolean `true` confirms.
test("requireConfirmed accepts only confirmed: true", () => {
  expect(requireConfirmed(true)).toBeNull();
  for (const confirmed of ["false", "no", "true", 1, {}] as unknown as boolean[]) {
    expect(requireConfirmed(confirmed), JSON.stringify(confirmed)).toContain(
      "confirmed: true required",
    );
  }
});
