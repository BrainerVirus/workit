import { expect, test } from "bun:test";
import { triageSignals, triageTier } from "@/packages/workit-core/src/core/policy-resolver";
import { scopeCovers } from "@/packages/workit-core/src/core/task-contract";

test("triageTier routes large work to spec-plan", () => {
  const base = {
    newOrChangedBehavior: false,
    ambiguityOpen: false,
    crossContract: false,
    subsystems: 1,
    packagesTouched: 1,
    steps: 1,
  };
  expect(triageTier({ ...base, newOrChangedBehavior: true })).toBe("spec-plan");
  expect(triageTier({ ...base, ambiguityOpen: true })).toBe("spec-plan");
  expect(triageTier({ ...base, crossContract: true })).toBe("spec-plan");
  expect(triageTier({ ...base, subsystems: 3 })).toBe("spec-plan");
  expect(triageTier({ ...base, packagesTouched: 2 })).toBe("spec-plan");
});

test("triageTier routes medium work to plan-only and small work to neither", () => {
  const base = {
    newOrChangedBehavior: false,
    ambiguityOpen: false,
    crossContract: false,
    subsystems: 1,
    packagesTouched: 1,
    steps: 1,
  };
  expect(triageTier({ ...base, steps: 2 })).toBe("plan-only");
  expect(triageTier({ ...base, steps: 8 })).toBe("plan-only");
  expect(triageTier({ ...base, steps: 20 })).toBe("plan-only");
  expect(triageTier(base)).toBe("neither");
});

test("triageSignals maps tiers to assessor signal values", () => {
  expect(triageSignals("spec-plan")).toEqual({
    durableAgreementNeeded: true,
    coordinationPlanNeeded: true,
  });
  expect(triageSignals("plan-only")).toEqual({
    durableAgreementNeeded: false,
    coordinationPlanNeeded: true,
  });
  expect(triageSignals("neither")).toEqual({
    durableAgreementNeeded: false,
    coordinationPlanNeeded: false,
  });
});

test("scopeCovers normalizes trailing slashes so docs/ covers docs/x", () => {
  const outer = {
    description: "batch",
    paths: [".cursor-plugin", "docs", "packages", "test"],
    exclusions: ["node_modules", ".git", "dist"],
  };
  const slashed = { ...outer, paths: [".cursor-plugin/", "docs/", "packages/", "test/"] };
  const file = { description: "", paths: ["docs/v1-preclose-batch/spec.md"], exclusions: [] };
  expect(scopeCovers(outer, file)).toBe(true);
  expect(scopeCovers(slashed, file)).toBe(true);
  expect(scopeCovers(slashed, { description: "", paths: ["node_modules/x"], exclusions: [] })).toBe(
    false,
  );
});
