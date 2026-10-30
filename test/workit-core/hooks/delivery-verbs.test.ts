import { expect, test } from "bun:test";
import { isAllowedWorkitCall } from "@/packages/workit-core/src/hooks/delivery-verbs";

test("Given release notes approve or grant set/raise, When isAllowedWorkitCall sees them, Then it returns false", () => {
  expect(isAllowedWorkitCall(["workit", "release", "notes", "approve", "1.0.0"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "--cwd", "/w", "release", "notes", "approve", "1"])).toBe(
    false,
  );
  expect(isAllowedWorkitCall(["workit", "release", "--json", "notes", "approve"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "grant", "set", "ws", "merge"])).toBe(false);
  expect(isAllowedWorkitCall(["workit", "grant", "raise", "ws"])).toBe(false);
});

test("Given other release calls, When isAllowedWorkitCall sees them, Then they stay allowed", () => {
  expect(isAllowedWorkitCall(["workit", "release", "notes", "show", "1.0.0"])).toBe(true);
  expect(isAllowedWorkitCall(["workit", "release", "check"])).toBe(true);
  expect(isAllowedWorkitCall(["workit", "pr", "list", "--", "approve"])).toBe(true);
});
