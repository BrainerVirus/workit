import { expect, test } from "bun:test";
import path from "node:path";
import { skillsRoot } from "@/packages/workit-opencode/src/shared/assets";

test("Given the source checkout (an OpenCode local pin), Then skills resolve to the canonical core skills, never a stale generated copy", () => {
  expect(skillsRoot()).toBe(path.resolve(import.meta.dir, "../../packages/workit-core/skills"));
});
