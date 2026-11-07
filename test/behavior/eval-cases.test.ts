// Every committed bench case must load, compile its regexes and build its
// scaffold before it can spend a model run (docs/agents/eval.md).
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { loadCases } from "@/scripts/eval/cases";
import { makeWorld, promptFor } from "@/scripts/eval/scaffold";

const CASES = loadCases(path.join(import.meta.dir, "..", "..", "evals", "cases"));

test("Given the committed cases, Then there are smoke cases and every source names a real failure", () => {
  expect(CASES.filter((spec) => spec.tier === "smoke").length).toBeGreaterThan(0);
  for (const spec of CASES)
    expect(spec.source, spec.id).toMatch(/retro|#\d+|test\/behavior|evals\//);
});

test.each(CASES.map((spec) => [spec.id, spec] as const))(
  "Given case %s, Then its patterns compile and its scaffold builds with every prompt path filled",
  (_id, spec) => {
    const patterns = [
      ...(spec.expect?.require ?? []),
      ...(spec.expect?.forbid ?? []),
      ...(spec.expect?.answer ?? []),
    ];
    for (const want of patterns)
      expect(
        () => new RegExp(want.pattern, "flags" in want ? want.flags : undefined),
      ).not.toThrow();
    const world = makeWorld(spec);
    try {
      expect(existsSync(path.join(world.repo, ".git"))).toBe(true);
      expect(promptFor(spec, world)).not.toMatch(/\{\{\w+\}\}/);
      if (spec.prompt.includes("{{worktree}}")) expect(world.worktree).not.toBeNull();
    } finally {
      rmSync(world.dir, { recursive: true, force: true });
    }
  },
);
