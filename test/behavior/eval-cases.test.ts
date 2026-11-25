// Every committed bench case must load, compile its regexes and build its
// scaffold before it can spend a model run (docs/agents/eval.md).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { forLeg, legModels, loadCases, type EvalCase } from "@/scripts/eval/cases";
import { providersFor } from "@/scripts/eval/opencode";
import { makeWorld, promptFor } from "@/scripts/eval/scaffold";

const CASES = loadCases(path.join(import.meta.dir, "..", "..", "evals", "cases"));

test("Given the committed cases, Then there are smoke cases and every source names a real failure", () => {
  expect(CASES.filter((spec) => spec.tier === "smoke").length).toBeGreaterThan(0);
  for (const spec of CASES)
    expect(spec.source, spec.id).toMatch(/retro|#\d+|test\/behavior|evals\//);
});

const LEGS = [
  ["claude-code", legModels("claude-code", "claude-haiku-5-5")],
  [
    "opencode",
    legModels("opencode", "deepseek-v4.1-flash", providersFor("deepseek-v4.1-flash")[1]),
  ],
] as const;

test.each(
  CASES.flatMap((spec) =>
    LEGS.map(([host, models]) => [spec.id, host, forLeg(spec, models)] as const),
  ),
)(
  "Given case %s on %s, Then its patterns compile and its scaffold builds with every placeholder filled",
  (_id, _host, spec) => {
    expect(JSON.stringify(spec)).not.toMatch(/\{\{(model|roleModel)\}\}/);
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

test("Given a case with permissionMode bypassPermissions, Then loading the cases refuses it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-eval-cases-"));
  try {
    writeFileSync(
      path.join(dir, "bad.json"),
      JSON.stringify({
        id: "bad",
        tier: "full",
        prompt: "x",
        source: "#1",
        permissionMode: "bypassPermissions",
      }),
    );
    expect(() => loadCases(dir)).toThrow("permissionMode must be one of");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [{ forge: "gitlab" }, "scaffold.forge must be github"],
  [{ forge: "github", unborn: true }, "scaffold.forge needs a commit"],
])("Given a case with scaffold %j, Then loading the cases refuses it", (scaffold, error) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-eval-cases-"));
  try {
    writeFileSync(
      path.join(dir, "bad.json"),
      JSON.stringify({ id: "bad", tier: "full", prompt: "x", source: "#1", scaffold }),
    );
    expect(() => loadCases(dir)).toThrow(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Given each leg, Then {{model}} is a model the leg runs and {{roleModel}} another of its config", () => {
  expect(legModels("claude-code", "claude-haiku-5-5")).toEqual({
    model: "haiku",
    roleModel: "opus",
  });
  expect(legModels("claude-code", "opus")).toEqual({ model: "opus", roleModel: "sonnet" });
  const [free, go] = providersFor("deepseek-v4.1-flash");
  expect(legModels("opencode", "deepseek-v4.1-flash", free)).toEqual({
    model: "opencode/deepseek-v4.1-flash-free",
    roleModel: "opencode-go/deepseek-v4.1-flash",
  });
  expect(legModels("opencode", "deepseek-v4.1-flash", go)).toEqual({
    model: "opencode-go/deepseek-v4.1-flash",
    roleModel: "opencode/deepseek-v4.1-flash-free",
  });
});

test("Given a case with {{model}} and {{roleModel}}, When filled for a leg, Then the prompt and scaffold take the names and patterns the escaped names", () => {
  const spec: EvalCase = {
    id: "m",
    source: "#902",
    tier: "full",
    prompt: "spawn with model {{model}}",
    scaffold: { workspace: { models: { roles: { verifier: "{{roleModel}}" } } } },
    expect: { require: [{ tool: "Agent", pattern: "verifier[\\s\\S]*{{model}}", why: "w" }] },
  };
  const models = { model: "opencode-go/deepseek-v4.1-flash", roleModel: "opencode/x-free" };
  const filled = forLeg(spec, models);
  expect(filled.prompt).toBe("spawn with model opencode-go/deepseek-v4.1-flash");
  expect(filled.scaffold?.workspace?.models).toEqual({ roles: { verifier: "opencode/x-free" } });
  const [want] = filled.expect?.require ?? [];
  const pattern = new RegExp(want?.pattern ?? "");
  expect(pattern.test("verifier model opencode-go/deepseek-v4.1-flash")).toBe(true);
  expect(pattern.test("verifier model opencode-go/deepseek-v4x1-flash")).toBe(false);
  expect(spec.prompt).toBe("spawn with model {{model}}");
});

test.each(["spawn-user-model-override", "spawn-explore-user-model"])(
  "Given the committed case %s, Then it runs on both legs and the named model differs from the role default on each",
  (id) => {
    const spec = CASES.find((each) => each.id === id) as EvalCase;
    expect(spec.hosts).toBeUndefined();
    for (const [, models] of LEGS) {
      const filled = forLeg(spec, models);
      expect(filled.prompt).toContain(models.model);
      const roles = Object.values(
        (filled.scaffold?.workspace?.models?.roles ?? {}) as Record<string, string>,
      );
      expect(roles).toEqual([models.roleModel]);
      expect(models.roleModel).not.toBe(models.model);
    }
  },
);
