// #424: policy_unavailable ("repair or select a valid workspace policy") is for
// config the user can repair. A TypeError/ReferenceError from the runtime
// itself propagates to the hook's failure decision instead.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateBranchNameFor,
  validateCommitMessageFor,
} from "@/packages/workit-core/src/core/branch";
import * as config from "@/packages/workit-core/src/core/config";

let dir: string;
const previousXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wk-policy-unavailable-"));
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  mkdirSync(path.join(dir, "config", "workit"), { recursive: true });
});
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(dir, { recursive: true, force: true });
});

test("Given an unparsable workspaces.json, When a branch or commit is validated, Then policy_unavailable", () => {
  writeFileSync(path.join(dir, "config", "workit", "workspaces.json"), "{not json");
  const branch = validateBranchNameFor(dir, "feature/x");
  expect(branch.ok).toBe(false);
  if (!branch.ok) expect(branch.rule).toBe("policy_unavailable");
  const commit = validateCommitMessageFor(dir, "feat: x");
  expect(commit.ok).toBe(false);
  if (!commit.ok) expect(commit.rule).toBe("policy_unavailable");
});

for (const make of [() => new TypeError("x is not a function"), () => new ReferenceError("y")])
  test(`Given the resolver throws ${make().name}, When a branch or commit is validated, Then it propagates`, () => {
    const spy = spyOn(config, "readConfig").mockImplementation(() => {
      throw make();
    });
    try {
      expect(() => validateBranchNameFor(dir, "feature/x")).toThrow(
        make().name === "TypeError" ? TypeError : ReferenceError,
      );
      expect(() => validateCommitMessageFor(dir, "feat: x")).toThrow(
        make().name === "TypeError" ? TypeError : ReferenceError,
      );
    } finally {
      spy.mockRestore();
    }
  });
