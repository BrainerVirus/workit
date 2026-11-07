import { expect, test } from "bun:test";
import { findSubcommand, findVerb } from "@/packages/workit-cli/src/verbs/registry";

test("git add is a registered alias of git stage", () => {
  const git = findVerb("git");
  expect(git && findSubcommand(git, "add")?.name).toBe("stage");
  expect(git && findSubcommand(git, "stage")?.name).toBe("stage");
});
