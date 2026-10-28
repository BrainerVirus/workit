import { expect, test } from "bun:test";
import { hookRefusal } from "@/packages/workit-core/src/git/ops";

test("Given commitlint's header-max-length output, When summarised, Then one line names the rule, limit and length", () => {
  const output = [
    "🥊 commit-msg",
    "⧗   input: feat: x",
    "✖   header must not be longer than 100 characters, current length is 104 [header-max-length]",
    "✖   found 1 problems, 0 warnings",
  ].join("\n");
  expect(hookRefusal(output)).toBe(
    "commit refused by commit-msg hook: header-max-length 100 (got 104)",
  );
});

test("Given a hook output naming no rule, When summarised, Then there is no summary line", () => {
  expect(hookRefusal("husky - pre-commit hook exited with code 1")).toBeNull();
});
