// S17 slim policy: four flat judgments in, derived requirements out.
import { expect, test } from "bun:test";
import {
  diffPolicy,
  resolvePolicy,
  type ResolverInput,
} from "@/packages/workit-core/src/core/policy-resolver";
import { judgeTokens, normalizeJudgment } from "@/packages/workit-core/src/core/policy/judgment";
import type { Constraint, Judgment } from "@/packages/workit-core/src/core/task-contract";
import { assessment, ref, scope } from "./task-fixtures";

const judgment = (overrides: Partial<Judgment> = {}): Judgment => ({
  riskTier: "trivial",
  behaviorChange: false,
  productChoiceOpen: false,
  needsPlan: false,
  note: null,
  refs: [],
  ...overrides,
});
const input = (overrides: Partial<ResolverInput> = {}): ResolverInput => ({
  intent: { objective: "change the checkout", scope: scope(), authorityRefs: [] },
  judgment: judgment(),
  constraints: [],
  ...overrides,
});
const data = (result: ReturnType<typeof resolvePolicy>) => {
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const rules = (result: ReturnType<typeof resolvePolicy>) =>
  data(result).requirements.map((item) => `${item.ruleId}@${item.before}`);
const judged = (raw: unknown, previous: Judgment | null = null) => {
  const result = normalizeJudgment(raw, previous);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data;
};

test("given --judge behavior=yes risk=normal, then requirements = {check:test, verdict:self} by default", () => {
  const raw = judgeTokens(["behavior=yes", "risk=normal"]);
  expect(rules(resolvePolicy(input({ judgment: judged(raw).judgment })))).toEqual([
    "check:test@close",
    "verdict:self@close",
  ]);
  // A workspace that requires independent verification (user config) needs a non-author verdict.
  expect(
    rules(resolvePolicy(input({ judgment: judged(raw).judgment, verification: "independent" }))),
  ).toEqual(["check:test@close", "verdict:non-author@close"]);
});

test("given a 2-line mechanical fix judged trivial, then zero requirements and no spec proposed", () => {
  const raw = judgeTokens(["risk=trivial", "behavior=no"]);
  expect(rules(resolvePolicy(input({ judgment: judged(raw).judgment })))).toEqual([]);
});

test("high risk needs a live verified verdict and a plan before writes", () => {
  expect(
    rules(resolvePolicy(input({ judgment: judgment({ riskTier: "high", behaviorChange: true }) }))),
  ).toEqual(["check:test@close", "verdict:verified@close", "plan@write"]);
});

test("an open product choice and a needed plan gate writes", () => {
  expect(
    rules(
      resolvePolicy(input({ judgment: judgment({ productChoiceOpen: true, needsPlan: true }) })),
    ),
  ).toEqual(["decision:product@write", "plan@write"]);
});

test("aliases map onto the four judgments; unknown keys are ignored, bad values are named", () => {
  const value = judged({
    risk: "Medium",
    behaviour: "y",
    open_product_choice: "no",
    "needs-plan": "docs/plans/x.md",
    reason: "why",
    extra: 1,
  });
  expect(value.judgment).toEqual({
    riskTier: "normal",
    behaviorChange: true,
    productChoiceOpen: false,
    needsPlan: true,
    note: "why",
    refs: [{ kind: "file", path: "docs/plans/x.md", digest: null }],
  });
  expect(value.ignored).toEqual(["extra"]);
  expect(normalizeJudgment({ risk: "sky-high" }, null)).toMatchObject({
    ok: false,
    code: "invalid_input",
    details: { fields: [{ path: "risk" }] },
  });
});

test("omitted judgments keep the previous ones and refs accumulate", () => {
  const previous = judgment({ riskTier: "high", needsPlan: true, refs: [] });
  const next = judged({ ref: "docs/plan.md" }, previous).judgment;
  expect(next).toMatchObject({ riskTier: "high", needsPlan: true });
  expect(next.refs).toEqual([{ kind: "file", path: "docs/plan.md", digest: null }]);
  expect(judged({ refs: ["https://x.test/p"] }, next).judgment.refs).toHaveLength(2);
});

test("an old-shape (≤6.x) assessment is accepted and mapped, never rejected for shape", () => {
  const legacy = assessment({
    signals: {
      ...assessment().signals,
      behaviorChange: { value: true, basis: "inferred", reason: "r", refs: [] },
      mechanicalLowRisk: { value: false, basis: "inferred", reason: "r", refs: [] },
      productChoiceOpen: { value: true, basis: "inferred", reason: "r", refs: [] },
      durableAgreementNeeded: { value: true, basis: "inferred", reason: "r", refs: [] },
    },
    consequences: [{ area: "security", fact: { statement: "auth", basis: "inferred", refs: [] } }],
  });
  for (const raw of [legacy, { assessment: legacy }]) {
    const value = judged(raw);
    expect(value.legacy).toBe(true);
    expect(value.judgment).toMatchObject({
      riskTier: "high",
      behaviorChange: true,
      productChoiceOpen: true,
      needsPlan: true,
    });
  }
  // Capped at normal unless the 6.x resolver itself demanded fresh review;
  // an unknown behavior signal keeps the previous judgment (else false).
  const unknownBehavior = assessment({
    signals: {
      ...assessment().signals,
      behaviorChange: { value: "unknown", basis: "unknown", reason: "?", refs: [] },
      mechanicalLowRisk: { value: false, basis: "inferred", reason: "r", refs: [] },
    },
    consequences: [
      { area: "data", fact: { statement: "no data migration", basis: "inferred", refs: [] } },
    ],
  });
  expect(judged(unknownBehavior).judgment).toMatchObject({
    riskTier: "normal",
    behaviorChange: false,
  });
  expect(judged(unknownBehavior, judgment({ behaviorChange: true })).judgment.behaviorChange).toBe(
    true,
  );
  // The fixture default (mechanical, unknowns elsewhere) maps to trivial.
  expect(judged(assessment()).judgment).toMatchObject({
    riskTier: "trivial",
    behaviorChange: false,
    productChoiceOpen: false,
  });
});

const constraint = (requires: Constraint["requires"]): Constraint => ({
  id: "repo-checks",
  kind: "project",
  statement: "project verification policy",
  source: ref(),
  acceptanceAllowed: false,
  requires,
});

test("project constraints always apply; distinct obligations stay distinct, duplicates dedupe", () => {
  const first = {
    kind: "check" as const,
    scope: scope(),
    refs: [ref({ url: "https://example.test/one" })],
    method: null,
    before: "close" as const,
    dependentAction: null,
  };
  const second = { ...first, refs: [ref({ url: "https://example.test/two" })] };
  const result = data(resolvePolicy(input({ constraints: [constraint([first, second, first])] })));
  expect(result.requirements).toHaveLength(2);
  expect(result.requirements.every((item) => item.ruleId.startsWith("project-constraint:"))).toBe(
    true,
  );
  expect(
    resolvePolicy(input({ constraints: [constraint([first]), constraint([second])] })),
  ).toMatchObject({ ok: false, code: "invalid_input" });
});

test("equal judgments replay to identical policy bytes", () => {
  expect(JSON.stringify(data(resolvePolicy(input())))).toBe(
    JSON.stringify(data(resolvePolicy(input()))),
  );
});

test("diffPolicy reports explicit additions and removals", () => {
  const previous = data(resolvePolicy(input({ judgment: judgment({ behaviorChange: true }) })));
  const next = data(resolvePolicy(input({ judgment: judgment({ needsPlan: true }) })));
  const change = diffPolicy(previous, next, "plan needed", "2026-09-04T00:00:00Z");
  expect(change?.recordedAt).toBe("2026-09-04T00:00:00Z");
  expect(String(change?.reason)).toContain("retired:");
  expect(String(change?.reason)).toContain("plan needed");
  expect(change?.added).toHaveLength(1);
  expect(change?.retired).toEqual(previous.requirements.map((item) => item.id));
  expect(diffPolicy(next, next, "same", "2026-09-04T00:00:00Z")).toBeNull();
  expect(() => diffPolicy(previous, { ...next, inputDigest: "bad" }, "invalid", "bad")).toThrow();
});
